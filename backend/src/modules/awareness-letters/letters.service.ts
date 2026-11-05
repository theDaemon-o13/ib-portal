// Учебные письма: создание, сохранение с версиями, переходы, заморозка, копия, архив (1.9.0, ADR-0039;
// docs/specs/awareness.md, разделы 13–15). Решения «можно ли» — в flow.ts (без БД), здесь — чтение, запись и журнал.
// Каждое действие — одна транзакция: письмо (с проверкой version), версия, событие и строка audit_log.
// Шаг 4 плана: запись «Рассылок» при отметке (шаг 8) и задача доработки при возврате (шаг 7) подключаются позже —
// event.recordId и event.taskId пока пустые.
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, notFound, versionConflict } from '../../lib/errors.js';
import { todayIso } from '../../lib/today.js';
import { readPortalParam } from '../settings/portal-params.js';
import type { Actor } from '../settings/common.js';
import { SIGNATURE_CODE } from './definition.js';
import { substituteSignature, type ExportLang } from './export/html.js';
import * as flow from './flow.js';
import { checkLetterSize, sanitizeLetterHtml, type LetterImage, type LetterLimits } from './sanitize.js';
import { AWARENESS_LETTERS_KEY } from './settings.js';
import { hasSignatureInSubject, signatureToBlock, unfilledInLetter, type TemplateTexts } from './variables.js';

export const LETTER_ENTITY = 'awareness_letter';
export const TITLE_MAX = 200;
export const SUBJECT_MAX = 300;
export const REASON_MAX = 1000;
export const LETTER_LIST_LIMIT = 200;

export type VersionReason = 'created' | 'edit' | 'restore' | 'template' | 'copy' | 'sent';
export type EventAction = 'submitted' | 'withdrawn' | 'approved' | 'returned' | 'approval_dropped' | 'sent' | 'archived' | 'unarchived';

/** Кнопки карточки для текущего пользователя. Решает всё равно backend при действии. */
export type LetterAction =
  | 'save' | 'submit' | 'withdraw' | 'approve' | 'return' | 'send' | 'send_without_approval' | 'resend'
  | 'restore' | 'copy' | 'archive' | 'unarchive';

export interface LetterDeps {
  /** Адрес портала (PORTAL_URL): ссылки на него в письме — 400 PORTAL_LINK. */
  portalUrl?: string;
  now?: () => Date;
}

const userBrief = { select: { id: true, fullName: true } } as const;

// ———————————————————————————————————————————————— вспомогательное

const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();

function cleanTitle(raw: string): string {
  const t = oneLine(raw);
  if (!t) throw badRequest('TITLE_REQUIRED', 'Укажите название письма');
  if (t.length > TITLE_MAX) throw badRequest('TITLE_TOO_LONG', `Название длиннее ${TITLE_MAX} символов`);
  return t;
}

function cleanReason(kind: flow.LetterKind, raw: string): string {
  const r = raw.trim();
  if (r.length > REASON_MAX) throw badRequest('REASON_TOO_LONG', `Повод длиннее ${REASON_MAX} символов`);
  if (kind === 'urgent' && !r) throw badRequest('REASON_REQUIRED', 'Укажите повод срочной рассылки: инцидент, новая схема мошенничества, предупреждение регулятора');
  return r;
}

function cleanSubject(raw: string, lang: 'RU' | 'TJ'): string {
  const s = oneLine(raw);
  if (s.length > SUBJECT_MAX) throw badRequest('SUBJECT_TOO_LONG', `Тема ${lang} длиннее ${SUBJECT_MAX} символов`);
  return s;
}

export interface CleanContent {
  texts: TemplateTexts;
  /** Что санитайзер вырезал — показать пользователю. */
  removed: string[];
  size: { bytes: number; warn: boolean };
}

