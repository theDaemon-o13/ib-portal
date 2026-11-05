// Шаблоны писем, «Письмо из шаблона» и «Подпись ИБ» (1.9.0; docs/specs/awareness.md, раздел 17).
// Шаблон: название, темы и тексты RU и TJ с переменными {{…}} — тот же санитайзер и лимиты, что у письма; правка с
// version, архив вместо удаления, история — из audit_log. «Подпись ИБ» — одна строка awareness_fragments.
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, notFound, versionConflict } from '../../lib/errors.js';
import { readPortalParam } from '../settings/portal-params.js';
import type { Actor } from '../settings/common.js';
import { SIGNATURE_CODE } from './definition.js';
import * as letters from './letters.service.js';
import { runForNewLetter } from './letter-tasks.js';
import type { LetterKind } from './flow.js';
import { checkLetterSize, sanitizeLetterHtml, type LetterLimits } from './sanitize.js';
import { AWARENESS_LETTERS_KEY } from './settings.js';
import { checkTemplate, fillTemplate, SIGNATURE_BLOCK, type TemplateTexts, type TemplateVariable } from './variables.js';

export const TEMPLATE_ENTITY = 'awareness_template';
export const FRAGMENT_ENTITY = 'awareness_fragment';
export const TEMPLATE_LIST_LIMIT = 200;
/** Значение переменной в форме «Письмо из шаблона» — простой текст. */
export const VALUE_MAX = 1000;

const userBrief = { select: { id: true, fullName: true } } as const;
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function auditEntry(tx: Db, actor: Actor, entity: string, entityId: string, action: string, summary: string, extra: Record<string, unknown> = {}) {
  await tx.auditLog.create({
    data: {
      userId: actor.id, action, entity, entityId, ip: actor.ip,
      diff: { summary, actorRoles: [...actor.roleNames], ...extra } as Prisma.InputJsonValue,
    },
  });
}

/** Сведения о тексте для журнала: без HTML и изображений (они могут быть большими), с отпечатком для сравнения. */
const textTrace = (t: TemplateTexts) => ({
  subjectRu: t.subjectRu, subjectTj: t.subjectTj,
  htmlRu: { bytes: Buffer.byteLength(t.htmlRu, 'utf8'), sha256: sha(t.htmlRu) },
  htmlTj: { bytes: Buffer.byteLength(t.htmlTj, 'utf8'), sha256: sha(t.htmlTj) },
});

// ———————————————————————————————————————————————— шаблоны

function cleanTemplateTitle(raw: string): string {
  const t = oneLine(raw);
  if (!t) throw badRequest('TITLE_REQUIRED', 'Укажите название шаблона');
  if (t.length > letters.TITLE_MAX) throw badRequest('TITLE_TOO_LONG', `Название длиннее ${letters.TITLE_MAX} символов`);
  return t;
}

/**
 * Содержимое шаблона: темы — одна строка, тексты — санитайзер и лимиты письма. `{{подпись}}` остаётся переменной
 * (блоком станет в письме), переменные проверяет checkTemplate (400 BAD_TEMPLATE).
 */
async function cleanTemplateContent(db: Db, input: TemplateTexts, portalUrl?: string) {
  const ru = sanitizeLetterHtml(input.htmlRu, { portalUrl });
  const tj = sanitizeLetterHtml(input.htmlTj, { portalUrl });
  const subject = (s: string, lang: string) => {
    const v = oneLine(s);
    if (v.length > letters.SUBJECT_MAX) throw badRequest('SUBJECT_TOO_LONG', `Тема ${lang} длиннее ${letters.SUBJECT_MAX} символов`);
    return v;
  };
  const texts: TemplateTexts = { subjectRu: subject(input.subjectRu, 'RU'), subjectTj: subject(input.subjectTj, 'TJ'), htmlRu: ru.html, htmlTj: tj.html };
  const variables = checkTemplate(texts);
  const limits = await readPortalParam<LetterLimits>(db, AWARENESS_LETTERS_KEY);
  const size = checkLetterSize([ru.html, tj.html], [...ru.images, ...tj.images], limits);
  return { texts, variables, size, removed: [...new Set([...ru.removed, ...tj.removed])] };
}

