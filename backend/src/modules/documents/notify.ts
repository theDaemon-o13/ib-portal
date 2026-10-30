// Уведомления по документам (релиз 1.2.0, этап Г5, ADR-0023, ADR-0024). Тот же механизм, что у задач:
// в транзакции события, о своих действиях — нет, отключённым — нет (notifications/service.ts, notify).
//   «ждёт вас»: этап 13 — начальникам ИБ (свой документ — другим, если они есть); этап 14, когда все лица
//   согласовали, — начальникам ИБ; этап 15 — переводчику его языка; переводы готовы — начальникам ИБ и старшим
//   над автором; этап 16 — автору;
//   вернули на доработку, комментарий сотрудника на этапе 12 — автору; сменили срок — переводчику его языка и автору;
//   «срок ответственного лица завтра» и «просрочен» — автору (часовой прогон, по одному на лицо и срок).
import type { Db } from '../../lib/db.js';
import { seniorIdsOf } from '../../lib/hierarchy.js';
import { formatDateRu } from '../../lib/register-values.js';
import { addDaysIso, todayIso } from '../../lib/today.js';
import { notify } from '../notifications/service.js';

export interface DocRef { id: string; number: number; title: string; ownerId: string }
const label = (d: DocRef) => `#${d.number} «${d.title}»`;

/** Начальник ИБ — активный пользователь с отметкой (1.4.0, одна на портал); нет отметки — некому. О своих действиях уведомлений нет. */
async function headsFor(db: Db): Promise<string[]> {
  return (await db.user.findMany({ where: { isActive: true, isIbHead: true }, select: { id: true } })).map((u) => u.id);
}

async function pendingTranslations(db: Db, versionId: string) {
  return db.documentTranslation.findMany({
    where: { versionId, removedAt: null, files: { none: { removedAt: null } } },
    select: { id: true, language: true, translatorId: true, dueDate: true },
  });
}

/** Переводы готовы (или языков нет) — начальникам ИБ и старшим над автором: можно на подписание. */
async function notifyTranslationsReady(db: Db, d: DocRef, actorId: string | null) {
  await notify(db, {
    kind: 'doc_waiting', to: [...(await headsFor(db)), ...(await seniorIdsOf(db, d.ownerId))], documentId: d.id, actorId,
    title: `Документ ${label(d)}: переводы готовы — можно на подписание`,
  });
}

/** Переводчику — его язык ждёт перевода (этап 15). */
export async function notifyTranslator(db: Db, d: DocRef, t: { language: string; translatorId: string; dueDate: Date }, actorId: string | null) {
  await notify(db, {
    kind: 'doc_translation', to: [t.translatorId], documentId: d.id, actorId,
    title: `Документ ${label(d)} ждёт перевода на ${t.language}`, body: `Срок — ${formatDateRu(t.dueDate.toISOString().slice(0, 10))}`,
  });
}

/** Документ перешёл на этап stage: кого он теперь ждёт. */
export async function notifyStage(db: Db, d: DocRef, versionId: string, stage: number, actorId: string): Promise<void> {
  if (stage === 13) {
    await notify(db, { kind: 'doc_waiting', to: await headsFor(db), documentId: d.id, actorId, title: `Документ ${label(d)} ждёт вашего согласования` });
  } else if (stage === 15) {
    const pending = await pendingTranslations(db, versionId);
    for (const t of pending) await notifyTranslator(db, d, t, actorId);
    if (!pending.length) await notifyTranslationsReady(db, d, actorId);
  } else if (stage === 16) {
    await notify(db, { kind: 'doc_waiting', to: [d.ownerId], documentId: d.id, actorId, title: `Документ ${label(d)} ждёт подписанного PDF` });
  }
}

/** Последнее ответственное лицо согласовало (этап 14) — начальникам ИБ: можно ознакомиться с финальной версией. */
export async function notifyPartiesDone(db: Db, d: DocRef, versionId: string, actorId: string): Promise<void> {
  const left = await db.documentParty.count({ where: { versionId, removedAt: null, approvedAt: null } });
  if (left > 0) return;
  await notify(db, {
    kind: 'doc_waiting', to: await headsFor(db), documentId: d.id, actorId,
    title: `Документ ${label(d)}: все ответственные лица согласовали`, body: 'Ознакомьтесь с финальной версией',
  });
}

