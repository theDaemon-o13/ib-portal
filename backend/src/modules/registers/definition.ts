// Описание реестра и общие операции модуля: загрузка полей, «есть ли данные», поиск, сборка записи.
import { Prisma } from '@prisma/client';
import type { Db } from '../../lib/db.js';
import { conflict, notFound } from '../../lib/errors.js';
import {
  calcValue,
  displayValue,
  isWritable,
  type CalcRule,
  type FieldDef,
  type FieldType,
  type UserRef,
  type Values,
} from '../../lib/register-values.js';

export interface FieldMeta extends FieldDef {
  sortOrder: number;
  analyticsRole: string | null;
  isTitle: boolean;
  isStatus: boolean;
  version: number;
  options: (FieldDef['options'][number] & { sortOrder: number; version: number })[];
}

export interface RegisterDef {
  id: string;
  name: string;
  description: string;
  ownerUserId: string | null;
  archived: boolean;
  version: number;
  /** Все неудалённые поля, включая архивные, по порядку. */
  fields: FieldMeta[];
}

export async function loadRegister(db: Db, id: string): Promise<RegisterDef> {
  const r = await db.register.findUnique({
    where: { id },
    include: {
      fields: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { options: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
      },
    },
  });
  if (!r) throw notFound('Реестр');
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    ownerUserId: r.ownerUserId,
    archived: r.archivedAt !== null,
    version: r.version,
    fields: r.fields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type as FieldType,
      sortOrder: f.sortOrder,
      analyticsRole: f.analyticsRole,
      isTitle: f.isTitle,
      isStatus: f.isStatus,
      calcRule: (f.calcRule as CalcRule | null) ?? null,
      archived: f.archivedAt !== null,
      version: f.version,
      options: f.options.map((o) => ({
        id: o.id, label: o.label, isClosed: o.isClosed, archived: o.archivedAt !== null, sortOrder: o.sortOrder, version: o.version,
      })),
    })),
  };
}

export function assertNotArchived(reg: RegisterDef): void {
  if (reg.archived) throw conflict('REGISTER_ARCHIVED', `Реестр «${reg.name}» в архиве: изменения недоступны`);
}

/** Есть ли у поля данные: значения в неудалённых записях или решения. */
export async function fieldHasData(db: Db, field: { id: string; type: string }): Promise<number> {
  if (field.type === 'calc') return 0;
  if (field.type === 'decision') return db.registerDecision.count({ where: { fieldId: field.id } });
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM register_records
    WHERE deleted_at IS NULL AND "values" ? ${field.id}`;
  return Number(rows[0]?.n ?? 0);
}

/** Сколько неудалённых записей и решений ссылается на вариант списка. */
export async function optionUsage(db: Db, fieldId: string, optionId: string): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM register_records
    WHERE deleted_at IS NULL AND "values" ->> ${fieldId} = ${optionId}`;
  const decisions = await db.registerDecision.count({ where: { optionId } });
  return Number(rows[0]?.n ?? 0) + decisions;
}

/** Поля, ссылающиеся на fieldId в правиле вычисления. */
export function calcDependents(reg: RegisterDef, fieldId: string): FieldMeta[] {
  return reg.fields.filter((f) => {
    const r = f.calcRule;
    return r !== null && (r.fromFieldId === fieldId || r.byFieldId === fieldId || r.overrideFieldId === fieldId);
  });
}

export async function loadUsers(db: Db, ids?: Iterable<string>): Promise<Map<string, UserRef>> {
  const list = ids ? [...new Set(ids)] : undefined;
  const rows = await db.user.findMany({
    where: list ? { id: { in: list } } : {},
    select: { id: true, login: true, fullName: true, isActive: true },
  });
  return new Map(rows.map((u) => [u.id, u]));
}

/** Кому можно назначить запись: активные сотрудники ИБ. */
export async function assignableUsers(db: Db): Promise<Map<string, UserRef>> {
  const rows = await db.user.findMany({
    where: { isActive: true, roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } },
    select: { id: true, login: true, fullName: true, isActive: true },
    orderBy: { fullName: 'asc' },
  });
  return new Map(rows.map((u) => [u.id, u]));
}

export function userIdsIn(reg: RegisterDef, values: Values[]): string[] {
  const userFields = reg.fields.filter((f) => f.type === 'user');
  const ids = new Set<string>();
  for (const v of values) for (const f of userFields) if (typeof v[f.id] === 'string') ids.add(v[f.id] as string);
  return [...ids];
}

/** Текст для поиска: отображаемые значения неархивных полей и номер записи. */
export function searchTextOf(reg: RegisterDef, number: number, values: Values, users: ReadonlyMap<string, UserRef>): string {
  const parts = [`#${number}`];
  for (const f of reg.fields) {
    if (f.archived || !isWritable(f.type)) continue;
    const d = displayValue(f, values[f.id], { users });
    if (d) parts.push(d);
  }
  return parts.join(' ').toLowerCase();
}