const templateInclude = { creator: userBrief, updater: userBrief } as const;
type TemplateRow = Prisma.AwarenessTemplateGetPayload<{ include: typeof templateInclude }>;

const textsOf = (t: TemplateTexts): TemplateTexts => ({ subjectRu: t.subjectRu, subjectTj: t.subjectTj, htmlRu: t.htmlRu, htmlTj: t.htmlTj });

/** Переменные сохранённого шаблона. Шаблон прошёл checkTemplate при сохранении; сломанный — пустой список. */
function variablesOf(t: TemplateTexts): TemplateVariable[] {
  try {
    return checkTemplate(t);
  } catch {
    return [];
  }
}

function templateItem(t: TemplateRow, rules: number) {
  return {
    id: t.id,
    title: t.title,
    subjectRu: t.subjectRu,
    subjectTj: t.subjectTj,
    variables: variablesOf(t),
    archived: t.archivedAt !== null,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    /** Правил расписания с этим шаблоном (неархивных). */
    rules,
    createdBy: t.creator,
    createdAt: t.createdAt.toISOString(),
    updatedBy: t.updater,
    updatedAt: t.updatedAt.toISOString(),
    version: t.version,
  };
}

async function rulesCount(db: Db, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db.awarenessScheduleRule.groupBy({ by: ['templateId'], where: { templateId: { in: ids }, archivedAt: null }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.templateId ?? '', r._count._all]));
}