/** Приложен перевод на этапе 15: если файлов больше не ждём — «можно на подписание». */
export async function notifyTranslationDone(db: Db, d: DocRef, versionId: string, actorId: string): Promise<void> {
  if ((await pendingTranslations(db, versionId)).length === 0) await notifyTranslationsReady(db, d, actorId);
}

export async function notifyReturned(db: Db, d: DocRef, actorId: string, stageName: string, comment: string): Promise<void> {
  const who = (await db.user.findUnique({ where: { id: actorId }, select: { fullName: true } }))?.fullName ?? '—';
  await notify(db, {
    kind: 'doc_returned', to: [d.ownerId], documentId: d.id, actorId,
    title: `Документ ${label(d)} вернули на доработку`, body: `${who}, этап «${stageName}»: ${comment}`,
  });
}

export async function notifyDocComment(db: Db, d: DocRef, actorId: string, text: string): Promise<void> {
  const who = (await db.user.findUnique({ where: { id: actorId }, select: { fullName: true } }))?.fullName ?? '—';
  await notify(db, { kind: 'doc_commented', to: [d.ownerId], documentId: d.id, actorId, title: `Комментарий к документу ${label(d)}`, body: `${who}: ${text}` });
}

/** Сменили срок: перевода — переводчику и автору; ответственного лица — автору. */
export async function notifyDeadlineChanged(db: Db, d: DocRef, what: string, to: readonly (string | null)[], from: string, next: string, comment: string, actorId: string) {
  await notify(db, {
    kind: 'doc_deadline_changed', to: [...to, d.ownerId], documentId: d.id, actorId,
    title: `Документ ${label(d)}: срок ${what} перенесён с ${formatDateRu(from)} на ${formatDateRu(next)}`, body: comment,
  });
}

/**
 * Часовой прогон: «срок ответственного лица завтра» и «просрочен» — автору (решение владельца 5). Только лица, которые
 * ещё не согласовали, у рабочей версии неархивного и неудалённого документа. Одно уведомление на лицо и срок.
 */
export async function notifyPartyDeadlines(db: Db, now = new Date()): Promise<{ dueTomorrow: number; overdue: number }> {
  const today = todayIso(now);
  const tomorrow = addDaysIso(today, 1);
  const rows = await db.documentParty.findMany({
    where: {
      removedAt: null, approvedAt: null, dueDate: { lte: new Date(`${tomorrow}T00:00:00Z`) },
      version: { workingOf: { is: { archivedAt: null, deletedAt: null } }, cancelledAt: null },
    },
    select: { id: true, fullName: true, dueDate: true, document: { select: { id: true, number: true, ownerId: true } }, version: { select: { title: true } } },
  });
  let dueTomorrow = 0;
  let overdue = 0;
  for (const p of rows) {
    const due = p.dueDate.toISOString().slice(0, 10);
    const d: DocRef = { id: p.document.id, number: p.document.number, title: p.version.title, ownerId: p.document.ownerId };
    if (due === tomorrow) {
      dueTomorrow += await notify(db, {
        kind: 'doc_party_due_tomorrow', to: [d.ownerId], documentId: d.id, actorId: null, dedupeKey: `doc_party_due:${p.id}:${due}`,
        title: `Документ ${label(d)}: срок ответа ${p.fullName} — завтра, ${formatDateRu(due)}`,
      });
    } else if (due < today) {
      overdue += await notify(db, {
        kind: 'doc_party_overdue', to: [d.ownerId], documentId: d.id, actorId: null, dedupeKey: `doc_party_overdue:${p.id}:${due}`,
        title: `Документ ${label(d)}: ${p.fullName} не ответил(а) в срок (${formatDateRu(due)})`,
      });
    }
  }
  return { dueTomorrow, overdue };
}
