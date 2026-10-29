// Процесс задач (релиз 1.2.0, ADR-0022): колонка по исполнителю и запись переходов в task_transitions.
// Переходы только пополняются; комментарий перехода — ещё и строкой в комментариях задачи (его видят все, кто видит задачу).
import type { Db } from '../../lib/db.js';

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
}

export async function recordTransition(db: Db, t: TransitionInput): Promise<string> {
  const comment = (t.comment ?? '').trim();
  const row = await db.taskTransition.create({
    data: { taskId: t.taskId, fromStatusId: t.from, toStatusId: t.to, actorId: t.actorId, kind: t.kind, comment },
    select: { id: true },
  });
  if (comment) await db.taskComment.create({ data: { taskId: t.taskId, authorId: t.actorId, transitionId: row.id, body: comment } });
  return row.id;
}