export async function listTemplates(db: Db, q: { scope: 'active' | 'archived' | 'all'; q?: string; limit: number; cursor?: string }) {
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const text = oneLine(q.q ?? '');
  const where: Prisma.AwarenessTemplateWhereInput = {
    ...(q.scope === 'active' ? { archivedAt: null } : q.scope === 'archived' ? { archivedAt: { not: null } } : {}),
    ...(text ? { title: { contains: text, mode: 'insensitive' } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.awarenessTemplate.findMany({ where, include: templateInclude, orderBy: [{ title: 'asc' }, { id: 'asc' }], skip: offset, take: q.limit + 1 }),
    db.awarenessTemplate.count({ where }),
  ]);
  const page = rows.slice(0, q.limit);
  const counts = await rulesCount(db, page.map((t) => t.id));
  return {
    items: page.map((t) => templateItem(t, counts.get(t.id) ?? 0)),
    nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
    total,
  };
}

export async function getTemplate(db: Db, id: string) {
  const t = await db.awarenessTemplate.findUnique({ where: { id }, include: templateInclude });
  if (!t) throw notFound('Шаблон');
  const counts = await rulesCount(db, [id]);
  const limits = await readPortalParam<LetterLimits>(db, AWARENESS_LETTERS_KEY);
  const bytes = Buffer.byteLength(t.htmlRu, 'utf8') + Buffer.byteLength(t.htmlTj, 'utf8');
  return { ...templateItem(t, counts.get(id) ?? 0), content: textsOf(t), size: { bytes, warn: bytes >= limits.warnLetterKb * 1024, limits } };
}
export type TemplateDetail = Awaited<ReturnType<typeof getTemplate>>;

export interface TemplateInput extends TemplateTexts {
  title: string;
}

export async function createTemplate(db: Db, actor: Actor, input: TemplateInput, portalUrl?: string) {
  const title = cleanTemplateTitle(input.title);
  const c = await cleanTemplateContent(db, input, portalUrl);
  const id = await withTx(db, async (tx) => {
    const t = await tx.awarenessTemplate.create({ data: { title, ...c.texts, createdBy: actor.id, updatedBy: actor.id } });
    await auditEntry(tx, actor, TEMPLATE_ENTITY, t.id, 'awareness_template.created', `Шаблон «${title}» создан`, {
      after: { title, ...textTrace(c.texts), variables: c.variables.map((v) => v.label) },
    });
    return t.id;
  });
  return { template: await getTemplate(db, id), removed: c.removed };
}

export async function updateTemplate(db: Db, actor: Actor, id: string, input: TemplateInput & { version: number }, portalUrl?: string) {
  const t = await db.awarenessTemplate.findUnique({ where: { id } });
  if (!t) throw notFound('Шаблон');
  if (t.archivedAt) throw new AppError(409, 'TEMPLATE_ARCHIVED', 'Шаблон в архиве. Верните его из архива, чтобы изменить');
  const title = cleanTemplateTitle(input.title);
  const c = await cleanTemplateContent(db, input, portalUrl);
  const before = textsOf(t);
  const same = title === t.title && JSON.stringify(c.texts) === JSON.stringify(before);
  if (t.version !== input.version) throw versionConflict();
  if (same) return { template: await getTemplate(db, id), removed: c.removed };
  await withTx(db, async (tx) => {
    const { count } = await tx.awarenessTemplate.updateMany({
      where: { id, version: input.version }, data: { title, ...c.texts, updatedBy: actor.id, version: { increment: 1 } },
    });
    if (!count) throw versionConflict();
    await auditEntry(tx, actor, TEMPLATE_ENTITY, id, 'awareness_template.updated', `Шаблон «${title}» изменён`, {
      before: { title: t.title, ...textTrace(before) },
      after: { title, ...textTrace(c.texts), variables: c.variables.map((v) => v.label) },
    });
  });
  return { template: await getTemplate(db, id), removed: c.removed };
}

/** В архив и обратно. Правила с архивным шаблоном создают задачи без черновика (раздел 19.5). */
export async function archiveTemplate(db: Db, actor: Actor, id: string, input: { version: number; archived: boolean }) {
  const t = await db.awarenessTemplate.findUnique({ where: { id } });
  if (!t) throw notFound('Шаблон');
  if ((t.archivedAt !== null) === input.archived) throw new AppError(409, 'TEMPLATE_STATE', input.archived ? 'Шаблон уже в архиве' : 'Шаблон не в архиве');
  await withTx(db, async (tx) => {
    const { count } = await tx.awarenessTemplate.updateMany({
      where: { id, version: input.version }, data: { archivedAt: input.archived ? new Date() : null, updatedBy: actor.id, version: { increment: 1 } },
    });
    if (!count) throw versionConflict();
    const rules = await tx.awarenessScheduleRule.count({ where: { templateId: id, archivedAt: null } });
    await auditEntry(tx, actor, TEMPLATE_ENTITY, id, input.archived ? 'awareness_template.archived' : 'awareness_template.unarchived',
      `Шаблон «${t.title}» ${input.archived ? 'отправлен в архив' : 'возвращён из архива'}`, input.archived && rules ? { rules } : {});
  });
  return getTemplate(db, id);
}

// ———————————————————————————————————————————————— «Письмо из шаблона»

export interface FromTemplateInput {
  title: string;
  kind: LetterKind;
  reason?: string;
  /** Значения переменных: ключ — имя переменной (в любом регистре), значение — простой текст. */
  values: Record<string, string>;
}

/**
 * Черновик из шаблона (версия template, template_id). Пустая переменная — 400 UNFILLED_VARIABLES со списком,
 * черновик не создаётся. Значения экранируются, `{{подпись}}` — блок «Подпись ИБ»; затем санитайзер и лимиты письма.
 */
export async function letterFromTemplate(db: Db, actor: Actor, templateId: string, input: FromTemplateInput, deps: letters.LetterDeps = {}, link?: letters.TaskLink) {
  const t = await db.awarenessTemplate.findUnique({ where: { id: templateId } });
  if (!t) throw notFound('Шаблон');
  if (t.archivedAt) throw new AppError(409, 'TEMPLATE_ARCHIVED', `Шаблон «${t.title}» в архиве — выберите другой или верните его из архива`);
  const long = Object.entries(input.values).find(([, v]) => v.length > VALUE_MAX);
  if (long) throw badRequest('VALUE_TOO_LONG', `Значение «${long[0]}» длиннее ${VALUE_MAX} символов`);
  const head = letters.cleanLetterHead(input);
  const values = Object.fromEntries(Object.entries(input.values).map(([k, v]) => [k, oneLine(v)]));
  const filled = fillTemplate(textsOf(t), values);
  const content = await letters.cleanContent(db, filled, deps);
  const id = await withTx(db, async (tx) => {
    if (link) await runForNewLetter(tx, link.taskId);
    const l = await letters.insertLetter(tx, actor, { ...head, templateId }, content.texts, 'template');
    const linked = await letters.linkNewLetterToTask(tx, link, l);
    await letters.auditLetter(tx, actor, l, 'created', `создано из шаблона «${t.title}»${linked ? ` по задаче #${linked.taskNumber}` : ''}`, { after: head, templateId, templateVersion: t.version });
    return l.id;
  });
  return { letter: await letters.getLetter(db, actor.id, id), versionCreated: true, removed: content.removed };
}

// ———————————————————————————————————————————————— «Подпись ИБ»

export async function getSignature(db: Db, perms: ReadonlySet<string>) {
  const f = await db.awarenessFragment.findUnique({ where: { code: SIGNATURE_CODE }, include: { updater: userBrief } });
  return {
    htmlRu: f?.htmlRu ?? '',
    htmlTj: f?.htmlTj ?? '',
    version: f?.version ?? 0,
    updatedBy: f?.updater ?? null,
    updatedAt: f?.updatedAt.toISOString() ?? null,
    /** Править — settings.manage и ib.work (маршрут). */
    canEdit: perms.has('settings.manage') && perms.has('ib.work'),
  };
}

/**
 * Правка «Подписи ИБ»: санитайзер (без вложенного блока подписи и переменных), лимиты письма, version.
 * Незамороженные письма показывают новую подпись сразу; замороженные хранят текст версии sent.
 */
export async function updateSignature(db: Db, actor: Actor & { perms: ReadonlySet<string> }, input: { htmlRu: string; htmlTj: string; version: number }, portalUrl?: string) {
  const clean = (html: string) => {
    const r = sanitizeLetterHtml(html.split(SIGNATURE_BLOCK).join(''), { portalUrl });
    return { ...r, html: r.html.replace(/<div data-ib-fragment="signature">([\s\S]*?)<\/div>/g, '<div>$1</div>') };
  };
  const ru = clean(input.htmlRu);
  const tj = clean(input.htmlTj);
  if (/\{\{[^{}]*\}\}/.test(ru.html + tj.html)) throw badRequest('SIGNATURE_VARIABLES', 'В подписи не бывает переменных {{…}} — напишите текст');
  const limits = await readPortalParam<LetterLimits>(db, AWARENESS_LETTERS_KEY);
  checkLetterSize([ru.html, tj.html], [...ru.images, ...tj.images], limits);
  const f = await db.awarenessFragment.findUnique({ where: { code: SIGNATURE_CODE } });
  await withTx(db, async (tx) => {
    if (!f) {
      if (input.version !== 0) throw versionConflict();
      await tx.awarenessFragment.create({ data: { code: SIGNATURE_CODE, htmlRu: ru.html, htmlTj: tj.html, updatedBy: actor.id } });
    } else {
      if (f.version !== input.version) throw versionConflict();
      if (f.htmlRu === ru.html && f.htmlTj === tj.html) return;
      const { count } = await tx.awarenessFragment.updateMany({
        where: { code: SIGNATURE_CODE, version: input.version }, data: { htmlRu: ru.html, htmlTj: tj.html, updatedBy: actor.id, version: { increment: 1 } },
      });
      if (!count) throw versionConflict();
    }
    await auditEntry(tx, actor, FRAGMENT_ENTITY, SIGNATURE_CODE, 'awareness_fragment.updated', '«Подпись ИБ» изменена', {
      ...(f ? { before: textTrace({ subjectRu: '', subjectTj: '', htmlRu: f.htmlRu, htmlTj: f.htmlTj }) } : {}),
      after: textTrace({ subjectRu: '', subjectTj: '', htmlRu: ru.html, htmlTj: tj.html }),
    });
  });
  return { signature: await getSignature(db, actor.perms), removed: [...new Set([...ru.removed, ...tj.removed])] };
}
