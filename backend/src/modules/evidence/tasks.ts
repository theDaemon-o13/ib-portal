// Задачи по доказательствам (этап 7): «Исправить и загрузить заново» загрузившему (при отклонении) и
// «Обновить доказательство» ответственному (за 30 дней до окончания срока действия).
// Одна открытая задача на (доказательство, причина, ответственный) — индекс tasks_evidence_open_uq; повтор — комментарий.
// Пользователям без ib.work задачи не ставятся: тогда задача без ответственного.
import type { Prisma } from '@prisma/client';
import type { Db } from '../../lib/db.js';
import { systemItemId, TITLE_MAX } from '../tasks/service.js';

export type EvidenceTaskReason = 'rejected' | 'expiring';

const IB_WORK = { roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } } as const;

export interface EvidenceTaskInput {
  evidenceId: string;
  reason: EvidenceTaskReason;
  /** Кому поставить: загрузивший (отклонение) или ответственный (срок действия). */
  userId: string;
  /** Метка, если пользователь без доступа к ИБ: «Загрузивший», «Ответственный за доказательство». */
  label: string;
  title: string;
  description: string;
  repeatComment: string;
  due: string;
  eventId?: string;
}

export async function evidenceTask(tx: Db, input: EvidenceTaskInput): Promise<{ taskId: string; action: 'created' | 'commented' }> {
  const ev = await tx.evidence.findUniqueOrThrow({ where: { id: input.evidenceId }, select: { number: true } });
  const user = await tx.user.findFirst({ where: { id: input.userId, isActive: true, ...IB_WORK }, select: { id: true } });
  const assigneeId = user?.id ?? null;
  const open = await tx.task.findFirst({
    where: { evidenceId: input.evidenceId, evidenceReason: input.reason, assigneeId, completedAt: null, archivedAt: null, deletedAt: null },
    select: { id: true, number: true },
  });
  if (open) {
    await tx.taskComment.create({ data: { taskId: open.id, eventId: input.eventId ?? null, body: input.repeatComment.slice(0, 4000) } });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'task.commented', entity: 'task', entityId: open.id,
        diff: { summary: `Задача #${open.number}: ${input.repeatComment.slice(0, 200)}`, after: { evidenceId: input.evidenceId } } as Prisma.InputJsonValue,
      },
    });
    return { taskId: open.id, action: 'commented' };
  }
  const task = await tx.task.create({
    data: {
      title: input.title.slice(0, TITLE_MAX),
      description: input.description.slice(0, 20_000),
      statusId: await systemItemId(tx, 'task_statuses', 'new'),
      priorityId: await systemItemId(tx, 'task_priorities', 'normal'),
      categoryId: await systemItemId(tx, 'task_categories', 'evidence'),
      assigneeId,
      dueDate: new Date(`${input.due}T00:00:00Z`),
      source: 'evidence',
      evidenceId: input.evidenceId,
      evidenceReason: input.reason,
      recipientLabel: assigneeId ? null : input.label,
    },
    select: { id: true, number: true },
  });
  await tx.auditLog.create({
    data: {
      userId: null, action: 'task.created', entity: 'task', entityId: task.id,
      diff: {
        summary: `Задача #${task.number} создана по доказательству #${ev.number}${assigneeId ? '' : ` (${input.label} без доступа к ИБ — ответственный не назначен)`}`,
        after: { source: 'evidence', evidenceId: input.evidenceId, reason: input.reason, eventId: input.eventId ?? null },
      } as Prisma.InputJsonValue,
    },
  });
  return { taskId: task.id, action: 'created' };
}

/** Закрыть открытые задачи доказательств (новый файл к отклонённому, принятие новой формы вместо истекающей). */
export async function closeEvidenceTasks(tx: Db, evidenceIds: readonly string[], reason: EvidenceTaskReason, comment: string): Promise<number> {
  if (!evidenceIds.length) return 0;
  const open = await tx.task.findMany({
    where: { evidenceId: { in: [...evidenceIds] }, evidenceReason: reason, completedAt: null, archivedAt: null, deletedAt: null },
    select: { id: true, number: true },
  });
  if (!open.length) return 0;
  const done = await systemItemId(tx, 'task_statuses', 'done');
  const now = new Date();
  for (const t of open) {
    await tx.task.update({ where: { id: t.id }, data: { statusId: done, completedAt: now, version: { increment: 1 } } });
    await tx.taskComment.create({ data: { taskId: t.id, body: `${comment}. Задача закрыта автоматически` } });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'task.updated', entity: 'task', entityId: t.id,
        diff: { summary: `Задача #${t.number} закрыта: ${comment}`, after: { changes: [{ label: 'Статус', from: 'открыта', to: 'Готово' }] } } as Prisma.InputJsonValue,
      },
    });
  }
  return open.length;
}
