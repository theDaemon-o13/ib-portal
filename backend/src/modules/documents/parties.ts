// Этап 14 «Согласование с ответственными лицами» и блокеры (релиз 1.2.0, этап Г3, ADR-0024).
// Ответственные лица — внешние люди (ФИО, подразделение, e-mail для справки; по желанию — пользователь портала),
// которым документ отправлен по почте: портал писем не отправляет. Лиц ведут автор и начальник ИБ на этапах 11–14,
// согласование отмечают на этапе 14, по желанию — с ответом (файл). Срок меняется только с комментарием, история
// сроков только пополняется. Блокеры открывают и снимают автор, старшие над автором и начальник ИБ; снятие —
// с комментарием. Открытый блокер останавливает шаги вперёд (service.ts, gate).
import type { Db } from '../../lib/db.js';
import { withTx } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { MIME_BY_EXT } from '../../lib/file-type.js';
import { formatDateRu } from '../../lib/register-values.js';
import { claimFiles, deleteIfUnreferenced } from '../files/links.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { notifyDeadlineChanged, notifyPartiesDone } from './notify.js';
import { cleanComment, forbiddenWith, rolesOf, routeContext } from './service.js';
import { stageName } from './status.js';

export const NAME_MAX = 300;
export const DEPARTMENT_MAX = 300;
export const BLOCKER_MAX = 2000;

/** Этапы, на которых ведётся список лиц: заранее с драфта и до этапа 14 включительно. */
const PARTY_STAGES = [11, 12, 13, 14];
const PARTY_APPROVE_STAGE = 14;
const RESPONSE_MIME = [MIME_BY_EXT.pdf, MIME_BY_EXT.docx, MIME_BY_EXT.png, MIME_BY_EXT.jpg, MIME_BY_EXT.txt];

type Stage = { version: number; stage: number };

/**
 * Ответственное лицо — внешний человек (1.4.0, решение владельца 10): ФИО, подразделение или должность, срок ответа;
 * ответ-файл — при «Отметить согласование». E-mail и «пользователь портала» не вводятся: колонки остаются, старые
 * значения показываются в карточке текстом.
 */
export interface PartyInput {
  fullName: string;
  /** Подразделение или должность. */
  department?: string;
  /** Срок ответа, YYYY-MM-DD. */
  dueDate: string;
}

function cleanDate(v: string, what: string): Date {
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw badRequest('BAD_DATE', `Укажите ${what}`);
  return d;
}

function cleanText(v: string | undefined, max: number, what: string, required = false): string {
  const t = trimmed(v ?? '');
  if (required && !t) throw badRequest('EMPTY', `Укажите ${what}`);
  if (t.length > max) throw badRequest('TOO_LONG', `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} — не длиннее ${max} символов`);
  return t;
}

/** Контекст действия со списком лиц: автор или начальник ИБ, этапы 11–14. */
async function partyContext(tx: Db, actor: Actor, id: string, input: Stage) {
  const ctx = await routeContext(tx, actor, id, input);
  const roles = rolesOf(ctx.who, ctx.d);
  if (!roles.has('author') && !roles.has('head')) {
    throw forbiddenWith('FORBIDDEN', 'Ответственных лиц ведут автор документа (владелец или «Документы: управление») и начальник ИБ');
  }
  if (!PARTY_STAGES.includes(ctx.w.stage)) throw conflict('WRONG_STAGE', `Ответственных лиц ведут до этапа «${stageName(PARTY_APPROVE_STAGE)}» включительно`);
  return ctx;
}

