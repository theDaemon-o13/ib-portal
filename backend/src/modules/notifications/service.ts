// Уведомления в портале (релиз 1.2.0, этап В, ADR-0023). Видит только адресат.
// Уведомление создаётся в той же транзакции, что и событие: откат события — нет уведомления.
// Общее правило (решение владельца): о собственных действиях пользователь уведомлений не получает; отключённым не пишем.
import type { Db } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { seniorIdsOf } from '../../lib/hierarchy.js';
import { addDaysIso, todayIso } from '../../lib/today.js';

export const NOTIFICATION_KINDS = [
  'task_assigned', 'task_unassigned', 'task_submitted', 'task_returned', 'task_accepted', 'task_moved', 'task_commented',
  'task_due_tomorrow', 'task_overdue',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const READ_KEEP_DAYS = 90;
export const UNREAD_KEEP_DAYS = 180;
export const LIST_LIMIT = 50;
const BODY_MAX = 300;

export interface NotifyInput {
  kind: NotificationKind;
  /** Адресаты; дубли, автор действия и отключённые отсекаются здесь. */
  to: readonly (string | null | undefined)[];
  title: string;
  body?: string;
  taskId?: string;
  /** Кто сделал; null — система. Сам он уведомление не получает. */
  actorId: string | null;
  dedupeKey?: string;
}

const clip = (s: string) => (s.length > BODY_MAX ? `${s.slice(0, BODY_MAX - 1)}…` : s);

/** Создать уведомления; возвращает, сколько записано (дубли по dedupeKey пропускаются). */
export async function notify(db: Db, n: NotifyInput): Promise<number> {
  const ids = [...new Set(n.to.filter((x): x is string => !!x && x !== n.actorId))];
  if (!ids.length) return 0;
  const active = await db.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } });
  if (!active.length) return 0;
  const res = await db.notification.createMany({
    data: active.map((u) => ({
      userId: u.id, kind: n.kind, title: clip(n.title), body: clip((n.body ?? '').trim()),
      taskId: n.taskId ?? null, actorId: n.actorId, dedupeKey: n.dedupeKey ?? null,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

// ---------------------------------------------------------------- события задач

export interface TaskRef { id: string; number: number; title: string }
const label = (t: TaskRef) => `#${t.number} «${t.title}»`;

async function nameOf(db: Db, id: string | null): Promise<string> {
  if (!id) return 'Система';
  return (await db.user.findUnique({ where: { id }, select: { fullName: true } }))?.fullName ?? '—';
}

/** Смена исполнителя: новому — «назначена», прежнему — «снята». Создание с исполнителем — prev = null. */
export async function notifyAssignee(db: Db, t: TaskRef, prev: string | null, next: string | null, actorId: string | null): Promise<void> {
  if (prev === next) return;
  const who = await nameOf(db, actorId);
  if (next) await notify(db, { kind: 'task_assigned', to: [next], taskId: t.id, actorId, title: `Вам назначена задача ${label(t)}`, body: `Назначил: ${who}` });
  if (prev) {
    const nextName = next ? await nameOf(db, next) : 'не назначен';
    await notify(db, { kind: 'task_unassigned', to: [prev], taskId: t.id, actorId, title: `С вас снята задача ${label(t)}`, body: `Исполнитель: ${nextName}. Изменил: ${who}` });
  }
}

/** Пользователи с правом: активные, с доступом к разделам ИБ. */
async function usersWith(db: Db, code: string, among?: readonly string[]): Promise<string[]> {
  const rows = await db.user.findMany({
    where: {
      isActive: true, ...(among ? { id: { in: [...among] } } : {}),
      AND: [code, 'ib.work'].map((c) => ({ roles: { some: { role: { permissions: { some: { permissionCode: c } } } } } })),
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Кто может принять задачу (решение владельца В-4): автор с tasks.review и все старшие над исполнителем с tasks.review;
 * у исполнителя без руководителя — все с tasks.review. Исполнителю — никогда.
 */
export async function reviewersOf(db: Db, assigneeId: string | null, creatorId: string | null): Promise<string[]> {
  const seniors = assigneeId ? await seniorIdsOf(db, assigneeId) : [];
  const out = seniors.length || !assigneeId
    ? await usersWith(db, 'tasks.review', [...seniors, ...(creatorId ? [creatorId] : [])])
    : await usersWith(db, 'tasks.review');
  return out.filter((id) => id !== assigneeId);
}

export async function notifyStep(
  db: Db, t: TaskRef & { assigneeId: string | null; createdBy: string | null },
  action: 'submit' | 'return' | 'accept', actorId: string, comment: string,
): Promise<void> {
  const who = await nameOf(db, actorId);
  const body = comment ? `${who}: ${comment}` : who;
  if (action === 'submit') {
    await notify(db, { kind: 'task_submitted', to: await reviewersOf(db, t.assigneeId, t.createdBy), taskId: t.id, actorId, title: `Задача ${label(t)} ждёт проверки`, body });
  } else if (action === 'return') {
    await notify(db, { kind: 'task_returned', to: [t.assigneeId], taskId: t.id, actorId, title: `Задачу ${label(t)} вернули в работу`, body });
  } else {
    await notify(db, { kind: 'task_accepted', to: [t.assigneeId], taskId: t.id, actorId, title: `Задача ${label(t)} принята`, body });
  }
}

/** Свободная смена статуса — исполнителю: кто перенёс и комментарий (решение В-5). */
export async function notifyMoved(db: Db, t: TaskRef & { assigneeId: string | null }, from: string, to: string, actorId: string, comment: string): Promise<void> {
  const who = await nameOf(db, actorId);
  await notify(db, {
    kind: 'task_moved', to: [t.assigneeId], taskId: t.id, actorId,
    title: `Задачу ${label(t)} перенесли: «${from}» → «${to}»`, body: comment ? `${who}: ${comment}` : `Перенёс: ${who}`,
  });
}

/** Комментарий человека — исполнителю и автору; комментарии автоматизации не уведомляют (решение В-3). */
export async function notifyComment(db: Db, t: TaskRef & { assigneeId: string | null; createdBy: string | null }, actorId: string, text: string): Promise<void> {
  const who = await nameOf(db, actorId);
  await notify(db, { kind: 'task_commented', to: [t.assigneeId, t.createdBy], taskId: t.id, actorId, title: `Комментарий в задаче ${label(t)}`, body: `${who}: ${text}` });
}

// ---------------------------------------------------------------- часовой прогон: сроки и очистка

const fmt = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/**
 * «Срок завтра» — исполнителю (нет исполнителя — автору); «просрочено» — исполнителю и автору (решение В-2).
 * Только открытые задачи на доске. Одно уведомление адресату на задачу и срок: перенос срока — новое.
 */
export async function notifyDeadlines(db: Db, now = new Date()): Promise<{ dueTomorrow: number; overdue: number }> {
  const today = todayIso(now);
  const tomorrow = addDaysIso(today, 1);
  const open = { deletedAt: null, archivedAt: null, completedAt: null } as const;
  const select = { id: true, number: true, title: true, assigneeId: true, createdBy: true, dueDate: true } as const;
  const [soon, late] = await Promise.all([
    db.task.findMany({ where: { ...open, dueDate: new Date(`${tomorrow}T00:00:00Z`) }, select }),
    db.task.findMany({ where: { ...open, dueDate: { lt: new Date(`${today}T00:00:00Z`) } }, select }),
  ]);
  let dueTomorrow = 0;
  let overdue = 0;
  for (const t of soon) {
    dueTomorrow += await notify(db, {
      kind: 'task_due_tomorrow', to: [t.assigneeId ?? t.createdBy], taskId: t.id, actorId: null,
      title: `Срок задачи ${label(t)} — завтра, ${fmt(tomorrow)}`, dedupeKey: `due_tomorrow:${t.id}:${tomorrow}`,
    });
  }
  for (const t of late) {
    const due = t.dueDate?.toISOString().slice(0, 10) ?? today;
    overdue += await notify(db, {
      kind: 'task_overdue', to: [t.assigneeId, t.createdBy], taskId: t.id, actorId: null,
      title: `Задача ${label(t)} просрочена (срок ${fmt(due)})`, dedupeKey: `overdue:${t.id}:${due}`,
    });
  }
  return { dueTomorrow, overdue };
}

const CLEANED_KEY = 'notifications.cleaned_on';

/** Очистка по сроку, не чаще раза в сутки: прочитанные старше 90 дней, непрочитанные старше 180. */
export async function cleanupNotifications(db: Db, now = new Date()): Promise<number | null> {
  const today = todayIso(now);
  const mark = await db.appSetting.findUnique({ where: { key: CLEANED_KEY } });
  if (mark?.value === today) return null;
  const day = 86_400_000;
  const res = await db.notification.deleteMany({
    where: {
      OR: [
        { readAt: { lt: new Date(now.getTime() - READ_KEEP_DAYS * day) } },
        { readAt: null, createdAt: { lt: new Date(now.getTime() - UNREAD_KEEP_DAYS * day) } },
      ],
    },
  });
  await db.appSetting.upsert({ where: { key: CLEANED_KEY }, create: { key: CLEANED_KEY, value: today }, update: { value: today, version: { increment: 1 } } });
  if (res.count > 0) {
    await db.auditLog.create({
      data: {
        userId: null, action: 'notifications.cleaned', entity: 'notification',
        diff: { summary: `Удалены старые уведомления: ${res.count} (прочитанные старше ${READ_KEEP_DAYS} дней, непрочитанные старше ${UNREAD_KEEP_DAYS})`, rows: res.count },
      },
    });
  }
  return res.count;
}

// ---------------------------------------------------------------- API адресата

export async function listNotifications(db: Db, userId: string, q: { unread?: boolean; limit?: number; cursor?: string }) {
  const limit = q.limit ?? LIST_LIMIT;
  const rows = await db.notification.findMany({
    where: { userId, ...(q.unread ? { readAt: null } : {}) },
    include: { actor: { select: { fullName: true } }, task: { select: { id: true, number: true, deletedAt: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map((n) => ({
      id: n.id, kind: n.kind, title: n.title, body: n.body, actor: n.actor?.fullName ?? null,
      createdAt: n.createdAt.toISOString(), read: n.readAt !== null,
      task: n.task ? { id: n.task.id, number: n.task.number, deleted: n.task.deletedAt !== null } : null,
    })),
    nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null,
    unread: await unreadCount(db, userId),
  };
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  return db.notification.count({ where: { userId, readAt: null } });
}

/** Отметить своё уведомление прочитанным; чужое — 404, как несуществующее. */
export async function markRead(db: Db, userId: string, id: string, now = new Date()): Promise<void> {
  const own = await db.notification.findFirst({ where: { id, userId }, select: { readAt: true } });
  if (!own) throw new AppError(404, 'NOT_FOUND', 'Уведомление не найдено');
  if (!own.readAt) await db.notification.update({ where: { id }, data: { readAt: now } });
}

export async function markAllRead(db: Db, userId: string, now = new Date()): Promise<number> {
  return (await db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: now } })).count;
}
