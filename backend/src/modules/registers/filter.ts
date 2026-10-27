// Фильтр записей реестра (этап 8): список записей, KPI и виджеты дашборда считают по одному коду,
// поэтому число на дашборде совпадает с total списка по его ссылке.
//   state=open|closed            — открытые / закрытые (по значению статуса с признаком «закрывает запись»)
//   deadline=overdue,soon,…      — контроль сроков (в памяти: срок может быть вычисляемым, календарь РТ)
//   f=<id поля>:<v1>,<v2>        — значение списка, справочника, сотрудника или решения ∈ {…}; empty — не заполнено
//   date=<id поля>&from=&to=     — дата поля в интервале (включительно), ГГГГ-ММ-ДД
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { isScoreRule, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import {
  calendarFor,
  dateOf,
  deadlineField,
  deadlineState,
  isClosed,
  type DeadlineState,
  type FieldMeta,
  type RegisterDef,
} from './definition.js';

export const DEADLINE_STATES = ['overdue', 'soon', 'ok', 'closed', 'none'] as const satisfies readonly DeadlineState[];
/** Значение фильтра «поле не заполнено» (для решения — «решения нет»). */
export const EMPTY_VALUE = 'empty';
const FILTER_TYPES = new Set(['select', 'catalog', 'user', 'decision']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RecordFilter {
  state?: 'open' | 'closed';
  deadline?: DeadlineState[];
  field?: { fieldId: string; values: string[] };
  date?: { fieldId: string; from?: string; to?: string };
}

/** Параметры фильтра в адресе — общие для GET /registers/:id/records и ссылок дашборда. */
export const RecordFilterQuery = z.object({
  state: z.enum(['open', 'closed']).optional(),
  deadline: z.string().max(64).optional(),
  f: z.string().max(2000).optional(),
  date: z.string().uuid().optional(),
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
});
export type RecordFilterParams = z.infer<typeof RecordFilterQuery>;

function fieldOf(reg: RegisterDef, id: string, what: string): FieldMeta {
  const f = reg.fields.find((x) => x.id === id);
  if (!f) throw badRequest('BAD_FILTER', `Фильтр: поле не найдено (${what}). Обновите страницу`);
  return f;
}

/** Разбор и проверка параметров адреса: неизвестное поле или значение — 400, а не пустой список. */
export function parseRecordFilter(reg: RegisterDef, q: RecordFilterParams): RecordFilter {
  const out: RecordFilter = {};
  if (q.state) out.state = q.state;
  if (q.deadline) {
    const states = q.deadline.split(',').map((s) => s.trim()).filter(Boolean);
    if (!states.length || states.some((s) => !(DEADLINE_STATES as readonly string[]).includes(s))) {
      throw badRequest('BAD_FILTER', 'Фильтр по срокам: overdue, soon, ok, closed или none');
    }
    if (!deadlineField(reg)) throw badRequest('BAD_FILTER', 'В реестре нет поля с контролем сроков');
    out.deadline = [...new Set(states)] as DeadlineState[];
  }
  if (q.f) {
    const sep = q.f.indexOf(':');
    const fieldId = sep > 0 ? q.f.slice(0, sep) : '';
    const values = sep > 0 ? q.f.slice(sep + 1).split(',').map((v) => v.trim()).filter(Boolean) : [];
    if (!z.string().uuid().safeParse(fieldId).success || !values.length || values.length > 50) {
      throw badRequest('BAD_FILTER', 'Фильтр по полю: f=<id поля>:<значение>,<значение>');
    }
    const f = fieldOf(reg, fieldId, 'значение');
    if (!FILTER_TYPES.has(f.type)) throw badRequest('BAD_FILTER', `По полю «${f.label}» фильтр по значению недоступен`);
    for (const v of values) {
      if (v !== EMPTY_VALUE && !z.string().uuid().safeParse(v).success) throw badRequest('BAD_FILTER', `Фильтр по полю «${f.label}»: неизвестное значение`);
    }
    out.field = { fieldId, values: [...new Set(values)] };
  }
  if (q.date || q.from || q.to) {
    if (!q.date) throw badRequest('BAD_FILTER', 'Фильтр по дате: укажите поле (date=<id поля>)');
    const f = fieldOf(reg, q.date, 'дата');
    if (f.type !== 'date' && !(f.type === 'calc' && f.calcRule && !isScoreRule(f.calcRule))) {
      throw badRequest('BAD_FILTER', `«${f.label}» — не дата`);
    }
    if (q.from && q.to && q.from > q.to) throw badRequest('BAD_FILTER', 'Фильтр по дате: «с» позже «по»');
    out.date = { fieldId: f.id, from: q.from, to: q.to };
  }
  return out;
}

/** Фильтр в адрес (обратно к parseRecordFilter): ссылки дашборда и мониторинга. */
export function filterToParams(filter: RecordFilter): Record<string, string> {
  const p: Record<string, string> = {};
  if (filter.state) p.state = filter.state;
  if (filter.deadline?.length) p.deadline = filter.deadline.join(',');
  if (filter.field) p.f = `${filter.field.fieldId}:${filter.field.values.join(',')}`;
  if (filter.date) {
    p.date = filter.date.fieldId;
    if (filter.date.from) p.from = filter.date.from;
    if (filter.date.to) p.to = filter.date.to;
  }
  return p;
}

/** Ссылка на реестр с фильтром: /registers?…#<id>/records (адрес реестра — в хеше, см. RegistersPage). */
export function registerLink(registerId: string, filter: RecordFilter = {}): string {
  const qs = new URLSearchParams(filterToParams(filter)).toString();
  return `/registers${qs ? `?${qs}` : ''}#${registerId}/records`;
}

/** Закрыта ли запись — тем же правилом, что isClosed(): значение статуса с is_closed (неудалённое). */
export function closedSql(reg: RegisterDef): Prisma.Sql {
  const status = reg.fields.find((f) => f.isStatus);
  if (!status) return Prisma.sql`false`;
  return Prisma.sql`EXISTS (SELECT 1 FROM register_field_options o
    WHERE o.field_id = ${status.id}::uuid AND o.is_closed AND o.deleted_at IS NULL AND o.id::text = r."values" ->> ${status.id})`;
}

/** Последнее решение по полю «решение другого отдела»; без решения — первый действующий вариант («Ожидает решения»). */
export function decisionSql(field: FieldMeta): Prisma.Sql {
  const first = field.options.find((o) => !o.archived)?.id ?? null;
  return Prisma.sql`COALESCE((SELECT d.option_id::text FROM register_decisions d
    WHERE d.record_id = r.id AND d.field_id = ${field.id}::uuid ORDER BY d.decided_at DESC LIMIT 1), ${first}::text)`;
}

/** Значение поля записи для фильтра и группировки (решение — последнее, без решения — «Ожидает решения»). */
export function fieldValueSql(field: FieldMeta): Prisma.Sql {
  return field.type === 'decision' ? decisionSql(field) : Prisma.sql`r."values" ->> ${field.id}`;
}

/** Условия, которые выражаются в SQL (таблица register_records с псевдонимом r). */
export function filterSql(reg: RegisterDef, filter: RecordFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (filter.state === 'open') parts.push(Prisma.sql`NOT ${closedSql(reg)}`);
  if (filter.state === 'closed') parts.push(closedSql(reg));
  if (filter.field) {
    const f = reg.fields.find((x) => x.id === filter.field?.fieldId) as FieldMeta;
    const ids = filter.field.values.filter((v) => v !== EMPTY_VALUE);
    const wantsEmpty = filter.field.values.includes(EMPTY_VALUE);
    const value = fieldValueSql(f);
    const conds: Prisma.Sql[] = [];
    if (ids.length) conds.push(Prisma.sql`${value} = ANY(${ids}::text[])`);
    if (wantsEmpty) conds.push(Prisma.sql`${value} IS NULL`);
    parts.push(Prisma.sql`(${Prisma.join(conds, ' OR ')})`);
  }
  if (filter.date) {
    const f = reg.fields.find((x) => x.id === filter.date?.fieldId) as FieldMeta;
    if (f.type === 'date') {
      // Даты хранятся строкой ГГГГ-ММ-ДД: сравнение строк = сравнение дат.
      parts.push(Prisma.sql`r."values" ? ${f.id}`);
      if (filter.date.from) parts.push(Prisma.sql`r."values" ->> ${f.id} >= ${filter.date.from}`);
      if (filter.date.to) parts.push(Prisma.sql`r."values" ->> ${f.id} <= ${filter.date.to}`);
    }
  }
  return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
}

/**
 * Условия, которые считаются в памяти: контроль сроков и вычисляемая дата (календарь РТ).
 * null — фильтровать в памяти нечего.
 */
export async function filterInMemory(db: Db, reg: RegisterDef, filter: RecordFilter): Promise<((values: Values) => boolean) | null> {
  const dateField = filter.date ? (reg.fields.find((x) => x.id === filter.date?.fieldId) as FieldMeta) : null;
  const calcDate = dateField && dateField.type === 'calc' ? dateField : null;
  if (!filter.deadline?.length && !calcDate) return null;
  const calendar = await calendarFor(db, reg);
  const today = todayIso();
  const dl = deadlineField(reg);
  const wanted = new Set(filter.deadline ?? []);
  return (values) => {
    if (wanted.size && dl) {
      const state = deadlineState(dateOf(reg, dl, values, calendar), isClosed(reg, values), today).state;
      if (!wanted.has(state)) return false;
    }
    if (calcDate && filter.date) {
      const d = dateOf(reg, calcDate, values, calendar);
      if (!d) return false;
      if (filter.date.from && d < filter.date.from) return false;
      if (filter.date.to && d > filter.date.to) return false;
    }
    return true;
  };
}

/** Базовое условие: записи реестра, не удалённые и (по умолчанию) не в архиве. */
export function baseSql(registerId: string, includeArchived = false): Prisma.Sql {
  return Prisma.sql`r.register_id = ${registerId}::uuid AND r.deleted_at IS NULL
    ${includeArchived ? Prisma.empty : Prisma.sql`AND r.archived_at IS NULL`}`;
}

/** Число действующих записей по фильтру — KPI, плитки и виджеты дашборда. Тот же код, что у total списка. */
export async function countRecords(db: Db, reg: RegisterDef, filter: RecordFilter): Promise<number> {
  const where = Prisma.sql`${baseSql(reg.id)} ${filterSql(reg, filter)}`;
  const post = await filterInMemory(db, reg, filter);
  if (!post) {
    const [row] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM register_records r WHERE ${where}`;
    return Number(row?.n ?? 0);
  }
  const rows = await db.$queryRaw<{ values: Values }[]>`SELECT r."values" FROM register_records r WHERE ${where}`;
  return rows.filter((r) => post(r.values)).length;
}
