// Отчёт по задачам в Excel (релиз 1.2.0, этап Б4, ADR-0022), право tasks.report.
// Фильтры: период (по дате создания, сроку или выполнению), исполнитель, автор, категория, колонка, только просроченные, с архивом.
// Даты переходов — первый вход в колонку по task_transitions; для задач до 1.2.0 — из журнала аудита (только чтение).
import ExcelJS from 'exceljs';
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { conflict } from '../../lib/errors.js';
import { appTimeZone, daysBetween, todayIso } from '../../lib/today.js';
import type { Actor } from '../settings/common.js';

export const REPORT_LIMIT = 100_000;
export const REPORT_PERIODS = ['created', 'due', 'completed'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];
const PERIOD_LABEL: Record<ReportPeriod, string> = { created: 'по дате создания', due: 'по сроку', completed: 'по дате выполнения' };

export interface TaskReportFilter {
  period?: ReportPeriod;
  /** Даты YYYY-MM-DD включительно, по часовому поясу банка. */
  from?: string;
  to?: string;
  assigneeId?: string;
  creatorId?: string;
  categoryId?: string;
  statusId?: string;
  /** Просрочка больше нуля: открытые со сроком в прошлом и выполненные позже срока. */
  overdue?: boolean;
  /** С задачами из архива. */
  archived?: boolean;
}

/** Названия колонок 1.1.0 по умолчанию: журнал до обновления записывал статус текстом. */
const LEGACY_NAMES: Record<string, string> = { 'Новые': 'new', 'Готово': 'done' };
const STEPS = ['assigned', 'work', 'review'] as const;
type Step = (typeof STEPS)[number];

function whereSql(f: TaskReportFilter, today: string, tz: string): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`t.deleted_at IS NULL`];
  if (!f.archived) parts.push(Prisma.sql`t.archived_at IS NULL`);
  const col = f.period === 'due' ? Prisma.sql`t.due_date`
    : f.period === 'completed' ? Prisma.sql`(t.completed_at AT TIME ZONE ${tz})::date`
      : Prisma.sql`(t.created_at AT TIME ZONE ${tz})::date`;
  if (f.from) parts.push(Prisma.sql`${col} >= ${f.from}::date`);
  if (f.to) parts.push(Prisma.sql`${col} <= ${f.to}::date`);
  if (f.assigneeId) parts.push(Prisma.sql`t.assignee_id = ${f.assigneeId}::uuid`);
  if (f.creatorId) parts.push(Prisma.sql`t.created_by = ${f.creatorId}::uuid`);
  if (f.categoryId) parts.push(Prisma.sql`t.category_id = ${f.categoryId}::uuid`);
  if (f.statusId) parts.push(Prisma.sql`t.status_id = ${f.statusId}::uuid`);
  if (f.overdue) parts.push(Prisma.sql`t.due_date < COALESCE((t.completed_at AT TIME ZONE ${tz})::date, ${today}::date)`);
  return Prisma.join(parts, ' AND ');
}

interface Row {
  id: string; number: number; title: string; category: string; status: string; author: string | null; assignee: string | null;
  due: string | null; created_at: Date; completed_at: Date | null; archived: boolean;
}

export interface ReportLine {
  number: number; title: string; category: string; author: string; assignee: string; due: string | null; status: string;
  created: string; assigned: string | null; work: string | null; review: string | null; done: string | null;
  /** Дней просрочки на сегодня (открытая) или на дату выполнения; 0 — в срок или без срока. */
  overdueDays: number; archived: boolean;
}