export interface DecisionDto {
  optionId: string;
  label: string;
  documentTitle: string;
  documentNumber: string;
  documentDate: string;
  hasFile: boolean;
  decidedAt: string;
  decidedBy: string;
}

export interface RecordDto {
  id: string;
  number: number;
  values: Values;
  /** Отображаемые значения: подписи вариантов, ФИО, даты ДД.ММ.ГГГГ; для вычисляемых и решений — тоже. */
  display: Record<string, string>;
  /** Вычисляемые сроки 'YYYY-MM-DD' (только чтение). */
  calc: Record<string, string | null>;
  /** Последнее решение по каждому полю «решение другого отдела». */
  decisions: Record<string, DecisionDto | null>;
  closed: boolean;
  archived: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

type RecordRow = {
  id: string; number: number; values: Prisma.JsonValue; version: number;
  archivedAt: Date | null; createdAt: Date; updatedAt: Date;
};

/** Сборка записей для ответа: значения, отображение, вычисляемые поля, решения. */
export async function toRecordDtos(db: Db, reg: RegisterDef, rows: RecordRow[]): Promise<RecordDto[]> {
  if (rows.length === 0) return [];
  const valuesList = rows.map((r) => (r.values ?? {}) as Values);
  const users = await loadUsers(db, userIdsIn(reg, valuesList));
  const decisionFields = reg.fields.filter((f) => f.type === 'decision');
  const latest = new Map<string, DecisionDto>();
  if (decisionFields.length) {
    const all = await db.registerDecision.findMany({
      where: { recordId: { in: rows.map((r) => r.id) }, fieldId: { in: decisionFields.map((f) => f.id) } },
      include: { author: { select: { fullName: true } } },
      orderBy: { decidedAt: 'desc' },
    });
    for (const d of all) {
      const key = `${d.recordId}:${d.fieldId}`;
      if (latest.has(key)) continue;
      const field = decisionFields.find((f) => f.id === d.fieldId);
      latest.set(key, {
        optionId: d.optionId,
        label: field?.options.find((o) => o.id === d.optionId)?.label ?? '',
        documentTitle: d.documentTitle,
        documentNumber: d.documentNumber,
        documentDate: d.documentDate.toISOString().slice(0, 10),
        hasFile: d.fileId !== null,
        decidedAt: d.decidedAt.toISOString(),
        decidedBy: d.author.fullName,
      });
    }
  }
  const status = reg.fields.find((f) => f.isStatus);
  return rows.map((r, i) => {
    const values = valuesList[i] ?? {};
    const display: Record<string, string> = {};
    const calc: Record<string, string | null> = {};
    const decisions: Record<string, DecisionDto | null> = {};
    for (const f of reg.fields) {
      if (f.type === 'calc' && f.calcRule) {
        calc[f.id] = calcValue(f.calcRule, values);
        display[f.id] = displayValue(f, calc[f.id], { users });
      } else if (f.type === 'decision') {
        const d = latest.get(`${r.id}:${f.id}`) ?? null;
        decisions[f.id] = d;
        // Пока решения нет — первый вариант («Ожидает решения»).
        display[f.id] = d?.label ?? f.options.find((o) => !o.archived)?.label ?? '';
      } else {
        display[f.id] = displayValue(f, values[f.id], { users });
      }
    }
    const statusValue = status ? values[status.id] : undefined;
    return {
      id: r.id,
      number: r.number,
      values,
      display,
      calc,
      decisions,
      closed: status ? status.options.some((o) => o.id === statusValue && o.isClosed) : false,
      archived: r.archivedAt !== null,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

/** Пересчитать текст поиска у записей реестра (после переименования варианта, сотрудника, смены типа). */
export async function recomputeSearch(db: Db, reg: RegisterDef, where: Prisma.RegisterRecordWhereInput = {}): Promise<void> {
  const rows = await db.registerRecord.findMany({
    where: { registerId: reg.id, deletedAt: null, ...where },
    select: { id: true, number: true, values: true },
  });
  if (!rows.length) return;
  const users = await loadUsers(db, userIdsIn(reg, rows.map((r) => r.values as Values)));
  for (const r of rows) {
    await db.registerRecord.update({
      where: { id: r.id },
      data: { searchText: searchTextOf(reg, r.number, r.values as Values, users) },
    });
  }
}

/** Пересчитать поиск во всех реестрах, где поле «сотрудник» ссылается на пользователя (смена ФИО). */
export async function recomputeSearchForUser(db: Db, userId: string): Promise<void> {
  const fields = await db.registerField.findMany({ where: { type: 'user', deletedAt: null }, select: { id: true, registerId: true } });
  const byRegister = new Map<string, string[]>();
  for (const f of fields) byRegister.set(f.registerId, [...(byRegister.get(f.registerId) ?? []), f.id]);
  for (const [registerId, fieldIds] of byRegister) {
    const reg = await loadRegister(db, registerId);
    await recomputeSearch(db, reg, { OR: fieldIds.map((id) => ({ values: { path: [id], equals: userId } })) });
  }
}