/** Тема — одна строка до 300 символов, без `{{подпись}}`; текст — через санитайзер; размер — по лимитам «Параметров портала». */
export async function cleanContent(db: Db, input: TemplateTexts, deps: LetterDeps): Promise<CleanContent> {
  if ([input.subjectRu, input.subjectTj].some(hasSignatureInSubject)) throw badRequest('SIGNATURE_IN_SUBJECT', 'Подпись ИБ не ставится в тему письма');
  // `{{подпись}}`, набранная вручную, — блок «Подпись ИБ», как в письме из шаблона: её подставляет система.
  const ru = sanitizeLetterHtml(signatureToBlock(input.htmlRu), { portalUrl: deps.portalUrl });
  const tj = sanitizeLetterHtml(signatureToBlock(input.htmlTj), { portalUrl: deps.portalUrl });
  const images: LetterImage[] = [...ru.images, ...tj.images];
  const limits = await readPortalParam<LetterLimits>(db, AWARENESS_LETTERS_KEY);
  const size = checkLetterSize([ru.html, tj.html], images, limits);
  return {
    texts: { subjectRu: cleanSubject(input.subjectRu, 'RU'), subjectTj: cleanSubject(input.subjectTj, 'TJ'), htmlRu: ru.html, htmlTj: tj.html },
    removed: [...new Set([...ru.removed, ...tj.removed])],
    size,
  };
}

const sameTexts = (a: TemplateTexts, b: TemplateTexts) =>
  a.subjectRu === b.subjectRu && a.subjectTj === b.subjectTj && a.htmlRu === b.htmlRu && a.htmlTj === b.htmlTj;

const textsOf = (v: TemplateTexts): TemplateTexts => ({ subjectRu: v.subjectRu, subjectTj: v.subjectTj, htmlRu: v.htmlRu, htmlTj: v.htmlTj });

const sizeOf = (t: TemplateTexts) => Buffer.byteLength(t.htmlRu, 'utf8') + Buffer.byteLength(t.htmlTj, 'utf8');

/** Языки, которые можно выгрузить: язык с темой или текстом (у черновика может быть половина языка). */
export function exportLangs(t: TemplateTexts): ExportLang[] {
  const ru = flow.langFill(t.subjectRu, t.htmlRu) !== 'empty';
  const tj = flow.langFill(t.subjectTj, t.htmlTj) !== 'empty';
  return [...(ru ? ['ru' as const] : []), ...(tj ? ['tj' as const] : []), ...(ru && tj ? ['both' as const] : [])];
}

/** Пометка «только RU» / «только TJ» — у срочного письма с одним заполненным языком. */
export function langMarkOf(kind: flow.LetterKind, t: TemplateTexts): flow.LangMark {
  if (kind !== 'urgent') return null;
  const ru = flow.langFill(t.subjectRu, t.htmlRu);
  const tj = flow.langFill(t.subjectTj, t.htmlTj);
  if (ru === 'full' && tj === 'empty') return 'only_ru';
  if (tj === 'full' && ru === 'empty') return 'only_tj';
  return null;
}

async function isIbHead(db: Db, userId: string): Promise<boolean> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { isActive: true, isIbHead: true } });
  return u?.isActive === true && u.isIbHead;
}

export async function auditLetter(tx: Db, actor: Actor, letter: { id: string; number: number }, action: string, summary: string, extra: Record<string, unknown> = {}) {
  await tx.auditLog.create({
    data: {
      userId: actor.id, action: `${LETTER_ENTITY}.${action}`, entity: LETTER_ENTITY, entityId: letter.id, ip: actor.ip,
      diff: { summary: `Письмо № ${letter.number}: ${summary}`, actorRoles: [...actor.roleNames], ...extra } as Prisma.InputJsonValue,
    },
  });
}

// ———————————————————————————————————————————————— загрузка и состояние

const letterInclude = {
  currentVersion: true,
  creator: userBrief,
  template: { select: { id: true, title: true } },
  task: { select: { id: true, number: true, title: true, deletedAt: true } },
} as const;
type LetterRow = Prisma.AwarenessLetterGetPayload<{ include: typeof letterInclude }>;

async function loadLetter(db: Db, id: string): Promise<LetterRow> {
  const l = await db.awarenessLetter.findUnique({ where: { id }, include: letterInclude });
  if (!l) throw notFound('Письмо');
  return l;
}

async function stateOf(db: Db, l: LetterRow): Promise<flow.LetterState> {
  const submitted = l.status === 'review'
    ? await db.awarenessLetterEvent.findFirst({ where: { letterId: l.id, action: 'submitted' }, orderBy: { at: 'desc' }, select: { actorId: true } })
    : null;
  return {
    status: l.status as flow.LetterStatus,
    kind: l.kind as flow.LetterKind,
    frozen: l.frozen,
    archived: l.archivedAt !== null,
    createdBy: l.createdBy,
    submittedBy: submitted?.actorId ?? null,
    latestIsApproved: l.approvedVersionId !== null && l.approvedVersionId === l.currentVersionId,
  };
}

