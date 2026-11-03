// Процесс задач по кнопкам (релиз 1.2.0, этап Б2, ADR-0022). Каждое действие проверяет backend:
//   take   — Backlog → Поставленные, исполнитель — я (любой с ib.work);
//   start  — Поставленные → В работе (только исполнитель);
//   submit — В работе → На проверке (только исполнитель, у которого есть проверяющий; релиз 1.4.0);
//   complete — В работе → Выполнено (только исполнитель без проверяющего: «Завершить», релиз 1.4.0);
//   accept — На проверке → Выполнено, return — На проверке → В работе: только проверяющий задачи (ADR-0028).
//            Задачи, отправленные до 1.4.0 без проверяющего, — по прежним правилам: tasks.review, не исполнитель,
//            и автор задачи, или старший над исполнителем, или у исполнителя нет руководителя.
// Комментарий обязателен по признаку колонки, а не по коду действия.
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, versionConflict } from '../../lib/errors.js';
import { reviewerFor, subordinateIdsOf } from '../../lib/hierarchy.js';
import { todayIso } from '../../lib/today.js';
import { notifyStep } from '../notifications/service.js';
import { auditSettings, ensureVersioned } from '../settings/common.js';
import { assertCandidate, commentRequired, recordTransition, statusIdOf, type StatusKey, type TaskActor } from './flow.js';
import { assertActive, assertAssignee, COMMENT_MAX, getTaskRow, toTaskDto, type TaskDto } from './service.js';

export const PROCESS_ACTIONS = ['take', 'start', 'submit', 'complete', 'accept', 'return'] as const;
export type ProcessAction = (typeof PROCESS_ACTIONS)[number];

const RULES: Record<ProcessAction, { from: StatusKey; to: StatusKey; label: string }> = {
  take: { from: 'new', to: 'assigned', label: 'Взять себе' },
  start: { from: 'assigned', to: 'work', label: 'Взять в работу' },
  submit: { from: 'work', to: 'review', label: 'Отправить на проверку' },
  complete: { from: 'work', to: 'done', label: 'Завершить' },
  accept: { from: 'review', to: 'done', label: 'Принять' },
  return: { from: 'review', to: 'work', label: 'Вернуть в работу' },
};

interface ReviewFacts {
  /** Есть ли проверяющий у самого пользователя: его задачи «В работе» — «Отправить на проверку» или «Завершить». */
  mineReviewed: boolean;
  /** Задачи до 1.4.0 без проверяющего — подчинённые пользователя на всех уровнях. */
  subordinates: ReadonlySet<string>;
  /** Исполнители без руководителя: их задачи принимает любой с tasks.review. */
  managerless: ReadonlySet<string>;
}

type TaskFacts = { assigneeId: string | null; creatorId: string | null; reviewer: { id: string; fullName: string } | null };

/** Почему пользователь не может принять или вернуть задачу; null — может. */
function reviewDenied(actor: TaskActor, t: TaskFacts, f: ReviewFacts): AppError | null {
  if (t.assigneeId === actor.id) return conflict('OWN_TASK', 'Свою задачу нельзя принять или вернуть: это делает проверяющий');
  if (t.reviewer) return t.reviewer.id === actor.id ? null : new AppError(403, 'NOT_REVIEWER', `Принять или вернуть задачу может только проверяющий: ${t.reviewer.fullName}`);
  if (!actor.perms.has('tasks.review')) return new AppError(403, 'NO_REVIEW', 'Принимать задачи может пользователь с правом «Задачи: проверка»');
  if (t.creatorId === actor.id || t.assigneeId === null || f.subordinates.has(t.assigneeId) || f.managerless.has(t.assigneeId)) return null;
  return new AppError(403, 'NOT_REVIEWER', 'Принять может автор задачи или руководитель исполнителя');
}

/** legacy — исполнители задач «На проверке» без проверяющего (до 1.4.0); mine — есть ли задачи пользователя «В работе». */
async function reviewFacts(db: Db, actor: TaskActor, legacy: readonly (string | null)[], mine: boolean): Promise<ReviewFacts> {
  const mineReviewed = mine && (await reviewerFor(db, actor.id)) !== null;
  if (!legacy.length || !actor.perms.has('tasks.review')) return { mineReviewed, subordinates: new Set(), managerless: new Set() };
  const ids = [...new Set(legacy.filter((x): x is string => x !== null))];
  const [subordinates, managerless] = await Promise.all([
    subordinateIdsOf(db, actor.id),
    ids.length ? db.user.findMany({ where: { id: { in: ids }, managerId: null }, select: { id: true } }) : [],
  ]);
  return { mineReviewed, subordinates: new Set(subordinates), managerless: new Set(managerless.map((u) => u.id)) };
}

