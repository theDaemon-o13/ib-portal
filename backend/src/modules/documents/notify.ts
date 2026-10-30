// Уведомления по документам (релиз 1.2.0, этап Г5, ADR-0023, ADR-0024). Тот же механизм, что у задач:
// в транзакции события, о своих действиях — нет, отключённым — нет (notifications/service.ts, notify).
//   «ждёт вас» — notifyWaiting в service.ts (1.4.0): получатели по stageHolders, одно на состояние; здесь — «все лица
//   согласовали» (этап 14) начальнику ИБ;
//   вернули на доработку, комментарий сотрудника на этапе 12 — автору; сменили срок — переводчику его языка и автору;
//   «срок ответственного лица завтра» и «просрочен» — автору (часовой прогон, по одному на лицо и срок).
import type { Db } from '../../lib/db.js';
import { formatDateRu } from '../../lib/register-values.js';
import { addDaysIso, todayIso } from '../../lib/today.js';
import { notify } from '../notifications/service.js';

export interface DocRef { id: string; number: number; title: string; ownerId: string }
const label = (d: DocRef) => `#${d.number} «${d.title}»`;

/** Начальник ИБ — активный пользователь с отметкой (1.4.0, одна на портал); нет отметки — некому. О своих действиях уведомлений нет. */
async function headsFor(db: Db): Promise<string[]> {
  return (await db.user.findMany({ where: { isActive: true, isIbHead: true }, select: { id: true } })).map((u) => u.id);
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
