// Этап 22 «Согласование» с ответственными лицами (маршрут 1.11.0, ADR-0042; до него — этап 14) и блокеры.
// Ответственные лица — внешние люди (ФИО, подразделение или должность), которым документ отправлен по почте: портал
// писем не отправляет. Лиц ведёт автор: добавлять можно уже на этапе 21 — срок тогда задаётся днями и становится
// датой при переходе на этап 22 (решение владельца 11). Отметка согласования (дата и комментарий, без файла), перенос
// срока (только с комментарием, история пополняется) и «Запросить повторно» — только на этапе 22. Начальник ИБ
// на этапе не участвует. Блокеры открывают и снимают автор, старшие над автором и начальник ИБ; снятие — с комментарием.
import type { Db } from '../../lib/db.js';
import { withTx } from '../../lib/db.js';
import { cleanEmail } from '../../lib/email.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { personKey } from '../../lib/person-key.js';
import { formatDateRu } from '../../lib/register-values.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { notifyDeadlineChanged } from './notify.js';
import { todayIso } from '../../lib/today.js';
import { cleanComment, filesOnlyAtApproval, forbiddenWith, rolesOf, routeContext, syncStageTasks } from './service.js';
import { FIRST_STAGE, PARTIES_STAGE, stateOf } from './status.js';

export const NAME_MAX = 300;
export const DEPARTMENT_MAX = 300;
export const BLOCKER_MAX = 2000;

/** Срок ответа на этапе 1 — дней от перехода на этап 2 (решение владельца 11). */
export const DUE_DAYS_MAX = 90;

type Stage = { version: number; stage: number };

/**
 * Ответственное лицо — внешний человек (1.4.0, решение владельца 10): ФИО, подразделение или должность, срок ответа;
 * ответ-файл — при «Отметить согласование». Почта (1.13.6) — справочно, для титульного листа: копируется из справочника
 * или вводится вручную, колонка email — та же, что у строк до 1.4.0. «Пользователь портала» не вводится.
 */
