// Процесс задач по кнопкам (релиз 1.2.0, этап Б2, ADR-0022). Каждое действие проверяет backend:
//   take   — Backlog → Поставленные, исполнитель — я (любой с ib.work);
//   start  — Поставленные → В работе (только исполнитель);
//   submit — В работе → На проверке (только исполнитель);
//   accept — На проверке → Выполнено, return — На проверке → В работе: tasks.review, не исполнитель,
//            и автор задачи, или старший над исполнителем, или у исполнителя нет руководителя.
// Комментарий обязателен по признаку колонки, а не по коду действия.
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, versionConflict } from '../../lib/errors.js';
import { subordinateIdsOf } from '../../lib/hierarchy.js';
import { todayIso } from '../../lib/today.js';
import { notifyStep } from '../notifications/service.js';
import { auditSettings, ensureVersioned } from '../settings/common.js';
import { commentRequired, recordTransition, statusIdOf, type StatusKey, type TaskActor } from './flow.js';
import { assertActive, assertAssignee, COMMENT_MAX, getTaskRow, toTaskDto, type TaskDto } from './service.js';

export const PROCESS_ACTIONS = ['take', 'start', 'submit', 'accept', 'return'] as const;
export type ProcessAction = (typeof PROCESS_ACTIONS)[number];

const RULES: Record<ProcessAction, { from: StatusKey; to: StatusKey; label: string }> = {
  take: { from: 'new', to: 'assigned', label: 'Взять себе' },
  start: { from: 'assigned', to: 'work', label: 'Взять в работу' },
  submit: { from: 'work', to: 'review', label: 'Отправить на проверку' },
  accept: { from: 'review', to: 'done', label: 'Принять' },
  return: { from: 'review', to: 'work', label: 'Вернуть в работу' },
};

interface ReviewFacts {
  /** Подчинённые проверяющего на всех уровнях. */
  subordinates: ReadonlySet<string>;
  /** Исполнители без руководителя: их задачи принимает любой с tasks.review. */
  managerless: ReadonlySet<string>;
}

type TaskFacts = { assigneeId: string | null; creatorId: string | null };

/** Почему проверяющий не может принять или вернуть задачу; null — может. */
function reviewDenied(actor: TaskActor, t: TaskFacts, f: ReviewFacts): AppError | null {
  if (t.assigneeId === actor.id) return conflict('OWN_TASK', 'Свою задачу нельзя принять или вернуть: это делает автор задачи или руководитель');
  if (!actor.perms.has('tasks.review')) return new AppError(403, 'NO_REVIEW', 'Принимать задачи может пользователь с правом «Задачи: проверка»');
  if (t.creatorId === actor.id || t.assigneeId === null || f.subordinates.has(t.assigneeId) || f.managerless.has(t.assigneeId)) return null;
  return new AppError(403, 'NOT_REVIEWER', 'Принять может автор задачи или руководитель исполнителя');
}

async function reviewFacts(db: Db, actor: TaskActor, assigneeIds: readonly (string | null)[]): Promise<ReviewFacts> {
  if (!actor.perms.has('tasks.review')) return { subordinates: new Set(), managerless: new Set() };
  const ids = [...new Set(assigneeIds.filter((x): x is string => x !== null))];
  const [subordinates, managerless] = await Promise.all([
    subordinateIdsOf(db, actor.id),
    ids.length ? db.user.findMany({ where: { id: { in: ids }, managerId: null }, select: { id: true } }) : [],
  ]);
  return { subordinates: new Set(subordinates), managerless: new Set(managerless.map((u) => u.id)) };
}

function allowed(actor: TaskActor, t: TaskDto, f: ReviewFacts): ProcessAction[] {
  if (t.archived) return [];
  const key = t.status.systemKey;
  const mine = t.assignee?.id === actor.id;
  const out: ProcessAction[] = [];
  if (key === 'new' && !t.assignee) out.push('take');
  if (key === 'assigned' && mine) out.push('start');
  if (key === 'work' && mine) out.push('submit');
  if (key === 'review' && !reviewDenied(actor, { assigneeId: t.assignee?.id ?? null, creatorId: t.createdBy?.id ?? null }, f)) out.push('accept', 'return');
  return out;
}

