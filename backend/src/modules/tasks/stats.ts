// Отчёт по выполненным задачам (1.6.4): цифры, иллюстрации и список — как работал сотрудник. Право tasks.report.
// Выполненная задача — completed_at в периоде (дата по часовому поясу банка). Архивные — только с «С архивом»: задачу
// прежнего ответственного портал отправляет в архив (1.6.4, ADR-0034), это не его работа.
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { conflict } from '../../lib/errors.js';
import { appTimeZone, daysBetween, todayIso } from '../../lib/today.js';
import { stepDates } from './report.js';

export const STATS_LIMIT = 5000;

export interface TaskStatsFilter {
  /** Период выполнения YYYY-MM-DD включительно. */
  from: string;
  to: string;
  assigneeId?: string;
  categoryId?: string;
  /** Только выполненные позже срока. */
  late?: boolean;
  archived?: boolean;
}

/** Кто закрыл: принял проверяющий, исполнитель сам (без проверки), система (документ ушёл дальше), смена статуса в обход процесса. */
export type ClosedHow = 'accepted' | 'self' | 'system' | 'override';

interface Row {
  id: string; number: number; title: string; category_id: string; category: string; color: string | null;
  assignee_id: string | null; assignee: string | null; due: string | null; created_at: Date; completed_at: Date;
}

/** Понедельник недели даты YYYY-MM-DD. */
export function weekStart(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - shift * 86_400_000).toISOString().slice(0, 10);
}

const avg = (xs: readonly number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

export async function taskStats(db: Db, f: TaskStatsFilter) {
  const tz = appTimeZone();
  const day = (d: Date) => todayIso(d, tz);
  const parts: Prisma.Sql[] = [
    Prisma.sql`t.deleted_at IS NULL`, Prisma.sql`t.completed_at IS NOT NULL`,
    Prisma.sql`(t.completed_at AT TIME ZONE ${tz})::date BETWEEN ${f.from}::date AND ${f.to}::date`,
  ];
  if (!f.archived) parts.push(Prisma.sql`t.archived_at IS NULL`);
  if (f.assigneeId) parts.push(Prisma.sql`t.assignee_id = ${f.assigneeId}::uuid`);
  if (f.categoryId) parts.push(Prisma.sql`t.category_id = ${f.categoryId}::uuid`);
  if (f.late) parts.push(Prisma.sql`t.due_date < (t.completed_at AT TIME ZONE ${tz})::date`);
  const where = Prisma.join(parts, ' AND ');
  const [count] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM tasks t WHERE ${where}`;
  const total = Number(count?.n ?? 0);
  if (total > STATS_LIMIT) throw conflict('TOO_MANY_ROWS', `За период выполнено ${total.toLocaleString('ru-RU')} задач — отчёт не больше ${STATS_LIMIT.toLocaleString('ru-RU')}. Сузьте период`);
  const rows = await db.$queryRaw<Row[]>`
    SELECT t.id::text, t.number, t.title, c.id::text AS category_id, c.value AS category, c.color,
           t.assignee_id::text, u.full_name AS assignee, to_char(t.due_date, 'YYYY-MM-DD') AS due, t.created_at, t.completed_at
    FROM tasks t JOIN catalog_items c ON c.id = t.category_id LEFT JOIN users u ON u.id = t.assignee_id
    WHERE ${where} ORDER BY t.completed_at DESC, t.number DESC`;
  const ids = rows.map((r) => r.id);
  const steps = await stepDates(db, ids);
  const closers = ids.length ? await db.$queryRaw<{ task_id: string; actor_id: string | null; actor: string | null; kind: string }[]>`
    SELECT DISTINCT ON (tr.task_id) tr.task_id::text, tr.actor_id::text, u.full_name AS actor, tr.kind
    FROM task_transitions tr JOIN catalog_items s ON s.id = tr.to_status_id LEFT JOIN users u ON u.id = tr.actor_id
    WHERE tr.task_id = ANY(${ids}::uuid[]) AND s.system_key = 'done'
    ORDER BY tr.task_id, tr.at DESC` : [];
  const closerOf = new Map(closers.map((c) => [c.task_id, c]));

  const items = rows.map((r) => {
    const done = day(r.completed_at);
    const started = steps.get(r.id)?.work ?? null;
    const c = closerOf.get(r.id);
    const how: ClosedHow = !c || c.kind === 'system' || !c.actor_id ? 'system' : c.kind === 'override' ? 'override' : c.actor_id === r.assignee_id ? 'self' : 'accepted';
    return {
      id: r.id, number: r.number, title: r.title,
      category: { id: r.category_id, value: r.category, color: r.color },
      assignee: r.assignee_id ? { id: r.assignee_id, fullName: r.assignee ?? '' } : null,
      createdAt: day(r.created_at),
      /** Первый вход в «В работе»; нет — пусто (закрыта сразу или до 1.2.0 без журнала). */
      startedAt: started ? day(started) : null,
      completedAt: done,
      dueDate: r.due,
      /** Дней опоздания относительно срока; 0 — в срок, null — без срока. */
      lateDays: r.due ? Math.max(0, daysBetween(r.due, done)) : null,
      /** Календарных дней от взятия в работу (нет — от создания) до выполнения. */
      leadDays: Math.max(0, daysBetween(started ? day(started) : day(r.created_at), done)),
      closedBy: { how, fullName: how === 'system' ? null : c?.actor ?? null },
    };
  });
  const late = items.filter((i) => (i.lateDays ?? 0) > 0);
  const weeks = new Map<string, { week: string; onTime: number; late: number }>();
  for (let w = weekStart(f.from); w <= f.to; w = new Date(Date.parse(`${w}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)) {
    weeks.set(w, { week: w, onTime: 0, late: 0 });
  }
  const people = new Map<string, { id: string | null; fullName: string; done: number; onTime: number; late: number; lead: number[] }>();
  const categories = new Map<string, { id: string; value: string; color: string | null; done: number }>();
  for (const i of items) {
    const isLate = (i.lateDays ?? 0) > 0;
    const w = weeks.get(weekStart(i.completedAt));
    if (w) { if (isLate) w.late++; else w.onTime++; }
    const key = i.assignee?.id ?? '';
    const p = people.get(key) ?? { id: i.assignee?.id ?? null, fullName: i.assignee?.fullName ?? 'Без исполнителя', done: 0, onTime: 0, late: 0, lead: [] };
    p.done++;
    if (isLate) p.late++; else p.onTime++;
    p.lead.push(i.leadDays);
    people.set(key, p);
    const cat = categories.get(i.category.id) ?? { ...i.category, done: 0 };
    cat.done++;
    categories.set(i.category.id, cat);
  }
  return {
    summary: {
      done: items.length,
      onTime: items.length - late.length,
      late: late.length,
      /** Среднее опоздание среди опоздавших, дней. */
      avgLateDays: avg(late.map((i) => i.lateDays ?? 0)),
      avgLeadDays: avg(items.map((i) => i.leadDays)),
    },
    weeks: [...weeks.values()],
    byAssignee: [...people.values()].map(({ lead, ...p }) => ({ ...p, avgLeadDays: avg(lead) })).sort((a, b) => b.done - a.done || a.fullName.localeCompare(b.fullName, 'ru')),
    byCategory: [...categories.values()].sort((a, b) => b.done - a.done),
    items,
  };
}
