// Индикаторы «ждёт вашего действия» (релиз 1.4.0, решение владельца 1): одна выборка для меню и колокольчика.
//   tasks     — задачи «На проверке», которые проверяю я: проверяющий — я (ADR-0028), и задачи до 1.4.0 без проверяющего,
//               которые я могу принять по прежним правилам (tasks.review) — то же, что кнопка «Принять» в карточке;
//   documents — документы «ждут вас» (как в реестре документов);
//   total     — сумма: число на колокольчике.
// Просроченное отдела и «Доказательства на проверке» сюда не входят: это не действие конкретного пользователя.
import type { Db } from '../../lib/db.js';
import { todayIso } from '../../lib/today.js';
import { accessOf, documentSummary } from '../documents/service.js';
import { serviceActionsUnread } from '../notifications/service.js';
import type { TaskActor } from '../tasks/flow.js';
import { withActions } from '../tasks/process.js';
import { taskInclude, toTaskDto } from '../tasks/service.js';

const OPEN_REVIEW = { deletedAt: null, archivedAt: null, completedAt: null, status: { systemKey: 'review' } } as const;

/** Задачи на проверке, которые ждут этого пользователя. Без ib.work — 0 (раздел «Задачи» ему не виден). */
export async function tasksWaiting(db: Db, actor: TaskActor): Promise<number> {
  if (!actor.perms.has('ib.work')) return 0;
  const mine = await db.task.count({ where: { ...OPEN_REVIEW, reviewerId: actor.id } });
  // До 1.4.0 без проверяющего: принять может держатель tasks.review по прежним правилам (process.ts решает сам).
  if (!actor.perms.has('tasks.review')) return mine;
  const legacy = await db.task.findMany({ where: { ...OPEN_REVIEW, reviewerId: null, assigneeId: { not: null } }, include: taskInclude });
  if (!legacy.length) return mine;
  const today = todayIso();
  const withButtons = await withActions(db, actor, legacy.map((t) => toTaskDto(t, today)));
  return mine + withButtons.filter((t) => t.actions.includes('accept')).length;
}

export async function attentionOf(db: Db, actor: TaskActor) {
  const [tasks, docs, audit] = await Promise.all([
    tasksWaiting(db, actor),
    documentSummary(db, await accessOf(db, actor.id)),
    // Действия служебного администратора с доступом (ADR-0036) — только держателям audit.view.
    actor.perms.has('audit.view') ? serviceActionsUnread(db, actor.id) : Promise.resolve(0),
  ]);
  return { tasks, documents: docs.waitingForMe, audit, total: tasks + docs.waitingForMe + audit };
}