export interface PartyInput {
  fullName: string;
  /** Подразделение или должность. */
  department?: string;
  /** Почта (1.13.6), необязательна. */
  email?: string;
  /** Срок ответа, YYYY-MM-DD — на этапе 22. */
  dueDate?: string;
  /** Срок ответа, дней от перехода на этап 22 — на этапе 21. */
  dueDays?: number;
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

/**
 * Контекст действия со списком лиц: автор, этап 21 (кроме проверки у начальника ИБ) или 22 «Согласование».
 * approve — отметка, перенос срока, «Запросить повторно»: только этап 22.
 */
async function partyContext(tx: Db, actor: Actor, id: string, input: Stage, approve = false) {
  const ctx = await routeContext(tx, actor, id, input);
  if (!rolesOf(ctx.who, ctx.d).has('author')) {
    throw forbiddenWith('FORBIDDEN', 'Ответственных лиц ведёт автор документа (владелец или «Документы: управление»)');
  }
  const state = stateOf(ctx.w);
  const draft = ctx.w.stage === FIRST_STAGE && state === 'draft';
  const agreeing = ctx.w.stage === PARTIES_STAGE && state === 'parties';
  if (approve && !agreeing) throw conflict('WRONG_STAGE', 'Отметка согласования и перенос срока — на этапе «Согласование» (с этапа 2)');
  if (!draft && !agreeing) throw conflict('WRONG_STAGE', 'Ответственных лиц ведут в драфте и на этапе «Согласование»');
  return { ...ctx, onDraft: draft };
}

/** Срок нового лица: на этапе 21 — дней (дата предварительная: сегодня + N), на 22 — дата. */
function dueOf(input: { dueDate?: string; dueDays?: number }, onDraft: boolean): { dueDate: Date; dueDays: number | null } {
  if (onDraft) {
    const n = input.dueDays;
    if (n === undefined || !Number.isInteger(n) || n < 1 || n > DUE_DAYS_MAX) throw badRequest('BAD_DUE_DAYS', `Срок ответа — от 1 до ${DUE_DAYS_MAX} дней: отсчёт начнётся с перехода на этап «Согласование»`);
    // Предварительная дата — от «сегодня» банка (APP_TZ), как и окончательная при переходе на этап 22.
    return { dueDate: new Date(Date.parse(`${todayIso()}T00:00:00Z`) + n * 86_400_000), dueDays: n };
  }
  if (!input.dueDate) throw badRequest('BAD_DATE', 'Укажите срок ответа');
  return { dueDate: cleanDate(input.dueDate, 'срок ответа'), dueDays: null };
}

async function getParty(tx: Db, versionId: string, partyId: string) {
  const p = await tx.documentParty.findFirst({ where: { id: partyId, versionId, removedAt: null } });
  if (!p) throw notFound('Ответственное лицо');
  return p;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Один человек — один раз среди неснятых лиц версии (1.6.7): совпали ФИО и подразделение или должность без учёта
 * регистра и лишних пробелов (lib/person-key.ts). Одно правило для выбора из справочника и ручного ввода;
 * уже добавленные раньше дубли не трогаются — проверяются только новое добавление и правка.
 */
async function assertNotDuplicate(tx: Db, versionId: string, fullName: string, department: string, exceptPartyId?: string) {
  const key = personKey(fullName, department);
  const rows = await tx.documentParty.findMany({ where: { versionId, removedAt: null }, select: { id: true, fullName: true, department: true } });
  if (rows.some((r) => r.id !== exceptPartyId && personKey(r.fullName, r.department) === key)) {
    throw conflict('PARTY_DUPLICATE', `${fullName}${department ? ` (${department})` : ''} уже есть среди ответственных лиц этого документа`);
  }
}

/** Сколько человек за один раз (1.13.5): больше — 400 PARTIES_BATCH_LIMIT. */
export const PARTIES_BATCH_MAX = 50;

export interface PartiesBatchInput {
  people: { fullName: string; department?: string; email?: string }[];
  /** Общий срок для всех, YYYY-MM-DD — на этапе 22. */
  dueDate?: string;
  /** Общий срок для всех, дней от перехода на этап 22 — на этапе 21. */
  dueDays?: number;
}

/** Ошибка строки пачки: тот же код, текст «Строка N (ФИО): …», номер строки — в details.row. */
function rowError(err: unknown, row: number, fullName: string): never {
  if (err instanceof AppError) {
    const who = fullName ? ` (${fullName})` : '';
    throw new AppError(err.statusCode, err.code, `Строка ${row}${who}: ${err.message}`, { row });
  }
  throw err;
}

/**
 * Добавить лиц и записать в журнал — общее у одного лица и пачки: проверки строк (ФИО, длины, дубли с неснятыми
 * лицами версии и внутри пачки — personKey), строки document_parties, запись document.party_added на каждого и один
 * syncStageTasks после всех. Срок один на всех, уже проверенный (dueOf).
 */
async function insertParties(
  tx: Db, actor: Actor, ctx: { id: string; number: number; title: string; versionId: string },
  people: { fullName: string; department?: string; email?: string }[], due: { dueDate: Date; dueDays: number | null }, batch: boolean,
) {
  const rows = people.map((p, i) => {
    const row = i + 1;
    try {
      return {
        fullName: cleanText(p.fullName, NAME_MAX, 'ФИО', true),
        department: cleanText(p.department, DEPARTMENT_MAX, 'подразделение или должность'),
        email: cleanEmail(p.email),
      };
    } catch (err) {
      if (batch) rowError(err, row, trimmed(p.fullName ?? '').slice(0, 80));
      throw err;
    }
  });
  const existing = await tx.documentParty.findMany({ where: { versionId: ctx.versionId, removedAt: null }, select: { fullName: true, department: true } });
  const taken = new Set(existing.map((r) => personKey(r.fullName, r.department)));
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const key = personKey(r.fullName, r.department);
    const who = `${r.fullName}${r.department ? ` (${r.department})` : ''}`;
    if (taken.has(key)) {
      const err = conflict('PARTY_DUPLICATE', `${who} уже есть среди ответственных лиц этого документа`);
      if (batch) rowError(err, i + 1, r.fullName);
      throw err;
    }
    const first = seen.get(key);
    if (first !== undefined) rowError(conflict('PARTY_DUPLICATE', `${who} повторяется в списке: строки ${first} и ${i + 1}`), i + 1, r.fullName);
    seen.set(key, i + 1);
  });
  for (const [i, r] of rows.entries()) {
    const p = await tx.documentParty.create({
      data: { documentId: ctx.id, versionId: ctx.versionId, fullName: r.fullName, department: r.department, email: r.email, dueDate: due.dueDate, dueDays: due.dueDays, addedBy: actor.id },
    });
    await auditSettings(tx, actor, {
      action: 'document.party_added', entity: 'document', entityId: ctx.id,
      summary: `Документ #${ctx.number} «${ctx.title}»: ответственное лицо ${r.fullName}${r.department ? ` (${r.department})` : ''}, срок ${due.dueDays ? `${due.dueDays} дн. от этапа «Согласование»` : formatDateRu(iso(due.dueDate))}`,
      after: {
        partyId: p.id, fullName: r.fullName, department: r.department, email: r.email, dueDate: due.dueDays ? null : iso(due.dueDate), dueDays: due.dueDays,
        ...(batch ? { batch: { size: rows.length, row: i + 1 } } : {}),
      },
    });
  }
  await syncStageTasks(tx, ctx.id);
}

