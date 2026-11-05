// Задачи модуля писем, кроме задач рассылки по расписанию (1.9.0; docs/specs/awareness.md, разделы 19.5–19.6).
// Все — source = 'manual' без автора, категория «Осведомлённость» (вариант A); связь — в таблицах модуля:
// awareness_letters.task_id (срочная рассылка, письмо из задачи рассылки), awareness_letter_events.task_id (доработка).
// Вызываются в транзакции действия с письмом.
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import type { Db } from '../../lib/db.js';
import { todayIso } from '../../lib/today.js';
import { addWorkingDays, isoDate, parseIsoDate } from '../../lib/working-days.js';
import { workUsersWhere } from '../../lib/work-users.js';
import { loadFullWorkCalendar } from '../calendar/service.js';
import { notifyAssignee } from '../notifications/service.js';
import type { Actor } from '../settings/common.js';
import { initialStatusId, recordTransition } from '../tasks/flow.js';
import { systemItemId, TITLE_MAX } from '../tasks/service.js';
import { AWARENESS_CATEGORY_KEY } from './definition.js';

/** Срок задачи доработки письма не из расписания и срочной рассылки — рабочих дней. */
export const REWORK_WORKDAYS = 3;
export const URGENT_WORKDAYS = 1;

const ru = (iso: string) => iso.split('-').reverse().join('.');

async function workdaysFromToday(tx: Db, n: number, now: Date): Promise<string> {
  return isoDate(addWorkingDays(parseIsoDate(todayIso(now)), n, await loadFullWorkCalendar(tx)));
}

interface ModuleTaskInput {
  title: string;
  description: string;
  assigneeId: string | null;
  recipientLabel?: string;
  due: string;
  priority: 'normal' | 'high';
  /** Кто действовал (уведомление «назначена задача» — не ему); null — система. */
  actorId: string | null;
  summary: string;
  after: Record<string, unknown>;
}

async function createModuleTask(tx: Db, input: ModuleTaskInput): Promise<{ id: string; number: number }> {
  const title = input.title.slice(0, TITLE_MAX);
  const task = await tx.task.create({
    data: {
      title,
      description: input.description.slice(0, 20_000),
      statusId: await initialStatusId(tx, input.assigneeId),
      priorityId: await systemItemId(tx, 'task_priorities', input.priority),
      categoryId: await systemItemId(tx, 'task_categories', AWARENESS_CATEGORY_KEY),
      assigneeId: input.assigneeId,
      dueDate: new Date(`${input.due}T00:00:00Z`),
      source: 'manual',
      createdBy: null,
      recipientLabel: input.assigneeId ? null : (input.recipientLabel ?? null),
    },
    select: { id: true, number: true, statusId: true },
  });
  await recordTransition(tx, { taskId: task.id, from: null, to: task.statusId, actorId: null, kind: 'system' });
  await notifyAssignee(tx, { id: task.id, number: task.number, title }, null, input.assigneeId, input.actorId);
  await tx.auditLog.create({
    data: {
      userId: input.actorId, action: 'task.created', entity: 'task', entityId: task.id,
      diff: { summary: `Задача #${task.number} ${input.summary}`, after: { source: 'manual', ...input.after } } as Prisma.InputJsonValue,
    },
  });
  return { id: task.id, number: task.number };
}

/**
 * «Срочная рассылка»: задача «Срочная рассылка: <название>» нажавшему — срок 1 рабочий день, приоритет «Высокий».
 * Письмо создаёт вызывающий и ставит ему task_id.
 */
export async function createUrgentTask(tx: Db, actor: Actor, input: { title: string; reason: string; letterNumber: number }, now = new Date()) {
  const due = await workdaysFromToday(tx, URGENT_WORKDAYS, now);
  return createModuleTask(tx, {
    title: `Срочная рассылка: ${input.title}`,
    description: `Повод: ${input.reason}\n\nУчебное письмо № ${input.letterNumber}. Срочное письмо можно отметить отправленным без согласования — с причиной.`,
    assigneeId: actor.id,
    due,
    priority: 'high',
    actorId: actor.id,
    summary: `создана срочной рассылкой (письмо № ${input.letterNumber})`,
    after: { letterNumber: input.letterNumber, dueDate: due },
  });
}

