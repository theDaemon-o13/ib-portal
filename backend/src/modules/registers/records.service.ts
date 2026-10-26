// Записи реестров (права records.edit и records.delete).
import { Prisma } from '@prisma/client';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import {
  displayValue,
  isWritable,
  normalizeInput,
  sameValue,
  type StoredValue,
  type UserRef,
  type Values,
} from '../../lib/register-values.js';
import { auditSettings, ensureVersioned, type Actor } from '../settings/common.js';
import {
  assertNotArchived,
  assignableUsers,
  loadRegister,
  loadUsers,
  searchTextOf,
  toRecordDtos,
  userIdsIn,
  type FieldMeta,
  type RecordDto,
  type RegisterDef,
} from './definition.js';

const recordSelect = { id: true, number: true, values: true, version: true, archivedAt: true, createdAt: true, updatedAt: true } as const;

export interface ListQuery {
  q?: string;
  limit: number;
  cursor?: string;
  /** 'number' или id поля. */
  sort?: string;
  dir?: 'asc' | 'desc';
  includeArchived?: boolean;
}

/** Сортировка: номер или хранимое поле. Вычисляемый срок — на этапе 4 (контроль сроков). */
function orderExpr(reg: RegisterDef, sort: string | undefined): Prisma.Sql {
  if (!sort || sort === 'number') return Prisma.sql`r.number`;
  const f = reg.fields.find((x) => x.id === sort);
  if (!f || !isWritable(f.type)) throw badRequest('BAD_SORT', 'Сортировка по этому полю недоступна');
  const key = f.id;
  switch (f.type) {
    case 'number':
      return Prisma.sql`(r."values" ->> ${key})::numeric`;
    case 'select':
      return Prisma.sql`(SELECT o.sort_order FROM register_field_options o WHERE o.id::text = r."values" ->> ${key})`;
    case 'user':
      return Prisma.sql`(SELECT u.full_name FROM users u WHERE u.id::text = r."values" ->> ${key})`;
    default:
      return Prisma.sql`lower(r."values" ->> ${key})`;
  }
}