export async function addParty(db: Db, actor: Actor, id: string, input: Stage & PartyInput) {
  return withTx(db, async (tx) => {
    const { d, w, onDraft } = await partyContext(tx, actor, id, input);
    // Порядок проверок как до 1.13.5: ФИО, срок, дубль.
    cleanText(input.fullName, NAME_MAX, 'ФИО', true);
    cleanText(input.department, DEPARTMENT_MAX, 'подразделение или должность');
    cleanEmail(input.email);
    const due = dueOf(input, onDraft);
    await insertParties(tx, actor, { id, number: d.number, title: w.title, versionId: w.id }, [input], due, false);
  });
}

/**
 * Несколько лиц с одним сроком (1.13.5): одной транзакцией — все или никто. Где и кто — как у одного лица
 * (partyContext: автор; драфт 21 со сроком днями или «Согласование» 22 со сроком датой). Дальше каждое лицо —
 * отдельная строка со своим сроком: перенос, отметка и напоминания — по каждому, группы нет.
 */
export async function addParties(db: Db, actor: Actor, id: string, input: Stage & PartiesBatchInput) {
  return withTx(db, async (tx) => {
    const { d, w, onDraft } = await partyContext(tx, actor, id, input);
    if (!input.people.length) throw badRequest('EMPTY', 'Выберите или введите хотя бы одного человека');
    if (input.people.length > PARTIES_BATCH_MAX) throw badRequest('PARTIES_BATCH_LIMIT', `За один раз — не больше ${PARTIES_BATCH_MAX} человек`);
    const due = dueOf(input, onDraft);
    await insertParties(tx, actor, { id, number: d.number, title: w.title, versionId: w.id }, input.people, due, true);
  });
}

export interface PartyPatch extends Partial<PartyInput> {
  /** Обязателен, если меняется срок. */
  comment?: string;
}

