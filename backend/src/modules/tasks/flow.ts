// Процесс задач (релиз 1.2.0, ADR-0022): колонка по исполнителю и запись переходов в task_transitions.
// Переходы только пополняются; комментарий перехода — ещё и строкой в комментариях задачи (его видят все, кто видит задачу).
import type { Db } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import type { Actor } from '../settings/common.js';

export type TransitionKind = 'process' | 'override' | 'assign' | 'system' | 'migration';

export const STATUS_KEYS = ['new', 'assigned', 'work', 'review', 'done'] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];

export async function statusIdOf(db: Db, key: StatusKey): Promise<string> {
  const item = await db.catalogItem.findUnique({ where: { catalogCode_systemKey: { catalogCode: 'task_statuses', systemKey: key } }, select: { id: true } });
  if (!item) throw new Error(`нет системной колонки задач «${key}» — выполните seed`);
  return item.id;
}

/** Новая задача: с исполнителем — «Поставленные», без — Backlog. */
export async function initialStatusId(db: Db, assigneeId: string | null | undefined): Promise<string> {
  return statusIdOf(db, assigneeId ? 'assigned' : 'new');
}

export interface TransitionInput {
  taskId: string;
  /** null — задача создана сразу в колонке to. */
  from: string | null;
  to: string;
  /** null — система. */
  actorId: string | null;
  kind: TransitionKind;
  comment?: string;
  /** Проверяющий, зафиксированный переходом (отправка на проверку, замена проверяющего; релиз 1.4.0). */
  reviewerId?: string | null;
}

export async function recordTransition(db: Db, t: TransitionInput): Promise<string> {
  const comment = (t.comment ?? '').trim();
  const row = await db.taskTransition.create({
    data: { taskId: t.taskId, fromStatusId: t.from, toStatusId: t.to, actorId: t.actorId, kind: t.kind, comment, reviewerId: t.reviewerId ?? null },
    select: { id: true },
  });
  if (comment) await db.taskComment.create({ data: { taskId: t.taskId, authorId: t.actorId, transitionId: row.id, body: comment } });
  return row.id;
}

// ---------------------------------------------------------------- права процесса (этап Б2)

/** Пользователь с правами из сессии: процесс задач проверяет tasks.assign, tasks.status.override (tasks.review — только задачи до 1.4.0). */
export type TaskActor = Actor & { perms: ReadonlySet<string> };

export const NO_ASSIGN_MESSAGE = 'Ставить задачи другим может пользователь с правом «Задачи: постановка другим». Назначьте себя или оставьте без исполнителя';

/**
 * Смена исполнителя. Без tasks.assign: себя — на задачу без исполнителя; снять себя — пока задача не взята в работу
 * (в «Поставленные»). Остальное — только с правом.
 */
export function assertCanAssign(actor: TaskActor, from: string | null, to: string | null, statusKey: string | null) {
  if (from === to || actor.perms.has('tasks.assign')) return;
  if (from === null && to === actor.id) return;
  if (to === null && from === actor.id) {
    if (statusKey === 'assigned') return;
    throw new AppError(403, 'TASK_TAKEN', 'Снять себя можно, пока задача не взята в работу. Дальше исполнителя меняет пользователь с правом «Задачи: постановка другим»');
  }
  throw new AppError(403, 'NO_ASSIGN', NO_ASSIGN_MESSAGE);
}

/** Комментарий обязателен по признаку колонки (ADR-0022): вперёд — comment_forward, возврат — comment_return. */
export async function commentRequired(db: Db, fromId: string, toId: string): Promise<boolean> {
  const items = await db.catalogItem.findMany({ where: { id: { in: [fromId, toId] } }, select: { id: true, sortOrder: true, commentForward: true, commentReturn: true } });
  const from = items.find((i) => i.id === fromId);
  const to = items.find((i) => i.id === toId);
  if (!from || !to || fromId === toId) return false;
  return to.sortOrder > from.sortOrder ? to.commentForward : to.commentReturn;
}
