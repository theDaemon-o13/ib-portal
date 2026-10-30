// Проверяющий по задаче (релиз 1.4.0, ADR-0028). Фиксируется при отправке «На проверке» (process.ts, service.ts);
// здесь — замена: вручную («Заменить проверяющего», tasks.status.override) и при отключении проверяющего —
// следующий по цепочке руководителей исполнителя. Каждая замена — переход «На проверке» → «На проверке»
// с reviewer_id (task_transitions только пополняется), запись в журнале и уведомление новому проверяющему.
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, versionConflict } from '../../lib/errors.js';
import { reviewerFor } from '../../lib/hierarchy.js';
import { todayIso } from '../../lib/today.js';
import { notifyReviewer } from '../notifications/service.js';
import { auditSettings, ensureVersioned, type Actor } from '../settings/common.js';
import { recordTransition, type TaskActor } from './flow.js';
import { assertActive, assertAssignee, COMMENT_MAX, getTaskRow, toTaskDto } from './service.js';

/** «Заменить проверяющего»: задача «На проверке», новый — активный сотрудник ИБ, не исполнитель. */
export async function replaceReviewer(db: Db, actor: TaskActor, id: string, input: { version: number; reviewerId: string; comment?: string }) {
  if (!actor.perms.has('tasks.status.override')) {
    throw new AppError(403, 'NO_OVERRIDE', 'Заменить проверяющего может пользователь с правом «Задачи: свободная смена статуса»');
  }
  return withTx(db, async (tx) => {
    const t = await getTaskRow(tx, id);
    assertActive(t);
    if (t.version !== input.version) throw versionConflict();
    if (t.status.systemKey !== 'review') throw conflict('WRONG_STATUS', `Проверяющего меняют у задачи «На проверке», а она в «${t.status.value}». Обновите карточку`);
    if (input.reviewerId === t.assigneeId) throw conflict('OWN_TASK', 'Исполнитель не проверяет свою задачу');
    if (input.reviewerId === t.reviewerId) throw conflict('SAME_REVIEWER', 'Этот сотрудник уже проверяет задачу');
    await assertAssignee(tx, input.reviewerId).catch(() => {
      throw badRequest('BAD_REVIEWER', 'Проверяющим может быть только активный сотрудник с доступом к разделам ИБ');
    });
    const comment = (input.comment ?? '').trim();
    if (comment.length > COMMENT_MAX) throw badRequest('TOO_LONG', `Комментарий — не длиннее ${COMMENT_MAX} символов`);
    const next = await tx.user.findUniqueOrThrow({ where: { id: input.reviewerId }, select: { id: true, fullName: true } });
    const res = await tx.task.updateMany({ where: { id, version: input.version, deletedAt: null }, data: { reviewerId: next.id, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.task.findFirst({ where: { id, deletedAt: null } }), 'Задача');
    await recordTransition(tx, { taskId: id, from: t.statusId, to: t.statusId, actorId: actor.id, kind: 'override', comment, reviewerId: next.id });
    const prev = t.reviewer?.fullName ?? '—';
    await auditSettings(tx, actor, {
      action: 'task.reviewer_replaced', entity: 'task', entityId: id,
      summary: `Задача #${t.number}: проверяющий заменён (${prev} → ${next.fullName})`,
      after: { reason: 'manual', changes: [{ field: 'reviewerId', label: 'Проверяющий', from: prev, to: next.fullName }] },
    });
    await notifyReviewer(tx, t, next.id, actor.id, comment || `проверяющий заменён (был: ${prev})`);
    return toTaskDto(await getTaskRow(tx, id), todayIso());
  });
}

/**
 * Проверяющего отключили (users.setActive, в той же транзакции, после отключения): его задачи «На проверке» переходят
 * к следующему по цепочке исполнителя. Никого выше нет — проверяющий снимается, задача проверяется по правилам до 1.4.0
 * (tasks.review), пока держатель tasks.status.override не назначит проверяющего. Возвращает число задач.
 */
export async function reassignReviewsOf(tx: Db, actor: Actor, userId: string, userName: string): Promise<number> {
  const tasks = await tx.task.findMany({
    where: { reviewerId: userId, deletedAt: null, completedAt: null, status: { systemKey: 'review' } },
    select: { id: true, number: true, title: true, statusId: true, assigneeId: true },
  });
  for (const t of tasks) {
    const next = t.assigneeId ? await reviewerFor(tx, t.assigneeId) : null;
    await tx.task.update({ where: { id: t.id }, data: { reviewerId: next?.id ?? null, version: { increment: 1 } } });
    await recordTransition(tx, {
      taskId: t.id, from: t.statusId, to: t.statusId, actorId: actor.id, kind: 'system', reviewerId: next?.id ?? null,
      comment: next ? '' : `Проверяющий ${userName} отключён, выше по цепочке никого: назначьте проверяющего`,
    });
    await auditSettings(tx, actor, {
      action: 'task.reviewer_replaced', entity: 'task', entityId: t.id,
      summary: `Задача #${t.number}: проверяющий заменён — ${userName} отключён${next ? ` → ${next.fullName}` : ', выше по цепочке никого'}`,
      after: { reason: 'disabled', changes: [{ field: 'reviewerId', label: 'Проверяющий', from: userName, to: next?.fullName ?? '—' }] },
    });
    if (next) await notifyReviewer(tx, t, next.id, actor.id, `проверяющий заменён: ${userName} отключён`);
  }
  return tasks.length;
}