/** Правка лица; смена срока — только с комментарием, в историю сроков. */
export async function updateParty(db: Db, actor: Actor, id: string, partyId: string, input: Stage & PartyPatch) {
  return withTx(db, async (tx) => {
    const { d, w, onDraft } = await partyContext(tx, actor, id, input, input.dueDate !== undefined);
    const p = await getParty(tx, w.id, partyId);
    const data: { fullName?: string; department?: string; email?: string; dueDate?: Date; dueDays?: number } = {};
    const changes: { label: string; from: string; to: string }[] = [];
    if (input.fullName !== undefined) {
      const v = cleanText(input.fullName, NAME_MAX, 'ФИО', true);
      if (v !== p.fullName) { data.fullName = v; changes.push({ label: 'ФИО', from: p.fullName, to: v }); }
    }
    if (input.department !== undefined) {
      const v = cleanText(input.department, DEPARTMENT_MAX, 'подразделение или должность');
      if (v !== p.department) { data.department = v; changes.push({ label: 'Подразделение или должность', from: p.department || '—', to: v || '—' }); }
    }
    // Почта (1.13.6): дописать или исправить — справочно, и у согласовавшего тоже.
    if (input.email !== undefined) {
      const v = cleanEmail(input.email);
      if (v !== p.email) { data.email = v; changes.push({ label: 'Почта', from: p.email || '—', to: v || '—' }); }
    }
    // На этапе 21 срок — днями и не идёт: правится без комментария (решение владельца 11).
    if (input.dueDays !== undefined && onDraft) {
      const next = dueOf({ dueDays: input.dueDays }, true);
      if (next.dueDays !== p.dueDays) {
        data.dueDays = next.dueDays as number;
        data.dueDate = next.dueDate;
        changes.push({ label: 'Срок, дней', from: String(p.dueDays ?? '—'), to: String(next.dueDays) });
      }
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
    if (data.fullName !== undefined || data.department !== undefined) {
      await assertNotDuplicate(tx, w.id, data.fullName ?? p.fullName, data.department ?? p.department, partyId);
    }
    await tx.documentParty.update({ where: { id: partyId }, data });
    await auditSettings(tx, actor, {
      action: 'document.party_updated', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: ${p.fullName} — ${changes.map((c) => `«${c.label}»`).join(', ')}`,
      after: { partyId, changes, comment: input.comment?.trim() ?? '' },
    });
    await syncStageTasks(tx, id);
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
    await syncStageTasks(tx, id);
  });
}

/** Отметить согласование лица (этап 22): дата согласования и, по желанию, комментарий («согласовано письмом от 05.11»); без файла. */
export async function approveParty(db: Db, actor: Actor, id: string, partyId: string, input: Stage & { comment?: string; approvedOn?: string; fileIds?: string[] }) {
  return withTx(db, async (tx) => {
    if (input.fileIds?.length) throw filesOnlyAtApproval();
    const { d, w } = await partyContext(tx, actor, id, input, true);
    const p = await getParty(tx, w.id, partyId);
    if (p.approvedAt) throw conflict('PARTY_APPROVED', `${p.fullName} уже согласовал(а)`);
    const comment = cleanComment(input.comment, null);
    const today = todayIso();
    const on = cleanDate(input.approvedOn ?? today, 'дату согласования');
    if (iso(on) > today) throw badRequest('BAD_DATE', 'Дата согласования — не позже сегодняшнего дня');
    await tx.documentParty.update({ where: { id: partyId }, data: { approvedAt: new Date(), approvedBy: actor.id, approveComment: comment, approvedOn: on } });
    await auditSettings(tx, actor, {
      action: 'document.party_approved', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: ${p.fullName} согласовал(а) ${formatDateRu(iso(on))}${comment ? ` — ${comment}` : ''}`,
      after: { partyId, comment, approvedOn: iso(on) },
    });
    await syncStageTasks(tx, id);
  });
}

/**
 * «Запросить повторно» (этап 22, решение владельца 5): у лица с отметкой — отметка снимается, новый срок (не раньше
 * сегодня), прежняя отметка и сроки — в историю (document_party_rechecks, только пополняется) и журнал.
 */
export async function recheckParty(db: Db, actor: Actor, id: string, partyId: string, input: Stage & { dueDate: string; comment?: string }) {
  return withTx(db, async (tx) => {
    const { d, w } = await partyContext(tx, actor, id, input, true);
    const p = await getParty(tx, w.id, partyId);
    if (!p.approvedAt) throw conflict('PARTY_NOT_APPROVED', `${p.fullName} ещё не согласовал(а): запрашивать повторно нечего`);
    const due = cleanDate(input.dueDate, 'новый срок ответа');
    if (iso(due) < todayIso()) throw badRequest('BAD_DATE', 'Новый срок — не раньше сегодняшнего дня');
    const comment = cleanComment(input.comment, null);
    await tx.documentPartyRecheck.create({
      data: {
        documentId: id, partyId, prevApprovedAt: p.approvedAt, prevApprovedOn: p.approvedOn, prevApprovedBy: p.approvedBy, prevComment: p.approveComment,
        reworkedAt: p.reworkedAt, fromDue: p.dueDate, toDue: due, comment, actorId: actor.id,
      },
    });
    await tx.documentParty.update({
      where: { id: partyId },
      data: { approvedAt: null, approvedBy: null, approveComment: '', approvedOn: null, reworkedAt: null, dueDate: due },
    });
    await auditSettings(tx, actor, {
      action: 'document.party_recheck', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: у ${p.fullName} запрошено повторное согласование, срок ${formatDateRu(iso(due))}`,
      after: { partyId, fromDue: iso(p.dueDate), toDue: iso(due), comment, prevApprovedOn: p.approvedOn ? iso(p.approvedOn) : null },
    });
    await syncStageTasks(tx, id);
  });
}

/** Ответы лиц файлами — до 1.11.0; с 1.11.0 файлы прикладываются только на этапе 24, прежние не снимаются (409). */
export async function addResponseFiles(db: Db, actor: Actor, id: string, _partyId: string, input: Stage & { fileIds: string[] }) {
  return withTx(db, async (tx) => {
    await routeContext(tx, actor, id, input);
    throw filesOnlyAtApproval();
  });
}

export async function removeResponseFile(db: Db, actor: Actor, id: string, _linkId: string, input: Stage) {
  return withTx(db, async (tx) => {
    await routeContext(tx, actor, id, input);
    throw filesOnlyAtApproval();
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