function currentTexts(l: LetterRow): TemplateTexts {
  if (!l.currentVersion) throw new AppError(500, 'LETTER_BROKEN', `У письма № ${l.number} нет версии`);
  return textsOf(l.currentVersion);
}

/**
 * Занять письмо: version совпала — увеличить её (остальные изменения — следующими запросами той же транзакции).
 * Не совпала — 409 VERSION_CONFLICT. У замороженного письма триггер разрешает менять version.
 */
async function claim(tx: Db, l: { id: string; version: number }, version: number, data: Prisma.AwarenessLetterUncheckedUpdateManyInput = {}): Promise<void> {
  if (l.version !== version) throw versionConflict();
  const { count } = await tx.awarenessLetter.updateMany({ where: { id: l.id, version }, data: { ...data, version: { increment: 1 } } });
  if (!count) throw versionConflict();
}

async function addVersion(tx: Db, letterId: string, actorId: string, reason: VersionReason, t: TemplateTexts, restoredFrom?: number) {
  const last = await tx.awarenessLetterVersion.findFirst({ where: { letterId }, orderBy: { no: 'desc' }, select: { no: true } });
  return tx.awarenessLetterVersion.create({
    data: { letterId, no: (last?.no ?? 0) + 1, reason, restoredFrom: restoredFrom ?? null, createdBy: actorId, ...t },
  });
}

async function addEvent(tx: Db, letterId: string, actorId: string, action: EventAction, data: Partial<Prisma.AwarenessLetterEventUncheckedCreateInput> = {}) {
  return tx.awarenessLetterEvent.create({ data: { letterId, actorId, action, ...data } });
}

// ———————————————————————————————————————————————— DTO