export async function listRecords(db: Db, registerId: string, q: ListQuery) {
  const reg = await loadRegister(db, registerId);
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const dir = q.dir === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const search = q.q?.trim().toLowerCase();
  const where = Prisma.sql`r.register_id = ${registerId}::uuid AND r.deleted_at IS NULL
    ${q.includeArchived ? Prisma.empty : Prisma.sql`AND r.archived_at IS NULL`}
    ${search ? Prisma.sql`AND r.search_text LIKE ${`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}` : Prisma.empty}`;
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM register_records r WHERE ${where}
    ORDER BY ${orderExpr(reg, q.sort)} ${dir} NULLS LAST, r.number DESC
    LIMIT ${q.limit + 1} OFFSET ${offset}`;
  const total = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM register_records r WHERE ${where}`;
  const pageIds = ids.slice(0, q.limit).map((r) => r.id);
  const rows = await db.registerRecord.findMany({ where: { id: { in: pageIds } }, select: recordSelect });
  const ordered = pageIds.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);
  return {
    items: await toRecordDtos(db, reg, ordered),
    nextCursor: ids.length > q.limit ? String(offset + q.limit) : null,
    total: Number(total[0]?.n ?? 0),
  };
}

async function getRecordRow(db: Db, id: string) {
  const r = await db.registerRecord.findFirst({ where: { id, deletedAt: null }, select: { ...recordSelect, registerId: true } });
  if (!r) throw notFound('Запись');
  return r;
}

export async function getRecord(db: Db, id: string): Promise<RecordDto> {
  const row = await getRecordRow(db, id);
  const reg = await loadRegister(db, row.registerId);
  const [dto] = await toRecordDtos(db, reg, [row]);
  if (!dto) throw notFound('Запись');
  return dto;
}

interface Change {
  fieldId: string;
  label: string;
  from: string;
  to: string;
}

/**
 * Применить значения из формы: только записываемые неархивные поля (архивное — только если не меняется).
 * Вычисляемые поля и решения отклоняются: они не перезаписываются ни формой, ни импортом.
 */
function applyInput(
  reg: RegisterDef,
  current: Values,
  input: Record<string, unknown>,
  assignable: ReadonlyMap<string, UserRef>,
): { values: Values; changed: FieldMeta[] } {
  let values: Values = { ...current };
  const changed: FieldMeta[] = [];
  const errors: string[] = [];
  for (const [fieldId, raw] of Object.entries(input)) {
    const f = reg.fields.find((x) => x.id === fieldId);
    if (!f) {
      errors.push('Поле не найдено. Обновите страницу');
      continue;
    }
    if (!isWritable(f.type)) {
      errors.push(`«${f.label}» только для чтения`);
      continue;
    }
    const r = normalizeInput(f, raw, { assignableUsers: assignable, current: current[fieldId] });
    if (!r.ok) {
      errors.push(`${f.label}: ${r.error}`);
      continue;
    }
    if (sameValue(current[fieldId], r.value)) continue;
    if (f.archived) {
      errors.push(`Поле «${f.label}» в архиве`);
      continue;
    }
    // null — очистить поле: ключ убирается из values.
    values = r.value === null
      ? Object.fromEntries(Object.entries(values).filter(([k]) => k !== fieldId))
      : { ...values, [fieldId]: r.value };
    changed.push(f);
  }
  if (errors.length) throw badRequest('INVALID_VALUES', errors.join('. '));
  const title = reg.fields.find((f) => f.isTitle && !f.archived);
  if (title && (values[title.id] === undefined || values[title.id] === '')) {
    throw badRequest('TITLE_REQUIRED', `Заполните «${title.label}»`);
  }
  return { values, changed };
}

function describeChanges(reg: RegisterDef, before: Values, after: Values, fields: FieldMeta[], users: ReadonlyMap<string, UserRef>): Change[] {
  return fields.map((f) => ({
    fieldId: f.id,
    label: f.label,
    from: displayValue(f, before[f.id], { users }),
    to: displayValue(f, after[f.id], { users }),
  }));
}

/** Следующий номер записи в реестре (атомарно, под блокировкой строки реестра). */
export async function nextNumbers(db: Db, registerId: string, count: number): Promise<number> {
  const rows = await db.$queryRaw<{ first: number }[]>`
    UPDATE registers SET next_number = next_number + ${count}::int WHERE id = ${registerId}::uuid
    RETURNING next_number - ${count}::int AS first`;
  const first = rows[0]?.first;
  if (first === undefined) throw notFound('Реестр');
  return first;
}

export async function createRecord(db: Db, actor: Actor, registerId: string, input: { values: Record<string, unknown> }) {
  return withTx(db, async (tx) => {
    const reg = await loadRegister(tx, registerId);
    assertNotArchived(reg);
    const assignable = await assignableUsers(tx);
    const { values } = applyInput(reg, {}, input.values, assignable);
    // Статус по умолчанию — первый активный вариант.
    const status = reg.fields.find((f) => f.isStatus && !f.archived);
    const firstStatus = status?.options.find((o) => !o.archived);
    if (status && firstStatus && values[status.id] === undefined) values[status.id] = firstStatus.id;
    const number = await nextNumbers(tx, registerId, 1);
    const users = await loadUsers(tx, userIdsIn(reg, [values]));
    const row = await tx.registerRecord.create({
      data: { registerId, number, values: values as Prisma.InputJsonValue, searchText: searchTextOf(reg, number, values, users) },
      select: recordSelect,
    });
    const changes = describeChanges(reg, {}, values, reg.fields.filter((f) => values[f.id] !== undefined), users);
    await auditSettings(tx, actor, {
      action: 'register_record.created', entity: 'register_record', entityId: row.id,
      summary: `«${reg.name}»: создана запись #${number}`,
      after: { registerId, number, changes },
    });
    const [dto] = await toRecordDtos(tx, reg, [row]);
    return dto as RecordDto;
  });
}