/** Задачи с кнопками, доступными этому пользователю: доска и карточка показывают только их. */
export async function withActions<T extends TaskDto>(db: Db, actor: TaskActor, tasks: readonly T[]): Promise<(T & { actions: ProcessAction[] })[]> {
  const reviewable = tasks.filter((t) => t.status.systemKey === 'review');
  const facts = await reviewFacts(db, actor, reviewable.map((t) => t.assignee?.id ?? null));
  return tasks.map((t) => ({ ...t, actions: allowed(actor, t, facts) }));
}

export async function runAction(db: Db, actor: TaskActor, id: string, action: ProcessAction, input: { version: number; comment?: string }) {
  return withTx(db, async (tx) => {
    const t = await getTaskRow(tx, id);
    assertActive(t);
    if (t.version !== input.version) throw versionConflict();
    const rule = RULES[action];
    if (t.status.systemKey !== rule.from) {
      const from = await tx.catalogItem.findUniqueOrThrow({ where: { id: await statusIdOf(tx, rule.from) }, select: { value: true } });
      throw conflict('WRONG_STATUS', `«${rule.label}» — только для задачи в колонке «${from.value}». Обновите карточку`);
    }
    if (action === 'take') {
      if (t.assigneeId) throw conflict('HAS_ASSIGNEE', 'У задачи уже есть исполнитель. Обновите карточку');
      await assertAssignee(tx, actor.id);
    } else if (action === 'start' || action === 'submit') {
      if (t.assigneeId !== actor.id) throw new AppError(403, 'NOT_ASSIGNEE', `«${rule.label}» может только исполнитель задачи`);
    } else {
      const denied = reviewDenied(actor, { assigneeId: t.assigneeId, creatorId: t.createdBy }, await reviewFacts(tx, actor, [t.assigneeId]));
      if (denied) throw denied;
    }

    const to = await statusIdOf(tx, rule.to);
    const comment = (input.comment ?? '').trim();
    if (comment.length > COMMENT_MAX) throw badRequest('TOO_LONG', `Комментарий — не длиннее ${COMMENT_MAX} символов`);
    if (!comment && await commentRequired(tx, t.statusId, to)) throw badRequest('COMMENT_REQUIRED', `Для «${rule.label}» нужен комментарий`);

    const res = await tx.task.updateMany({
      where: { id, version: input.version, deletedAt: null },
      data: {
        statusId: to, version: { increment: 1 },
        ...(action === 'take' ? { assigneeId: actor.id } : {}),
        ...(action === 'accept' ? { completedAt: new Date() } : {}),
      },
    });
    await ensureVersioned(res.count, () => tx.task.findFirst({ where: { id, deletedAt: null } }), 'Задача');
    await recordTransition(tx, { taskId: id, from: t.statusId, to, actorId: actor.id, kind: 'process', comment });
    const toName = (await tx.catalogItem.findUniqueOrThrow({ where: { id: to }, select: { value: true } })).value;
    const changes = [{ field: 'statusId', label: 'Статус', from: t.status.value, to: toName }];
    if (action === 'take') {
      const me = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { fullName: true } });
      changes.push({ field: 'assigneeId', label: 'Ответственный', from: '—', to: me.fullName });
    }
    if (action === 'submit' || action === 'return' || action === 'accept') {
      await notifyStep(tx, { id, number: t.number, title: t.title, assigneeId: t.assigneeId, createdBy: t.createdBy }, action, actor.id, comment);
    }
    await auditSettings(tx, actor, {
      action: 'task.transition', entity: 'task', entityId: id,
      summary: `Задача #${t.number}: «${rule.label}» («${t.status.value}» → «${toName}»)`,
      after: { action, changes },
    });
    return toTaskDto(await getTaskRow(tx, id), todayIso());
  });
}