function actionsFor(s: flow.LetterState, actor: flow.LetterActor): LetterAction[] {
  const out: LetterAction[] = [];
  if (s.archived) return ['copy', 'unarchive'];
  if (s.frozen) return ['resend', 'copy', 'archive'];
  if (s.status === 'draft' || s.status === 'approved') out.push('save', 'restore');
  if (s.status === 'draft') out.push('submit');
  if (s.status === 'review') {
    if (actor.id === s.submittedBy || actor.id === s.createdBy) out.push('withdraw');
    if (actor.isIbHead) out.push('approve', 'return');
  }
  if (s.status === 'approved' && s.latestIsApproved) out.push('send');
  if (s.kind === 'urgent' && (s.status === 'draft' || s.status === 'review')) out.push('send_without_approval');
  out.push('copy', 'archive');
  return out;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const isoDate = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

function listItem(l: Omit<LetterRow, 'currentVersion'>, extra: { versionNo: number | null; langMark: flow.LangMark }) {
  return {
    id: l.id,
    number: l.number,
    title: l.title,
    kind: l.kind as flow.LetterKind,
    reason: l.reason,
    status: l.status as flow.LetterStatus,
    frozen: l.frozen,
    archived: l.archivedAt !== null,
    archivedAt: iso(l.archivedAt),
    langMark: extra.langMark,
    versionNo: extra.versionNo,
    template: l.template,
    task: l.task && !l.task.deletedAt ? { id: l.task.id, number: l.task.number, title: l.task.title } : null,
    createdBy: l.creator,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
    version: l.version,
  };
}

export async function getLetter(db: Db, actorId: string, id: string) {
  const l = await loadLetter(db, id);
  const [s, head, versions, events] = await Promise.all([
    stateOf(db, l),
    isIbHead(db, actorId),
    db.awarenessLetterVersion.findMany({
      where: { letterId: id }, orderBy: { no: 'desc' },
      select: { id: true, no: true, reason: true, restoredFrom: true, createdAt: true, creator: userBrief },
    }),
    db.awarenessLetterEvent.findMany({
      where: { letterId: id }, orderBy: [{ at: 'desc' }, { id: 'desc' }],
      include: { actor: userBrief, version: { select: { no: true } }, task: { select: { id: true, number: true } }, record: { select: { id: true, number: true, registerId: true } } },
    }),
  ]);
  const t = currentTexts(l);
  const noOf = (vid: string | null) => versions.find((v) => v.id === vid)?.no ?? null;
  const limits = await readPortalParam<LetterLimits>(db, AWARENESS_LETTERS_KEY);
  const bytes = sizeOf(t);
  return {
    ...listItem(l, { versionNo: l.currentVersion?.no ?? null, langMark: langMarkOf(l.kind as flow.LetterKind, t) }),
    content: t,
    /** Языки экспорта текущей версии (у срочного с одним языком — только он). */
    exportLangs: exportLangs(t),
    size: { bytes, warn: bytes >= limits.warnLetterKb * 1024, limits },
    approvedVersionNo: noOf(l.approvedVersionId),
    sentVersionNo: noOf(l.sentVersionId),
    latestIsApproved: s.latestIsApproved,
    selfApproved: s.latestIsApproved
      ? (await db.awarenessLetterEvent.findFirst({ where: { letterId: id, action: 'approved', versionId: l.approvedVersionId }, orderBy: { at: 'desc' }, select: { selfApproved: true } }))?.selfApproved ?? false
      : false,
    sentWithoutApproval: events.some((e) => e.action === 'sent' && e.withoutApproval),
    versions: versions.map((v) => ({
      no: v.no, reason: v.reason as VersionReason, restoredFrom: v.restoredFrom, createdBy: v.creator, createdAt: v.createdAt.toISOString(),
    })),
    events: events.map((e) => ({
      id: e.id,
      action: e.action as EventAction,
      at: e.at.toISOString(),
      actor: e.actor,
      versionNo: e.version?.no ?? null,
      comment: e.comment,
      selfApproved: e.selfApproved,
      withoutApproval: e.withoutApproval,
      sentOn: isoDate(e.sentOn),
      audience: e.audience,
      task: e.task,
      record: e.record,
    })),
    actions: actionsFor(s, { id: actorId, isIbHead: head }),
  };
}
export type LetterDetail = Awaited<ReturnType<typeof getLetter>>;

export interface LetterListQuery {
  scope: 'active' | 'archived' | 'all';
  status?: flow.LetterStatus;
  kind?: flow.LetterKind;
  q?: string;
  limit: number;
  cursor?: string;
}

/** Список: новые сверху. Пометка языка — по текущей версии без содержимого изображений (data: вырезается в SQL). */
export async function listLetters(db: Db, q: LetterListQuery) {
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const text = (q.q ?? '').trim().replace(/\s+/g, ' ');
  const num = /^(№\s*)?#?\d+$/.test(text) ? Number(text.replace(/\D/g, '')) : null;
  const where: Prisma.AwarenessLetterWhereInput = {
    ...(q.scope === 'active' ? { archivedAt: null } : q.scope === 'archived' ? { archivedAt: { not: null } } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
    ...(text ? { OR: [{ title: { contains: text, mode: 'insensitive' } }, ...(num !== null && num <= 2_147_483_647 ? [{ number: num }] : [])] } : {}),
  };
  const include = { creator: letterInclude.creator, template: letterInclude.template, task: letterInclude.task };
  const [rows, total] = await Promise.all([
    db.awarenessLetter.findMany({ where, include, orderBy: [{ number: 'desc' }], skip: offset, take: q.limit + 1 }),
    db.awarenessLetter.count({ where }),
  ]);
  const page = rows.slice(0, q.limit);
  const ids = page.map((l) => l.currentVersionId).filter((v): v is string => v !== null);
  const light = ids.length
    ? await db.$queryRaw<{ id: string; no: number; subject_ru: string; subject_tj: string; html_ru: string; html_tj: string }[]>`
        SELECT id::text, no, subject_ru, subject_tj,
               regexp_replace(html_ru, 'data:[^"'' >]*', '', 'g') AS html_ru,
               regexp_replace(html_tj, 'data:[^"'' >]*', '', 'g') AS html_tj
        FROM awareness_letter_versions WHERE id = ANY(${ids}::uuid[])`
    : [];
  const byId = new Map(light.map((v) => [v.id, v]));
  return {
    items: page.map((l) => {
      const v = l.currentVersionId ? byId.get(l.currentVersionId) : undefined;
      const langMark = v ? langMarkOf(l.kind as flow.LetterKind, { subjectRu: v.subject_ru, subjectTj: v.subject_tj, htmlRu: v.html_ru, htmlTj: v.html_tj }) : null;
      return listItem(l, { versionNo: v ? Number(v.no) : null, langMark });
    }),
    nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
    total,
  };
}

export async function getVersion(db: Db, id: string, no: number) {
  const v = await db.awarenessLetterVersion.findUnique({ where: { letterId_no: { letterId: id, no } }, include: { creator: userBrief } });
  if (!v) throw notFound('Версия письма');
  return {
    no: v.no, reason: v.reason as VersionReason, restoredFrom: v.restoredFrom, createdBy: v.creator, createdAt: v.createdAt.toISOString(),
    content: textsOf(v),
  };
}

// ———————————————————————————————————————————————— создание и сохранение

export type LetterContentInput = TemplateTexts;

export interface CreateLetterInput extends Partial<LetterContentInput> {
  title: string;
  kind: flow.LetterKind;
  reason?: string;
}

export interface SaveResult {
  letter: LetterDetail;
  /** Создана ли новая версия (сохранение без изменений версию не создаёт). */
  versionCreated: boolean;
  removed: string[];
}

/**
 * Вставить письмо с первой версией (в транзакции действия). Содержимое уже прошло cleanContent.
 * Общая для «Новое письмо», «Письмо из шаблона», копии и черновика из расписания (шаг 7).
 */
export async function insertLetter(
  tx: Db, actor: Actor,
  letter: { title: string; kind: flow.LetterKind; reason: string; templateId?: string | null; taskId?: string | null },
  texts: TemplateTexts, versionReason: Extract<VersionReason, 'created' | 'template' | 'copy'>,
): Promise<{ id: string; number: number; versionNo: number }> {
  const row = await tx.awarenessLetter.create({
    data: { title: letter.title, kind: letter.kind, reason: letter.reason, templateId: letter.templateId ?? null, taskId: letter.taskId ?? null, createdBy: actor.id },
  });
  const v = await addVersion(tx, row.id, actor.id, versionReason, texts);
  await tx.awarenessLetter.update({ where: { id: row.id }, data: { currentVersionId: v.id } });
  return { id: row.id, number: row.number, versionNo: v.no };
}

/** Проверить название, тип и повод нового письма. */
export function cleanLetterHead(input: { title: string; kind: flow.LetterKind; reason?: string }) {
  return { title: cleanTitle(input.title), kind: input.kind, reason: cleanReason(input.kind, input.reason ?? '') };
}

/** Новое письмо — черновик с версией 1 (created). */
export async function createLetter(db: Db, actor: Actor, input: CreateLetterInput, deps: LetterDeps = {}): Promise<SaveResult> {
  const head = cleanLetterHead(input);
  const content = await cleanContent(db, {
    subjectRu: input.subjectRu ?? '', subjectTj: input.subjectTj ?? '', htmlRu: input.htmlRu ?? '', htmlTj: input.htmlTj ?? '',
  }, deps);
  const id = await withTx(db, async (tx) => {
    const l = await insertLetter(tx, actor, head, content.texts, 'created');
    await auditLetter(tx, actor, l, 'created', `создано «${head.title}» (${head.kind === 'urgent' ? 'срочное' : 'плановое'})`, { after: head });
    return l.id;
  });
  return { letter: await getLetter(db, actor.id, id), versionCreated: true, removed: content.removed };
}

export interface SaveLetterInput extends LetterContentInput {
  version: number;
  title?: string;
  kind?: flow.LetterKind;
  reason?: string;
  /** «Утверждение будет снято» подтверждено. */
  confirmDropApproval?: boolean;
}

/**
 * Сохранить: новая версия (edit), если изменились тема или текст; название, тип и повод — у письма.
 * Утверждённое письмо при изменении содержимого, типа или повода возвращается в черновик (approval_dropped) —
 * только с подтверждением, иначе 409 APPROVAL_DROP_CONFIRM. Название в письмо не входит и утверждение не снимает.
 */
export async function saveLetter(db: Db, actor: Actor, id: string, input: SaveLetterInput, deps: LetterDeps = {}): Promise<SaveResult> {
  const l = await loadLetter(db, id);
  const s = await stateOf(db, l);
  const kind = input.kind ?? (l.kind as flow.LetterKind);
  const title = input.title === undefined ? l.title : cleanTitle(input.title);
  const reason = input.reason === undefined ? l.reason : input.reason.trim();
  const content = await cleanContent(db, input, deps);
  const contentChanged = !sameTexts(content.texts, currentTexts(l));
  const letterChanged = kind !== l.kind || reason !== l.reason;
  if (!contentChanged && !letterChanged && title === l.title) {
    if (l.version !== input.version) throw versionConflict();
    // Ничего не изменилось — но архивное и замороженное письмо всё равно не «сохраняется».
    flow.assertEditable(s, true);
    return { letter: await getLetter(db, actor.id, id), versionCreated: false, removed: content.removed };
  }
  const drops = contentChanged || letterChanged;
  const { dropsApproval } = flow.assertEditable(s, input.confirmDropApproval === true || !drops);
  cleanReason(kind, reason);

  await withTx(db, async (tx) => {
    await claim(tx, l, input.version);
    const v = contentChanged ? await addVersion(tx, id, actor.id, 'edit', content.texts) : null;
    const dropping = dropsApproval && drops;
    await tx.awarenessLetter.update({
      where: { id },
      data: {
        title, kind, reason,
        ...(v ? { currentVersionId: v.id } : {}),
        ...(dropping ? { status: 'draft', approvedVersionId: null } : {}),
      },
    });
    if (dropping) await addEvent(tx, id, actor.id, 'approval_dropped', { versionId: l.approvedVersionId });
    const changes: string[] = [];
    if (v) changes.push(`версия ${v.no}`);
    if (title !== l.title) changes.push('название');
    if (kind !== l.kind) changes.push(kind === 'urgent' ? 'тип → срочное' : 'тип → плановое');
    if (reason !== l.reason) changes.push('повод');
    if (dropping) changes.push('утверждение снято');
    await auditLetter(tx, actor, l, 'updated', `сохранено: ${changes.join(', ')}`, {
      versionNo: v?.no ?? null,
      approvalDropped: dropping,
      before: { title: l.title, kind: l.kind, reason: l.reason },
      after: { title, kind, reason },
    });
  });
  return { letter: await getLetter(db, actor.id, id), versionCreated: contentChanged, removed: content.removed };
}

/** «Восстановить версию N»: новая версия с содержимым N (restore). В утверждённом — с подтверждением снятия утверждения. */
export async function restoreVersion(db: Db, actor: Actor, id: string, input: { version: number; no: number; confirmDropApproval?: boolean }) {
  const l = await loadLetter(db, id);
  const s = await stateOf(db, l);
  const { dropsApproval } = flow.assertEditable(s, input.confirmDropApproval === true);
  const src = await db.awarenessLetterVersion.findUnique({ where: { letterId_no: { letterId: id, no: input.no } } });
  if (!src) throw notFound('Версия письма');
  if (src.reason === 'sent') throw badRequest('VERSION_SENT', 'Версия отправки не восстанавливается');
  if (src.id === l.currentVersionId) throw new AppError(409, 'VERSION_IS_CURRENT', `Версия ${input.no} — текущая`);
  await withTx(db, async (tx) => {
    await claim(tx, l, input.version);
    const v = await addVersion(tx, id, actor.id, 'restore', textsOf(src), src.no);
    await tx.awarenessLetter.update({
      where: { id },
      data: { currentVersionId: v.id, ...(dropsApproval ? { status: 'draft', approvedVersionId: null } : {}) },
    });
    if (dropsApproval) await addEvent(tx, id, actor.id, 'approval_dropped', { versionId: l.approvedVersionId });
    await auditLetter(tx, actor, l, 'version_restored', `версия ${v.no} восстановлена из версии ${src.no}${dropsApproval ? ', утверждение снято' : ''}`, {
      versionNo: v.no, restoredFrom: src.no, approvalDropped: dropsApproval,
    });
  });
  return getLetter(db, actor.id, id);
}

// ———————————————————————————————————————————————— согласование

export async function submitLetter(db: Db, actor: Actor, id: string, input: { version: number }) {
  const l = await loadLetter(db, id);
  const t = currentTexts(l);
  const { langMark } = flow.submit(await stateOf(db, l), t, unfilledInLetter(t));
  await withTx(db, async (tx) => {
    await claim(tx, l, input.version, { status: 'review' });
    await addEvent(tx, id, actor.id, 'submitted', { versionId: l.currentVersionId });
    await auditLetter(tx, actor, l, 'submitted', `отправлено на согласование (версия ${l.currentVersion?.no})`, { versionNo: l.currentVersion?.no, langMark });
  });
  return getLetter(db, actor.id, id);
}

export async function withdrawLetter(db: Db, actor: Actor, id: string, input: { version: number }) {
  const l = await loadLetter(db, id);
  flow.withdraw(await stateOf(db, l), { id: actor.id, isIbHead: await isIbHead(db, actor.id) });
  await withTx(db, async (tx) => {
    await claim(tx, l, input.version, { status: 'draft' });
    await addEvent(tx, id, actor.id, 'withdrawn', { versionId: l.currentVersionId });
    await auditLetter(tx, actor, l, 'withdrawn', 'отозвано с согласования');
  });
  return getLetter(db, actor.id, id);
}

export async function approveLetter(db: Db, actor: Actor, id: string, input: { version: number; comment?: string }) {
  const l = await loadLetter(db, id);
  const { selfApproved } = flow.approve(await stateOf(db, l), { id: actor.id, isIbHead: await isIbHead(db, actor.id) });
  const comment = (input.comment ?? '').trim();
  if (comment.length > flow.COMMENT_MAX) throw badRequest('COMMENT_TOO_LONG', `Комментарий длиннее ${flow.COMMENT_MAX} символов`);
  await withTx(db, async (tx) => {
    await claim(tx, l, input.version, { status: 'approved', approvedVersionId: l.currentVersionId });
    await addEvent(tx, id, actor.id, 'approved', { versionId: l.currentVersionId, selfApproved, comment });
    await auditLetter(tx, actor, l, 'approved', `утверждено (версия ${l.currentVersion?.no})${selfApproved ? ' — без независимого согласования' : ''}`, {
      versionNo: l.currentVersion?.no, selfApproved,
    });
  });
  return getLetter(db, actor.id, id);
}

/** Вернуть на доработку. Задача автору (раздел 19.6) — шаг 7 плана. */
export async function returnLetter(db: Db, actor: Actor, id: string, input: { version: number; comment: string }) {
  const l = await loadLetter(db, id);
  const { comment } = flow.returnForRework(await stateOf(db, l), { id: actor.id, isIbHead: await isIbHead(db, actor.id) }, input.comment);
  await withTx(db, async (tx) => {
    await claim(tx, l, input.version, { status: 'draft' });
    await addEvent(tx, id, actor.id, 'returned', { versionId: l.currentVersionId, comment });
    await auditLetter(tx, actor, l, 'returned', 'возвращено на доработку', { versionNo: l.currentVersion?.no, comment });
  });
  return getLetter(db, actor.id, id);
}

// ———————————————————————————————————————————————— отправка и заморозка

/** Текущая «Подпись ИБ»; строки нет — пустая (seed её создаёт, check-integrity проверяет). */
export async function currentSignature(db: Db): Promise<{ htmlRu: string; htmlTj: string }> {
  const f = await db.awarenessFragment.findUnique({ where: { code: SIGNATURE_CODE }, select: { htmlRu: true, htmlTj: true } });
  return f ?? { htmlRu: '', htmlTj: '' };
}

export interface SendLetterInput extends flow.SendInput {
  version: number;
}

/**
 * «Отметить отправленным». Первая отметка: версия sent (подпись подставлена текстом на момент отправки), письмо
 * замораживается. Повторная — только событие с новой датой и аудиторией, текст не меняется.
 * Запись «Рассылок» — шаг 8 плана (event.recordId).
 */
export async function sendLetter(db: Db, actor: Actor, id: string, input: SendLetterInput, deps: LetterDeps = {}) {
  const l = await loadLetter(db, id);
  const d = flow.markSent(await stateOf(db, l), input, todayIso(deps.now?.() ?? new Date()));
  if (!d.firstSend) {
    await withTx(db, async (tx) => {
      await claim(tx, l, input.version);
      await addEvent(tx, id, actor.id, 'sent', { versionId: l.sentVersionId, sentOn: new Date(`${d.sentOn}T00:00:00Z`), audience: d.audience, comment: d.comment });
      await auditLetter(tx, actor, l, 'sent', `отмечено отправленным ещё раз: ${d.sentOn}, ${d.audience}`, { sentOn: d.sentOn, audience: d.audience, repeat: true });
    });
    return getLetter(db, actor.id, id);
  }
  const t = currentTexts(l);
  const unfilled = unfilledInLetter(t);
  if (unfilled.length) throw badRequest('UNFILLED_VARIABLES', `Заполните переменные: ${unfilled.map((u) => `«${u}»`).join(', ')}`);
  const langMark = flow.checkLanguages(l.kind as flow.LetterKind, t);
  const sig = await currentSignature(db);
  const sent: TemplateTexts = { ...t, htmlRu: substituteSignature(t.htmlRu, sig.htmlRu), htmlTj: substituteSignature(t.htmlTj, sig.htmlTj) };
  await withTx(db, async (tx) => {
    await claim(tx, l, input.version);
    const v = await addVersion(tx, id, actor.id, 'sent', sent);
    await tx.awarenessLetter.update({ where: { id }, data: { status: 'sent', frozen: true, sentVersionId: v.id, currentVersionId: v.id } });
    await addEvent(tx, id, actor.id, 'sent', {
      versionId: v.id, sentOn: new Date(`${d.sentOn}T00:00:00Z`), audience: d.audience, comment: d.comment, withoutApproval: d.withoutApproval,
    });
    await auditLetter(tx, actor, l, 'sent', `отмечено отправленным: ${d.sentOn}, ${d.audience}${d.withoutApproval ? ' — без согласования' : ''}`, {
      versionNo: v.no, sentOn: d.sentOn, audience: d.audience, withoutApproval: d.withoutApproval, comment: d.comment || undefined, langMark,
    });
  });
  return getLetter(db, actor.id, id);
}

// ———————————————————————————————————————————————— копия и архив

/**
 * «Создать копию» — новый черновик с содержимым последней версии, тем же типом и поводом; без задачи, шаблона и событий.
 * У отправленного письма — содержимое, с которого сделана версия sent (предыдущая версия): там «Подпись ИБ» — блок,
 * а не текст на дату отправки, и копия покажет текущую подпись.
 */
export async function copyLetter(db: Db, actor: Actor, id: string) {
  const l = await loadLetter(db, id);
  let src = currentTexts(l);
  let fromNo = l.currentVersion?.no ?? 0;
  if (l.frozen && l.currentVersion?.reason === 'sent') {
    const before = await db.awarenessLetterVersion.findUnique({ where: { letterId_no: { letterId: id, no: l.currentVersion.no - 1 } } });
    if (before) {
      src = textsOf(before);
      fromNo = before.no;
    }
  }
  const title = `${l.title} (копия)`.slice(0, TITLE_MAX);
  const newId = await withTx(db, async (tx) => {
    const copy = await insertLetter(tx, actor, { title, kind: l.kind as flow.LetterKind, reason: l.reason }, src, 'copy');
    await auditLetter(tx, actor, copy, 'created', `создано копией письма № ${l.number} (версия ${fromNo})`, { copiedFrom: { id: l.id, number: l.number, versionNo: fromNo } });
    await auditLetter(tx, actor, l, 'copied', `создана копия — письмо № ${copy.number}`, { copyId: copy.id, copyNumber: copy.number });
    return copy.id;
  });
  return getLetter(db, actor.id, newId);
}

export async function archiveLetter(db: Db, actor: Actor, id: string, input: { version: number; archived: boolean }) {
  const l = await loadLetter(db, id);
  if ((l.archivedAt !== null) === input.archived) {
    throw new AppError(409, 'LETTER_STATE', input.archived ? 'Письмо уже в архиве' : 'Письмо не в архиве');
  }
  await withTx(db, async (tx) => {
    await claim(tx, l, input.version, { archivedAt: input.archived ? new Date() : null });
    await addEvent(tx, id, actor.id, input.archived ? 'archived' : 'unarchived');
    await auditLetter(tx, actor, l, input.archived ? 'archived' : 'unarchived', input.archived ? 'отправлено в архив' : 'возвращено из архива');
  });
  return getLetter(db, actor.id, id);
}
