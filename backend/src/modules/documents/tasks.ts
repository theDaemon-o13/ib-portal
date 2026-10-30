// Задачи по документам (этап 6): владельцу — «Пересмотреть документ» и «Доработать документ».
// Одна открытая задача на (документ, причина, ответственный) — индекс tasks_doc_open_uq; повтор — комментарий в ней.
// Пользователям без ib.work задачи не ставятся: владелец без доступа к ИБ — задача без ответственного.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { todayIso } from '../../lib/today.js';
import { addWorkingDays, isoDate, parseIsoDate } from '../../lib/working-days.js';
import { loadFullWorkCalendar } from '../calendar/service.js';
import { notifyAssignee } from '../notifications/service.js';
import { initialStatusId, recordTransition, statusIdOf } from '../tasks/flow.js';
import { systemItemId, TITLE_MAX } from '../tasks/service.js';

export type DocTaskReason = 'review' | 'returned';

/** Метка задачи без ответственного: сотрудник ИБ видит, кому она предназначалась. */
export const OWNER_LABEL = 'Владелец документа';

const IB_WORK = { roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } } as const;

export interface DocTaskInput {
  documentId: string;
  reason: DocTaskReason;
  title: string;
  description: string;
  /** Комментарий в уже открытую задачу при повторе. */
  repeatComment: string;
  /** Срок: дата YYYY-MM-DD или N рабочих дней от сегодня. */
  due?: string;
  workdays?: number;
  /** Событие пересмотра (automation_events), из которого создана задача. */
  eventId?: string;
  priority?: 'normal' | 'high';
}

/** Создать задачу владельцу документа или дописать комментарий в открытую. Пишется в журнал (автор — система). */
export async function documentTask(tx: Db, input: DocTaskInput): Promise<{ taskId: string; action: 'created' | 'commented' }> {
  const doc = await tx.document.findUniqueOrThrow({ where: { id: input.documentId }, select: { number: true, ownerId: true } });
  const owner = await tx.user.findFirst({ where: { id: doc.ownerId, isActive: true, ...IB_WORK }, select: { id: true } });
  const assigneeId = owner?.id ?? null;
  const open = await tx.task.findFirst({
    where: { documentId: input.documentId, documentReason: input.reason, assigneeId, completedAt: null, archivedAt: null, deletedAt: null },
    select: { id: true, number: true },
  });
  if (open) {
    await tx.taskComment.create({ data: { taskId: open.id, eventId: input.eventId ?? null, body: input.repeatComment.slice(0, 4000) } });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'task.commented', entity: 'task', entityId: open.id,
        diff: { summary: `Задача #${open.number}: ${input.repeatComment.slice(0, 200)}`, after: { documentId: input.documentId } } as Prisma.InputJsonValue,
      },
    });
    return { taskId: open.id, action: 'commented' };
  }
  let due = input.due ?? null;
  if (!due && input.workdays) due = isoDate(addWorkingDays(parseIsoDate(todayIso()), input.workdays, await loadFullWorkCalendar(tx)));
  const task = await tx.task.create({
    data: {
      title: input.title.slice(0, TITLE_MAX),
      description: input.description.slice(0, 20_000),
      statusId: await initialStatusId(tx, assigneeId),
      priorityId: await systemItemId(tx, 'task_priorities', input.priority ?? 'normal'),
      categoryId: await systemItemId(tx, 'task_categories', 'documents'),
      assigneeId,
      dueDate: due ? new Date(`${due}T00:00:00Z`) : null,
      source: 'document',
      documentId: input.documentId,
      documentReason: input.reason,
      recipientLabel: assigneeId ? null : OWNER_LABEL,
    },
    select: { id: true, number: true, statusId: true },
  });
  await recordTransition(tx, { taskId: task.id, from: null, to: task.statusId, actorId: null, kind: 'system' });
  await notifyAssignee(tx, { id: task.id, number: task.number, title: input.title.slice(0, TITLE_MAX) }, null, assigneeId, null);
  await tx.auditLog.create({
    data: {
      userId: null, action: 'task.created', entity: 'task', entityId: task.id,
      diff: {
        summary: `Задача #${task.number} создана по документу #${doc.number}${assigneeId ? '' : ' (владелец без доступа к ИБ — ответственный не назначен)'}`,
        after: { source: 'document', documentId: input.documentId, reason: input.reason, eventId: input.eventId ?? null },
      } as Prisma.InputJsonValue,
    },
  });
  return { taskId: task.id, action: 'created' };
}

/** Закрыть открытые задачи документа (доработка — при отправке на согласование, пересмотр — при утверждении). */
export async function closeDocumentTasks(tx: Db, documentId: string, reason: DocTaskReason, comment: string): Promise<number> {
  const open = await tx.task.findMany({
    where: { documentId, documentReason: reason, completedAt: null, archivedAt: null, deletedAt: null },
    select: { id: true, number: true, statusId: true },
  });
  if (!open.length) return 0;
  const done = await statusIdOf(tx, 'done');
  const now = new Date();
  for (const t of open) {
    await tx.task.update({ where: { id: t.id }, data: { statusId: done, completedAt: now, reviewerId: null, version: { increment: 1 } } });
    // Системная задача закрывается сама, без проверки (решение владельца, этап Б); комментарий перехода — в ленте задачи.
    await recordTransition(tx, { taskId: t.id, from: t.statusId, to: done, actorId: null, kind: 'system', comment: `${comment}. Задача закрыта автоматически` });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'task.updated', entity: 'task', entityId: t.id,
        diff: { summary: `Задача #${t.number} закрыта: ${comment}`, after: { changes: [{ label: 'Статус', from: 'открыта', to: 'Выполнено' }] } } as Prisma.InputJsonValue,
      },
    });
  }
  return open.length;
}