export async function updateRecord(db: Db, actor: Actor, id: string, input: { version: number; values: Record<string, unknown> }) {
  return withTx(db, async (tx) => {
    const row = await getRecordRow(tx, id);
    const reg = await loadRegister(tx, row.registerId);
    assertNotArchived(reg);
    if (row.archivedAt) throw conflict('RECORD_ARCHIVED', 'Запись в архиве. Верните её, чтобы изменить');
    if (row.version !== input.version) throw versionConflict();
    const current = (row.values ?? {}) as Values;
    const assignable = await assignableUsers(tx);
    const { values, changed } = applyInput(reg, current, input.values, assignable);
    if (changed.length === 0) {
      const [dto] = await toRecordDtos(tx, reg, [row]);
      return dto as RecordDto;
    }
    const users = await loadUsers(tx, userIdsIn(reg, [current, values]));
    const res = await tx.registerRecord.updateMany({
      where: { id, version: input.version, deletedAt: null },
      data: { values: values as Prisma.InputJsonValue, searchText: searchTextOf(reg, row.number, values, users), version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.registerRecord.findFirst({ where: { id, deletedAt: null } }), 'Запись');
    const changes = describeChanges(reg, current, values, changed, users);
    await auditSettings(tx, actor, {
      action: 'register_record.updated', entity: 'register_record', entityId: id,
      summary: `«${reg.name}», запись #${row.number}: ${changes.map((c) => `«${c.label}»`).join(', ')}`,
      after: { changes },
    });
    return getRecord(tx, id);
  });
}

export async function setRecordArchived(db: Db, actor: Actor, id: string, version: number, archived: boolean) {
  return withTx(db, async (tx) => {
    const row = await getRecordRow(tx, id);
    const reg = await loadRegister(tx, row.registerId);
    assertNotArchived(reg);
    if ((row.archivedAt !== null) === archived) {
      if (row.version !== version) throw versionConflict();
      return getRecord(tx, id);
    }
    const res = await tx.registerRecord.updateMany({
      where: { id, version, deletedAt: null },
      data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.registerRecord.findFirst({ where: { id, deletedAt: null } }), 'Запись');
    await auditSettings(tx, actor, {
      action: archived ? 'register_record.archived' : 'register_record.restored', entity: 'register_record', entityId: id,
      summary: `«${reg.name}», запись #${row.number}: ${archived ? 'отправлена в архив' : 'возвращена из архива'}`,
    });
    return getRecord(tx, id);
  });
}

/** Удаление мягкое (раздел 3.4): запись скрывается везде, снимок значений — в журнале. */
export async function deleteRecord(db: Db, actor: Actor, id: string, version: number) {
  await withTx(db, async (tx) => {
    const row = await getRecordRow(tx, id);
    const reg = await loadRegister(tx, row.registerId);
    assertNotArchived(reg);
    if (row.version !== version) throw versionConflict();
    const decisions = await tx.registerDecision.count({ where: { recordId: id } });
    if (decisions > 0) throw conflict('HAS_DECISIONS', 'По записи есть решения другого отдела — её можно только отправить в архив');
    const res = await tx.registerRecord.updateMany({ where: { id, version, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerRecord.findFirst({ where: { id, deletedAt: null } }), 'Запись');
    const values = (row.values ?? {}) as Values;
    const users = await loadUsers(tx, userIdsIn(reg, [values]));
    await auditSettings(tx, actor, {
      action: 'register_record.deleted', entity: 'register_record', entityId: id,
      summary: `«${reg.name}»: удалена запись #${row.number}`,
      before: { number: row.number, values: Object.fromEntries(reg.fields.filter((f) => values[f.id] !== undefined).map((f) => [f.label, displayValue(f, values[f.id], { users })])) },
    });
  });
}

/** История записи — из журнала аудита (раздел 3.5): кто, когда, что поменял. */
export async function recordHistory(db: Db, id: string) {
  await getRecordRow(db, id);
  const rows = await db.auditLog.findMany({
    where: { entity: 'register_record', entityId: id },
    include: { user: { select: { fullName: true, login: true } } },
    orderBy: { id: 'desc' },
    take: 200,
  });
  return rows.map((r) => {
    const diff = (r.diff ?? {}) as { summary?: string; after?: { changes?: Change[]; via?: string } };
    return {
      id: r.id.toString(),
      at: r.at.toISOString(),
      actor: r.user,
      action: r.action,
      summary: diff.summary ?? r.action,
      via: diff.after?.via ?? null,
      changes: diff.after?.changes ?? [],
    };
  });
}

export type { StoredValue };
