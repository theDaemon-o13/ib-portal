// Производственный календарь РТ: выходные дни недели и отклонения (праздники, переносы).
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import {
  DEFAULT_WEEKEND_DAYS,
  isoDate,
  parseIsoDate,
  type CalendarDayKind,
  type WorkCalendar,
} from '../../lib/working-days.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';

const WEEKDAY_NAMES = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const KIND_NAMES: Record<CalendarDayKind, string> = { holiday: 'праздник', workday: 'рабочий день (перенос)' };

export interface CalendarDayDto {
  id: string;
  day: string;
  kind: CalendarDayKind;
  title: string;
  version: number;
}

const toDto = (r: { id: string; day: Date; kind: string; title: string; version: number }): CalendarDayDto => ({
  id: r.id,
  day: isoDate(r.day),
  kind: r.kind as CalendarDayKind,
  title: r.title,
  version: r.version,
});

export async function getWorkWeek(db: Db): Promise<{ weekendDays: number[]; version: number }> {
  const row = await db.appSetting.findUnique({ where: { key: 'work_week' } });
  const value = row?.value as { weekendDays?: number[] } | undefined;
  return { weekendDays: value?.weekendDays ?? [...DEFAULT_WEEKEND_DAYS], version: row?.version ?? 0 };
}

export async function setWorkWeek(db: Db, actor: Actor, input: { weekendDays: number[]; version: number }) {
  const days = [...new Set(input.weekendDays)].sort();
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw badRequest('BAD_WEEKDAY', 'Дни недели — от 1 (пн) до 7 (вс)');
  if (days.length > 6) throw badRequest('NO_WORKDAYS', 'В неделе должен остаться хотя бы один рабочий день');
  return withTx(db, async (tx) => {
    const current = await getWorkWeek(tx);
    if (current.version !== input.version) throw versionConflict();
    const value = { weekendDays: days } as Prisma.InputJsonValue;
    await tx.appSetting.upsert({
      where: { key: 'work_week' },
      create: { key: 'work_week', value },
      update: { value, version: { increment: 1 } },
    });
    const names = (ds: number[]) => (ds.length ? ds.map((d) => WEEKDAY_NAMES[d]).join(', ') : 'нет');
    await auditSettings(tx, actor, {
      action: 'calendar.week.updated',
      entity: 'work_week',
      entityId: 'work_week',
      summary: `Производственный календарь: выходные дни недели ${names(current.weekendDays)} → ${names(days)}`,
      before: { weekendDays: current.weekendDays },
      after: { weekendDays: days },
    });
    return getWorkWeek(tx);
  });
}

export async function listDays(db: Db, year: number): Promise<CalendarDayDto[]> {
  const rows = await db.workCalendarDay.findMany({
    where: { deletedAt: null, day: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
    orderBy: { day: 'asc' },
  });
  return rows.map(toDto);
}

/**
 * Весь календарь (праздники и переносы — десятки строк в год): для сроков реестров,
 * где даты записей разбросаны по годам.
 */
export async function loadFullWorkCalendar(db: Db): Promise<WorkCalendar> {
  const [week, rows] = await Promise.all([getWorkWeek(db), db.workCalendarDay.findMany({ where: { deletedAt: null } })]);
  return { weekendDays: week.weekendDays, days: new Map(rows.map((r) => [isoDate(r.day), r.kind as CalendarDayKind])) };
}

/** Календарь для расчёта рабочих дней (п. 7.4, разбор почты) на интервал дат. */
export async function loadWorkCalendar(db: Db, from: Date, to: Date): Promise<WorkCalendar> {
  const [week, rows] = await Promise.all([
    getWorkWeek(db),
    db.workCalendarDay.findMany({ where: { deletedAt: null, day: { gte: from, lte: to } } }),
  ]);
  return { weekendDays: week.weekendDays, days: new Map(rows.map((r) => [isoDate(r.day), r.kind as CalendarDayKind])) };
}

function parseDay(s: string): Date {
  try {
    return parseIsoDate(s);
  } catch {
    throw badRequest('BAD_DATE', 'Неверная дата');
  }
}

async function assertFree(db: Db, day: Date, exceptId?: string) {
  const clash = await db.workCalendarDay.findFirst({
    where: { day, deletedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (clash) throw conflict('DUPLICATE', `На ${isoDate(day)} уже есть запись: «${clash.title}»`);
}

export async function createDay(db: Db, actor: Actor, input: { day: string; kind: CalendarDayKind; title: string }) {
  const day = parseDay(input.day);
  const title = trimmed(input.title);
  if (!title) throw badRequest('EMPTY_TITLE', 'Укажите название');
  return withTx(db, async (tx) => {
    await assertFree(tx, day);
    const row = await tx.workCalendarDay.create({ data: { day, kind: input.kind, title } });
    await auditSettings(tx, actor, {
      action: 'calendar.day.created',
      entity: 'calendar_day',
      entityId: row.id,
      summary: `Производственный календарь: ${isoDate(day)} — ${KIND_NAMES[input.kind]} «${title}»`,
      after: { day: isoDate(day), kind: input.kind, title },
    });
    return toDto(row);
  });
}

export async function updateDay(
  db: Db,
  actor: Actor,
  id: string,
  input: { version: number; day?: string; kind?: CalendarDayKind; title?: string },
) {
  return withTx(db, async (tx) => {
    const current = await tx.workCalendarDay.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw notFound('Запись календаря');
    const data: Prisma.WorkCalendarDayUpdateManyMutationInput = {};
    if (input.day !== undefined) {
      const day = parseDay(input.day);
      if (isoDate(day) !== isoDate(current.day)) {
        await assertFree(tx, day, id);
        data.day = day;
      }
    }
    if (input.kind !== undefined && input.kind !== current.kind) data.kind = input.kind;
    if (input.title !== undefined) {
      const title = trimmed(input.title);
      if (!title) throw badRequest('EMPTY_TITLE', 'Укажите название');
      if (title !== current.title) data.title = title;
    }
    if (Object.keys(data).length === 0) {
      if (input.version !== current.version) throw versionConflict();
      return toDto(current);
    }
    const res = await tx.workCalendarDay.updateMany({
      where: { id, version: input.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.workCalendarDay.findFirst({ where: { id, deletedAt: null } }), 'Запись календаря');
    const fresh = await tx.workCalendarDay.findUniqueOrThrow({ where: { id } });
    await auditSettings(tx, actor, {
      action: 'calendar.day.updated',
      entity: 'calendar_day',
      entityId: id,
      summary: `Производственный календарь: изменено ${isoDate(current.day)} «${current.title}» → ${isoDate(fresh.day)} «${fresh.title}» (${KIND_NAMES[fresh.kind as CalendarDayKind]})`,
      before: { day: isoDate(current.day), kind: current.kind, title: current.title },
      after: { day: isoDate(fresh.day), kind: fresh.kind, title: fresh.title },
    });
    return toDto(fresh);
  });
}

export async function deleteDay(db: Db, actor: Actor, id: string, version: number) {
  await withTx(db, async (tx) => {
    const current = await tx.workCalendarDay.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw notFound('Запись календаря');
    const res = await tx.workCalendarDay.updateMany({
      where: { id, version, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.workCalendarDay.findFirst({ where: { id, deletedAt: null } }), 'Запись календаря');
    await auditSettings(tx, actor, {
      action: 'calendar.day.deleted',
      entity: 'calendar_day',
      entityId: id,
      summary: `Производственный календарь: удалено ${isoDate(current.day)} «${current.title}»`,
      before: { day: isoDate(current.day), kind: current.kind, title: current.title },
    });
  });
}