async function getParty(tx: Db, versionId: string, partyId: string) {
  const p = await tx.documentParty.findFirst({ where: { id: partyId, versionId, removedAt: null } });
  if (!p) throw notFound('Ответственное лицо');
  return p;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function addParty(db: Db, actor: Actor, id: string, input: Stage & PartyInput) {
  return withTx(db, async (tx) => {
    const { d, w } = await partyContext(tx, actor, id, input);
    const fullName = cleanText(input.fullName, NAME_MAX, 'ФИО', true);
    const department = cleanText(input.department, DEPARTMENT_MAX, 'подразделение или должность');
    const due = cleanDate(input.dueDate, 'срок ответа');
    const p = await tx.documentParty.create({
      data: { documentId: id, versionId: w.id, fullName, department, dueDate: due, addedBy: actor.id },
    });
    await auditSettings(tx, actor, {
      action: 'document.party_added', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: ответственное лицо ${fullName}${department ? ` (${department})` : ''}, срок ${formatDateRu(iso(due))}`,
      after: { partyId: p.id, fullName, department, dueDate: iso(due) },
    });
  });
}

export interface PartyPatch extends Partial<PartyInput> {
  /** Обязателен, если меняется срок. */
  comment?: string;
}

/** Правка лица; смена срока — только с комментарием, в историю сроков. */
export async function updateParty(db: Db, actor: Actor, id: string, partyId: string, input: Stage & PartyPatch) {
  return withTx(db, async (tx) => {
    const { d, w } = await partyContext(tx, actor, id, input);
    const p = await getParty(tx, w.id, partyId);
    const data: { fullName?: string; department?: string; dueDate?: Date } = {};
    const changes: { label: string; from: string; to: string }[] = [];
    if (input.fullName !== undefined) {
      const v = cleanText(input.fullName, NAME_MAX, 'ФИО', true);
      if (v !== p.fullName) { data.fullName = v; changes.push({ label: 'ФИО', from: p.fullName, to: v }); }
    }
    if (input.department !== undefined) {
      const v = cleanText(input.department, DEPARTMENT_MAX, 'подразделение или должность');
      if (v !== p.department) { data.department = v; changes.push({ label: 'Подразделение или должность', from: p.department || '—', to: v || '—' }); }
    }
    if (input.dueDate !== undefined) {
      const due = cleanDate(input.dueDate, 'срок ответа');
      if (iso(due) !== iso(p.dueDate)) {
        const comment = cleanComment(input.comment, 'Напишите, почему меняется срок');
        if (p.approvedAt) throw conflict('PARTY_APPROVED', `${p.fullName} уже согласовал(а): срок не меняется`);
        data.dueDate = due;
        changes.push({ label: 'Срок', from: formatDateRu(iso(p.dueDate)), to: formatDateRu(iso(due)) });
        await tx.documentDeadlineChange.create({ data: { documentId: id, partyId, fromDate: p.dueDate, toDate: due, comment, actorId: actor.id } });
        await notifyDeadlineChanged(tx, { id, number: d.number, title: w.title, ownerId: d.ownerId }, `ответа ${p.fullName}`, [], iso(p.dueDate), iso(due), comment, actor.id);
      }
    }
    if (!changes.length) return;
    await tx.documentParty.update({ where: { id: partyId }, data });
    await auditSettings(tx, actor, {
      action: 'document.party_updated', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: ${p.fullName} — ${changes.map((c) => `«${c.label}»`).join(', ')}`,
      after: { partyId, changes, comment: input.comment?.trim() ?? '' },
    });
  });
}

/** Снять лицо, которое ещё не согласовало (ошибка в списке). Строка остаётся с отметкой «снят». */
export async function removeParty(db: Db, actor: Actor, id: string, partyId: string, input: Stage) {
  return withTx(db, async (tx) => {
    const { d, w } = await partyContext(tx, actor, id, input);
    const p = await getParty(tx, w.id, partyId);
    if (p.approvedAt) throw conflict('PARTY_APPROVED', `${p.fullName} уже согласовал(а): из списка не снимается`);
    await tx.documentParty.update({ where: { id: partyId }, data: { removedAt: new Date(), removedBy: actor.id } });
    await auditSettings(tx, actor, {
      action: 'document.party_removed', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: ${p.fullName} снят(а) из ответственных лиц`,
      after: { partyId },
    });
  });
}

/** Отметить согласование лица (этап 14), по желанию — с комментарием и ответом (файлы). */
export async function approveParty(db: Db, actor: Actor, id: string, partyId: string, input: Stage & { comment?: string; fileIds?: string[] }) {
  return withTx(db, async (tx) => {
    const { d, w } = await partyContext(tx, actor, id, input);
    if (w.stage !== PARTY_APPROVE_STAGE) throw conflict('WRONG_STAGE', `Согласование лиц отмечается на этапе «${stageName(PARTY_APPROVE_STAGE)}»`);
    const p = await getParty(tx, w.id, partyId);
    if (p.approvedAt) throw conflict('PARTY_APPROVED', `${p.fullName} уже согласовал(а)`);
    const comment = cleanComment(input.comment, null);
    const files = await claimFiles(tx, actor.id, input.fileIds ?? [], { mimes: RESPONSE_MIME, what: 'Ответ' });
    await tx.documentParty.update({ where: { id: partyId }, data: { approvedAt: new Date(), approvedBy: actor.id, approveComment: comment } });
    if (files.length) {
      await tx.documentFile.createMany({ data: files.map((f) => ({ documentId: id, versionId: w.id, round: w.round, kind: 'response', partyId, fileId: f.id, addedBy: actor.id })) });
    }
    await auditSettings(tx, actor, {
      action: 'document.party_approved', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: ${p.fullName} согласовал(а)${files.length ? `, ответ — ${files.map((f) => `«${f.originalName}»`).join(', ')}` : ''}`,
      after: { partyId, comment, files: files.map((f) => ({ id: f.id, name: f.originalName, sha256: f.sha256 })) },
    });
    await notifyPartiesDone(tx, { id, number: d.number, title: w.title, ownerId: d.ownerId }, w.id, actor.id);
  });
}

/** Приложить ответ лица (файлы) — и до, и после отметки согласования. */
export async function addResponseFiles(db: Db, actor: Actor, id: string, partyId: string, input: Stage & { fileIds: string[] }) {
  return withTx(db, async (tx) => {
    const { d, w } = await partyContext(tx, actor, id, input);
    const p = await getParty(tx, w.id, partyId);
    const files = await claimFiles(tx, actor.id, input.fileIds, { mimes: RESPONSE_MIME, what: 'Ответ' });
    if (!files.length) throw badRequest('FILE_REQUIRED', 'Выберите файл');
    await tx.documentFile.createMany({ data: files.map((f) => ({ documentId: id, versionId: w.id, round: w.round, kind: 'response', partyId, fileId: f.id, addedBy: actor.id })) });
    await auditSettings(tx, actor, {
      action: 'document.files_added', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: ответ ${p.fullName} — ${files.map((f) => `«${f.originalName}»`).join(', ')}`,
      after: { partyId, files: files.map((f) => ({ id: f.id, name: f.originalName, sha256: f.sha256 })) },
    });
  });
}

export async function removeResponseFile(db: Db, actor: Actor, id: string, linkId: string, input: Stage) {
  return withTx(db, async (tx) => {
    const { d, w } = await partyContext(tx, actor, id, input);
    const link = await tx.documentFile.findFirst({ where: { id: linkId, versionId: w.id, kind: 'response', removedAt: null }, include: { file: { select: { originalName: true } } } });
    if (!link) throw notFound('Файл ответа');
    await tx.documentFile.update({ where: { id: link.id }, data: { removedAt: new Date(), removedBy: actor.id } });
    await deleteIfUnreferenced(tx, actor, link.fileId, `снят с ответа по документу #${d.number}`);
    await auditSettings(tx, actor, {
      action: 'document.file_removed', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: снят файл ответа «${link.file.originalName}»`,
      after: { fileId: link.fileId, partyId: link.partyId },
    });
  });
}

// ---------------------------------------------------------------- блокеры

/** Блокеры ведут автор, старшие над автором и начальник ИБ (решение владельца 4) — на любом этапе маршрута. */
async function blockerContext(tx: Db, actor: Actor, id: string, input: Stage) {
  const ctx = await routeContext(tx, actor, id, input);
  const roles = rolesOf(ctx.who, ctx.d);
  if (!roles.has('author') && !roles.has('senior') && !roles.has('head')) {
    throw forbiddenWith('FORBIDDEN', 'Блокеры открывают и снимают автор документа, старшие над автором и начальник ИБ');
  }
  return ctx;
}

export async function addBlocker(db: Db, actor: Actor, id: string, input: Stage & { text: string }) {
  return withTx(db, async (tx) => {
    const text = cleanComment(input.text, 'Опишите, что мешает');
    if (text.length > BLOCKER_MAX) throw badRequest('TOO_LONG', `Блокер — не длиннее ${BLOCKER_MAX} символов`);
    const { d, w } = await blockerContext(tx, actor, id, input);
    const b = await tx.documentBlocker.create({ data: { documentId: id, versionId: w.id, text, openedBy: actor.id } });
    await auditSettings(tx, actor, {
      action: 'document.blocker_opened', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: блокер — ${text.slice(0, 200)}`,
      after: { blockerId: b.id, text, stage: w.stage },
    });
  });
}

export async function resolveBlocker(db: Db, actor: Actor, id: string, blockerId: string, input: Stage & { comment: string }) {
  return withTx(db, async (tx) => {
    const comment = cleanComment(input.comment, 'Напишите, как снят блокер');
    const { d, w } = await blockerContext(tx, actor, id, input);
    const b = await tx.documentBlocker.findFirst({ where: { id: blockerId, versionId: w.id } });
    if (!b) throw notFound('Блокер');
    if (b.resolvedAt) throw conflict('BLOCKER_RESOLVED', 'Блокер уже снят. Обновите страницу');
    await tx.documentBlocker.update({ where: { id: blockerId }, data: { resolvedAt: new Date(), resolvedBy: actor.id, resolveComment: comment } });
    await auditSettings(tx, actor, {
      action: 'document.blocker_resolved', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: блокер снят — ${comment.slice(0, 200)}`,
      after: { blockerId, comment },
    });
  });
}