function allowed(actor: TaskActor, t: TaskDto, f: ReviewFacts): ProcessAction[] {
  if (t.archived) return [];
  const key = t.status.systemKey;
  const mine = t.assignee?.id === actor.id;
  const out: ProcessAction[] = [];
  if (key === 'new' && !t.assignee && (!t.candidates.length || t.candidates.some((c) => c.id === actor.id))) out.push('take');
  if (key === 'assigned' && mine) out.push('start');
  if (key === 'work' && mine) out.push(f.mineReviewed ? 'submit' : 'complete');
  if (key === 'review' && !reviewDenied(actor, { assigneeId: t.assignee?.id ?? null, creatorId: t.createdBy?.id ?? null, reviewer: t.reviewer }, f)) out.push('accept', 'return');
  return out;
}

/** Задачи с кнопками, доступными этому пользователю: доска и карточка показывают только их. */
export async function withActions<T extends TaskDto>(db: Db, actor: TaskActor, tasks: readonly T[]): Promise<(T & { actions: ProcessAction[] })[]> {
  const legacy = tasks.filter((t) => t.status.systemKey === 'review' && !t.reviewer && !t.archived);
  const mine = tasks.some((t) => t.status.systemKey === 'work' && t.assignee?.id === actor.id && !t.archived);
  const facts = await reviewFacts(db, actor, legacy.map((t) => t.assignee?.id ?? null), mine);
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
      assertCandidate(actor.id, t.candidates.map((c) => c.user.id));
      await assertAssignee(tx, actor.id);
    } else if (action === 'start' || action === 'submit' || action === 'complete') {
      if (t.assigneeId !== actor.id) throw new AppError(403, 'NOT_ASSIGNEE', `«${rule.label}» может только исполнитель задачи`);
    } else {
      const reviewer = t.reviewerId ? t.reviewer : null;
      const denied = reviewDenied(actor, { assigneeId: t.assigneeId, creatorId: t.createdBy, reviewer }, await reviewFacts(tx, actor, reviewer ? [] : [t.assigneeId], false));
      if (denied) throw denied;
    }
    // Проверяющий — ближний активный руководитель исполнителя, фиксируется при отправке (ADR-0028).
    let reviewer: { id: string; fullName: string } | null = null;
    if (action === 'submit' || action === 'complete') {
      reviewer = await reviewerFor(tx, actor.id);
      if (action === 'submit' && !reviewer) throw conflict('NO_REVIEWER', 'Проверять некому: у вас нет руководителя. Завершите задачу сами — «Завершить»');
      if (action === 'complete' && reviewer) throw conflict('REVIEW_REQUIRED', `Задачу проверяет руководитель (${reviewer.fullName}): отправьте её на проверку`);
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
        ...(action === 'accept' || action === 'complete' ? { completedAt: new Date() } : {}),
        // Проверяющий есть только у задачи «На проверке»: отправка ставит, принятие и возврат снимают.
        reviewerId: reviewer?.id ?? null,
      },
    });
    await ensureVersioned(res.count, () => tx.task.findFirst({ where: { id, deletedAt: null } }), 'Задача');
    await recordTransition(tx, { taskId: id, from: t.statusId, to, actorId: actor.id, kind: 'process', comment, reviewerId: reviewer?.id ?? null });
    const toName = (await tx.catalogItem.findUniqueOrThrow({ where: { id: to }, select: { value: true } })).value;
    const changes = [{ field: 'statusId', label: 'Статус', from: t.status.value, to: toName }];
    if (action === 'take') {
      const me = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { fullName: true } });
      changes.push({ field: 'assigneeId', label: 'Ответственный', from: '—', to: me.fullName });
    }
    if (action === 'submit' && reviewer) changes.push({ field: 'reviewerId', label: 'Проверяющий', from: '—', to: reviewer.fullName });
    if (action === 'submit' || action === 'complete' || action === 'return' || action === 'accept') {
      await notifyStep(tx, { id, number: t.number, title: t.title, assigneeId: t.assigneeId, createdBy: t.createdBy, reviewerId: action === 'submit' ? reviewer?.id ?? null : null }, action, actor.id, comment);
    }
    await auditSettings(tx, actor, {
      action: 'task.transition', entity: 'task', entityId: id,
      summary: `Задача #${t.number}: «${rule.label}» («${t.status.value}» → «${toName}»${action === 'submit' && reviewer ? ` → ${reviewer.fullName}` : ''})`,
      after: { action, changes },
    });
    return toTaskDto(await getTaskRow(tx, id), todayIso());
  });
}