/**
 * Кому задача доработки: исполнитель задачи письма (рассылки или срочной), если он участвует в работе; иначе автор
 * письма; иначе — без исполнителя с меткой «Автор письма». У черновика из расписания автор — создатель правила,
 * а работает над письмом исполнитель задачи.
 */
async function reworkAssignee(tx: Db, letter: { createdBy: string; taskId: string | null }): Promise<string | null> {
  const ids = [
    ...(letter.taskId ? [(await tx.task.findUnique({ where: { id: letter.taskId }, select: { assigneeId: true } }))?.assigneeId] : []),
    letter.createdBy,
  ].filter((x): x is string => !!x);
  for (const id of ids) {
    if (await tx.user.findFirst({ where: { AND: [{ id }, workUsersWhere()] }, select: { id: true } })) return id;
  }
  return null;
}

/**
 * «Доработать письмо: <название>» после возврата. Срок — дата отправки по запуску, если письмо из расписания,
 * иначе 3 рабочих дня. В описании — комментарий начальника ИБ.
 */
export async function createReworkTask(
  tx: Db, actor: Actor, letter: { id: string; number: number; title: string; createdBy: string; taskId: string | null }, comment: string, now = new Date(),
) {
  const run = await tx.awarenessScheduleRun.findFirst({
    where: { OR: [{ letterId: letter.id }, ...(letter.taskId ? [{ taskId: letter.taskId }] : [])] },
    select: { plannedDate: true },
  });
  const due = run ? isoDate(run.plannedDate) : await workdaysFromToday(tx, REWORK_WORKDAYS, now);
  const assigneeId = await reworkAssignee(tx, letter);
  return createModuleTask(tx, {
    title: `Доработать письмо: ${letter.title}`,
    description: `Начальник ИБ вернул учебное письмо № ${letter.number} на доработку:\n\n${comment}\n\nПосле правки отправьте письмо на согласование снова.${run ? ` Срок отправки по расписанию — ${ru(due)}.` : ''}`,
    assigneeId,
    recipientLabel: 'Автор письма',
    due,
    priority: 'normal',
    actorId: actor.id,
    summary: `создана возвратом письма № ${letter.number} на доработку`,
    after: { letterNumber: letter.number, dueDate: due },
  });
}

/** История задачи письма: «Письмо № N отмечено отправленным ДД.ММ.ГГГГ» (задачу отметка не закрывает). */
export async function noteTaskSent(tx: Db, actor: Actor, letter: { number: number; taskId: string | null }, sentOn: string, repeat: boolean) {
  if (!letter.taskId) return;
  const task = await tx.task.findUnique({ where: { id: letter.taskId }, select: { number: true, deletedAt: true } });
  if (!task || task.deletedAt) return;
  await tx.auditLog.create({
    data: {
      userId: actor.id, action: 'task.awareness_sent', entity: 'task', entityId: letter.taskId, ip: actor.ip,
      diff: {
        summary: `Задача #${task.number}: письмо № ${letter.number} отмечено отправленным${repeat ? ' ещё раз' : ''} ${ru(sentOn)}`,
        after: { letterNumber: letter.number, sentOn, repeat },
      } as Prisma.InputJsonValue,
    },
  });
}

/**
 * «Создать письмо» из задачи рассылки без черновика: задача — расписания, не удалена и не выполнена, письма у
 * запуска ещё нет. Возвращает запуск — вызывающий ставит письму task_id и запуску letter_id.
 */
export async function runForNewLetter(tx: Db, taskId: string): Promise<{ id: string; taskId: string }> {
  const run = await tx.awarenessScheduleRun.findUnique({
    where: { taskId },
    select: { id: true, taskId: true, letterId: true, task: { select: { number: true, completedAt: true, deletedAt: true } } },
  });
  if (!run || run.task.deletedAt) throw new AppError(404, 'NOT_FOUND', 'Задача рассылки не найдена');
  if (run.letterId) throw new AppError(409, 'TASK_HAS_LETTER', `У задачи #${run.task.number} уже есть письмо`);
  if (run.task.completedAt) throw new AppError(409, 'TASK_DONE', `Задача #${run.task.number} выполнена — письмо к ней не создаётся`);
  return { id: run.id, taskId: run.taskId };
}