/** Строки отчёта по фильтру. Больше limit — отказ с числом: «Сузьте период», без молчаливой обрезки. */
export async function taskReport(db: Db, f: TaskReportFilter, limit = REPORT_LIMIT, now = new Date()): Promise<ReportLine[]> {
  const tz = appTimeZone();
  const today = todayIso(now, tz);
  const where = whereSql(f, today, tz);
  const [count] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM tasks t WHERE ${where}`;
  const total = Number(count?.n ?? 0);
  if (total > limit) {
    throw conflict('TOO_MANY_ROWS', `По фильтру ${total.toLocaleString('ru-RU')} задач — отчёт не больше ${limit.toLocaleString('ru-RU')}. Сузьте период`);
  }
  const rows = await db.$queryRaw<Row[]>`
    SELECT t.id::text, t.number, t.title, c.value AS category, s.value AS status, au.full_name AS author, ass.full_name AS assignee,
           to_char(t.due_date, 'YYYY-MM-DD') AS due, t.created_at, t.completed_at, t.archived_at IS NOT NULL AS archived
    FROM tasks t
    JOIN catalog_items c ON c.id = t.category_id
    JOIN catalog_items s ON s.id = t.status_id
    LEFT JOIN users au ON au.id = t.created_by
    LEFT JOIN users ass ON ass.id = t.assignee_id
    WHERE ${where}
    ORDER BY t.number`;
  const steps = await stepDates(db, rows.map((r) => r.id));
  const day = (d: Date) => todayIso(d, tz);
  return rows.map((r) => {
    const done = r.completed_at ? day(r.completed_at) : null;
    const s = steps.get(r.id);
    return {
      number: r.number, title: r.title, category: r.category, author: r.author ?? 'Система', assignee: r.assignee ?? '', due: r.due, status: r.status,
      created: day(r.created_at), assigned: s?.assigned ? day(s.assigned) : null, work: s?.work ? day(s.work) : null, review: s?.review ? day(s.review) : null,
      done, overdueDays: r.due ? Math.max(0, daysBetween(r.due, done ?? today)) : 0, archived: r.archived,
    };
  });
}

/** Первый вход задачи в «Поставленные», «В работе», «На проверке»: переходы 1.2.0 и журнал до 1.2.0 — что раньше. */
async function stepDates(db: Db, ids: readonly string[]): Promise<Map<string, Partial<Record<Step, Date>>>> {
  const out = new Map<string, Partial<Record<Step, Date>>>();
  if (!ids.length) return out;
  const put = (id: string, key: string | null | undefined, at: Date) => {
    if (!key || !(STEPS as readonly string[]).includes(key)) return;
    const m = out.get(id) ?? {};
    const k = key as Step;
    if (!m[k] || at < m[k]) m[k] = at;
    out.set(id, m);
  };
  // Перенос при обновлении (migration) — не настоящий вход в колонку, в отчёт не идёт.
  const transitions = await db.$queryRaw<{ task_id: string; key: string | null; at: Date }[]>`
    SELECT tr.task_id::text, s.system_key AS key, min(tr.at) AS at
    FROM task_transitions tr JOIN catalog_items s ON s.id = tr.to_status_id
    WHERE tr.task_id::text = ANY(${[...ids]}::text[]) AND tr.kind <> 'migration'
    GROUP BY 1, 2`;
  for (const t of transitions) put(t.task_id, t.key, t.at);

  // До 1.2.0 смена статуса — task.updated с изменением «Статус» (название колонки на тот момент).
  const statuses = await db.catalogItem.findMany({ where: { catalogCode: 'task_statuses' }, select: { value: true, systemKey: true } });
  const keyOf = new Map<string, string>(Object.entries(LEGACY_NAMES));
  for (const s of statuses) if (s.systemKey) keyOf.set(s.value, s.systemKey);
  const changes = await db.$queryRaw<{ entity_id: string; to: string; at: Date }[]>`
    SELECT a.entity_id, ch->>'to' AS "to", a.at
    FROM audit_log a, jsonb_array_elements(COALESCE(a.diff->'after'->'changes', '[]'::jsonb)) ch
    WHERE a.entity = 'task' AND a.action = 'task.updated' AND a.entity_id = ANY(${[...ids]}::text[]) AND ch->>'field' = 'statusId'`;
  for (const c of changes) put(c.entity_id, keyOf.get(c.to), c.at);
  return out;
}

const fmt = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');

/** Excel отчёта; выгрузка — в журнал (tasks.report_exported) с фильтром и числом строк. */
export async function exportTaskReport(db: Db, actor: Actor, f: TaskReportFilter): Promise<{ fileName: string; buffer: Buffer }> {
  const lines = await taskReport(db, f);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Задачи');
  ws.columns = [
    { header: '№', key: 'number', width: 8 },
    { header: 'Задача', key: 'title', width: 50 },
    { header: 'Категория', key: 'category', width: 18 },
    { header: 'Автор', key: 'author', width: 26 },
    { header: 'Исполнитель', key: 'assignee', width: 26 },
    { header: 'Срок', key: 'due', width: 12 },
    { header: 'Колонка', key: 'status', width: 16 },
    { header: 'Создана', key: 'created', width: 12 },
    { header: 'Поставлена', key: 'assigned', width: 12 },
    { header: 'Взята в работу', key: 'work', width: 14 },
    { header: 'Отправлена на проверку', key: 'review', width: 14 },
    { header: 'Выполнена', key: 'done', width: 12 },
    { header: 'Просрочка, дней', key: 'overdueDays', width: 12 },
    { header: 'В архиве', key: 'archived', width: 10 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const l of lines) {
    ws.addRow({
      ...l, due: fmt(l.due), created: fmt(l.created), assigned: fmt(l.assigned), work: fmt(l.work), review: fmt(l.review), done: fmt(l.done),
      overdueDays: l.overdueDays || '', archived: l.archived ? 'да' : '',
    });
  }
  const names = await filterNames(db, f);
  const info = wb.addWorksheet('Параметры');
  info.columns = [{ key: 'k', width: 22 }, { key: 'v', width: 60 }];
  for (const [k, v] of [
    ['Сформирован', `${fmt(todayIso())}`],
    ['Период', `${PERIOD_LABEL[f.period ?? 'created']}: ${f.from ? fmt(f.from) : '…'} — ${f.to ? fmt(f.to) : '…'}`],
    ['Исполнитель', names.assignee ?? 'все'], ['Автор', names.creator ?? 'все'], ['Категория', names.category ?? 'все'], ['Колонка', names.status ?? 'все'],
    ['Только просроченные', f.overdue ? 'да' : 'нет'], ['С архивом', f.archived ? 'да' : 'нет'], ['Задач', String(lines.length)],
    ['Даты переходов', 'первый вход в колонку; для задач до релиза 1.2.0 — из журнала, чего в журнале нет — пусто'],
  ] as const) info.addRow({ k, v });
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  await db.auditLog.create({
    data: {
      userId: actor.id, action: 'tasks.report_exported', entity: 'task', entityId: 'report', ip: actor.ip,
      diff: { summary: `Отчёт по задачам выгружен в Excel: ${lines.length} задач`, actorRoles: [...actor.roleNames], filter: { ...f }, rows: lines.length },
    },
  });
  return { fileName: `Отчёт по задачам ${todayIso()}.xlsx`, buffer };
}

async function filterNames(db: Db, f: TaskReportFilter) {
  const user = async (id?: string) => (id ? (await db.user.findUnique({ where: { id }, select: { fullName: true } }))?.fullName ?? id : undefined);
  const item = async (id?: string) => (id ? (await db.catalogItem.findUnique({ where: { id }, select: { value: true } }))?.value ?? id : undefined);
  return { assignee: await user(f.assigneeId), creator: await user(f.creatorId), category: await item(f.categoryId), status: await item(f.statusId) };
}
