// Записи реестров (права records.edit и records.delete).
import { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, unprocessable, versionConflict } from '../../lib/errors.js';
import { isBasisRule } from '../../lib/link-basis.js';
import { AWARENESS_RESULTS_KEY } from '../awareness/definition.js';
import { titleFromParts } from '../awareness/derive.js';
import {
  calcValue,
  displayValue,
  isWritable,
  normalizeInput,
  sameValue,
  type StoredValue,
  type UserRef,
  type Values,
} from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { auditSettings, ensureVersioned, type Actor } from '../settings/common.js';
import { requiredTitleField } from '../assets/derive.js';
import { applyDerived, autoCritOption } from '../vulns/derive.js';
import { isVulnRegister, vulnFields } from '../vulns/definition.js';
import { releaseVulnKeys } from '../vulns/keys.js';
import { checkRecordReason, createDeletion, reasonText, vulnSnapshot, type RecordReason } from '../trash/service.js';
import {
  assertNotArchived,
  assignableUsers,
  calendarFor,
  dateOf,
  deadlineField,
  deadlineState,
  importKeyField,
  importKeyOwner,
  isClosed,
  loadRegister,
  loadUsers,
  searchTextOf,
  toRecordDtos,
  userIdsIn,
  recordLocks,
  type FieldMeta,
  type RecordDto,
  type RegisterDef,
} from './definition.js';
import { DEPENDENCY_TEXT, recordDependencies, type DependencyReason } from './dependencies.js';
import { baseSql, filterInMemory, filterSql, type RecordFilter } from './filter.js';
import { linkFieldsTo, linkIdsIn, linkLabels, loadBasisSources, loadLinkRefs, recordsLinkingTo } from './links.js';
import { applyDateDefaults, dateErrors, linkErrors, lockErrors, type RuleError } from './record-rules.js';

const recordSelect = {
  id: true, number: true, values: true, version: true, archivedAt: true, createdAt: true, updatedAt: true, manualFieldIds: true,
} as const;

export interface ListQuery {
  q?: string;
  limit: number;
  cursor?: string;
  /** 'number', 'deadline' (контроль сроков) или id поля. */
  sort?: string;
  dir?: 'asc' | 'desc';
  includeArchived?: boolean;
  /** Только архивные записи (кнопка «Архив», релиз 1.1.0); важнее includeArchived. */
  archivedOnly?: boolean;
  /** Только записи с открытыми задачами (этап 5). */
  withTasks?: boolean;
  /** Фильтр по состоянию, срокам, значению поля, дате (этап 8, ссылки дашборда). */
  filter?: RecordFilter;
}

/** Сортировка, которую нельзя выразить в SQL: вычисляемые поля и контроль сроков (календарь РТ). */
function sortsInMemory(reg: RegisterDef, sort: string | undefined): boolean {
  if (sort === 'deadline') return true;
  return reg.fields.some((f) => f.id === sort && f.type === 'calc');
}

const STATE_RANK = { overdue: 0, soon: 1, ok: 2, closed: 3, none: 4 } as const;

/**
 * Порядок записей по вычисляемому значению. «Контроль сроков»: просрочено → скоро → в срок → закрыто → без срока,
 * внутри группы — по дате срока. Реестр читается целиком (только id и значения): тысячи строк — это быстро.
 */
async function idsSortedInMemory(
  db: Db, reg: RegisterDef, where: Prisma.Sql, sort: string, dir: 'asc' | 'desc', keep: ((values: Values, id: string) => boolean) | null,
): Promise<string[]> {
  const all = await db.$queryRaw<{ id: string; number: number; values: Values }[]>`
    SELECT r.id, r.number, r."values" FROM register_records r WHERE ${where}`;
  const rows = keep ? all.filter((r) => keep(r.values, r.id)) : all;
  const calendar = await calendarFor(db, reg);
  const sign = dir === 'asc' ? 1 : -1;
  let keyed: { id: string; number: number; a: number; b: string | number | null }[];
  if (sort === 'deadline') {
    const field = deadlineField(reg);
    const today = todayIso();
    keyed = rows.map((r) => {
      const d = deadlineState(field ? dateOf(reg, field, r.values, calendar) : null, isClosed(reg, r.values), today);
      return { id: r.id, number: r.number, a: STATE_RANK[d.state], b: d.date };
    });
    // Срочное — всегда первым; направление меняет порядок дат внутри группы.
    keyed.sort((x, y) => x.a - y.a || cmp(x.b, y.b) * sign || y.number - x.number);
  } else {
    const field = reg.fields.find((f) => f.id === sort) as FieldMeta;
    const basisSources = isBasisRule(field.calcRule) ? await loadBasisSources(db, reg, null) : undefined;
    const today = todayIso();
    keyed = rows.map((r) => {
      const v = field.calcRule ? calcValue(field.calcRule, r.values, { fields: reg.fields, calendar, recordId: r.id, basisSources, today }) : null;
      const b = Array.isArray(v) ? null : v;
      return { id: r.id, number: r.number, a: b === null ? 1 : 0, b };
    });
    keyed.sort((x, y) => x.a - y.a || cmp(x.b, y.b) * sign || y.number - x.number);
  }
  return keyed.map((k) => k.id);
}

function cmp(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** Сортировка: номер или хранимое поле (вычисляемые — idsSortedInMemory). */
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
    case 'catalog':
      return Prisma.sql`(SELECT lower(c.value) FROM catalog_items c WHERE c.id::text = r."values" ->> ${key})`;
    default:
      return Prisma.sql`lower(r."values" ->> ${key})`;
  }
}

/** Условие выборки записей — общее у списка и у массовых действий «по фильтру» (одинаковые total и N). */
export type SelectionQuery = Pick<ListQuery, 'q' | 'includeArchived' | 'archivedOnly' | 'withTasks' | 'filter'>;

function selectionWhere(reg: RegisterDef, q: SelectionQuery): Prisma.Sql {
  const search = q.q?.trim().toLowerCase();
  return Prisma.sql`${baseSql(reg.id, q.archivedOnly ? 'only' : q.includeArchived)} ${filterSql(reg, q.filter ?? {})}
    ${search ? Prisma.sql`AND r.search_text LIKE ${`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}` : Prisma.empty}
    ${q.withTasks ? Prisma.sql`AND EXISTS (SELECT 1 FROM tasks t WHERE t.record_id = r.id AND t.completed_at IS NULL AND t.archived_at IS NULL AND t.deleted_at IS NULL)` : Prisma.empty}`;
}

/** Все id записей по условию списка (без пагинации). */
export async function selectRecordIds(db: Db, reg: RegisterDef, q: SelectionQuery): Promise<string[]> {
  const keep = await filterInMemory(db, reg, q.filter ?? {});
  const rows = await db.$queryRaw<{ id: string; values: Values }[]>`
    SELECT r.id::text, r."values" FROM register_records r WHERE ${selectionWhere(reg, q)} ORDER BY r.number`;
  return rows.filter((r) => keep?.(r.values, r.id) ?? true).map((r) => r.id);
}

export async function listRecords(db: Db, registerId: string, q: ListQuery) {
  const reg = await loadRegister(db, registerId);
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const dir = q.dir === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const filter = q.filter ?? {};
  const where = selectionWhere(reg, q);
  // Сроки и вычисляемые даты фильтруются в памяти (как и сортируются): тот же код, что у countRecords.
  const keep = await filterInMemory(db, reg, filter);
  let ids: { id: string }[];
  let total: number;
  if ((q.sort && sortsInMemory(reg, q.sort)) || keep) {
    const all = q.sort && sortsInMemory(reg, q.sort)
      ? await idsSortedInMemory(db, reg, where, q.sort, q.dir ?? 'asc', keep)
      : (await db.$queryRaw<{ id: string; values: Values }[]>`
          SELECT r.id, r."values" FROM register_records r WHERE ${where}
          ORDER BY ${orderExpr(reg, q.sort)} ${dir} NULLS LAST, r.number DESC`).filter((r) => keep?.(r.values, r.id) ?? true).map((r) => r.id);
    total = all.length;
    ids = all.slice(offset, offset + q.limit + 1).map((id) => ({ id }));
  } else {
    ids = await db.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM register_records r WHERE ${where}
      ORDER BY ${orderExpr(reg, q.sort)} ${dir} NULLS LAST, r.number DESC
      LIMIT ${q.limit + 1} OFFSET ${offset}`;
    const [row] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM register_records r WHERE ${where}`;
    total = Number(row?.n ?? 0);
  }
  const pageIds = ids.slice(0, q.limit).map((r) => r.id);
  const rows = await db.registerRecord.findMany({ where: { id: { in: pageIds } }, select: recordSelect });
  const ordered = pageIds.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);
  return {
    items: await toRecordDtos(db, reg, ordered),
    nextCursor: ids.length > q.limit ? String(offset + q.limit) : null,
    total,
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
  // Служебные поля ставит только портал (передача ИКТ, перенос, продления — ADR-0030).
  const managed = changed.filter((f) => f.managed);
  if (managed.length) {
    const names = managed.map((f) => `«${f.label}»`).join(', ');
    // Результат INDIGO — запись отчёта: исправляется загрузкой исправленного отчёта (1.8.0, docs/specs/awareness.md, раздел 3).
    if (reg.systemKey === AWARENESS_RESULTS_KEY) throw conflict('AWARENESS_SERVICE_FIELD', `${names} ставит импорт отчёта INDIGO — вручную не меняется. Исправьте отчёт и загрузите его снова`);
    throw conflict('VULN_SERVICE_FIELD', `${names} ставит портал — вручную не меняется`);
  }
  const title = requiredTitleField(reg);
  if (title && (values[title.id] === undefined || values[title.id] === '') && !titleFromParts(reg, values)) {
    throw badRequest('TITLE_REQUIRED', `Заполните «${title.label}»`);
  }
  return { values, changed };
}

export function describeChanges(
  reg: RegisterDef, before: Values, after: Values, fields: FieldMeta[], users: ReadonlyMap<string, UserRef>, links?: ReadonlyMap<string, string>,
): Change[] {
  return fields.map((f) => ({
    fieldId: f.id,
    label: f.label,
    from: displayValue(f, before[f.id], { users, links }),
    to: displayValue(f, after[f.id], { users, links }),
  }));
}

/** Нарушения правил записи → ошибка: фиксация — 422, неверные значения — 400. */
function throwRuleErrors(errors: RuleError[]): void {
  if (!errors.length) return;
  const message = errors.map((e) => e.message).join('. ');
  const first = errors.find((e) => e.code !== 'INVALID_VALUES');
  if (first) throw unprocessable(first.code, message, { fieldIds: errors.map((e) => e.fieldId).filter(Boolean) });
  throw badRequest('INVALID_VALUES', message);
}

/** Подписи связанных записей (до и после) — для истории и текста поиска. */
async function linkLabelsFor(tx: Db, reg: RegisterDef, values: Values[]) {
  return linkLabels(await loadLinkRefs(tx, linkIdsIn(reg, values)));
}

/** Сменился заголовок записи — пересчитать текст поиска у записей, которые на неё ссылаются. */
async function recomputeBacklinkSearch(tx: Db, reg: RegisterDef, recordId: string): Promise<void> {
  for (const f of await linkFieldsTo(tx, reg.id)) {
    const ids = (await recordsLinkingTo(tx, f.id, recordId)).map((r) => r.id);
    if (!ids.length) continue;
    const src = await loadRegister(tx, f.registerId);
    const rows = await tx.registerRecord.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, values: true } });
    const values = rows.map((r) => r.values as Values);
    const users = await loadUsers(tx, userIdsIn(src, values));
    const links = await linkLabelsFor(tx, src, values);
    for (const r of rows) {
      await tx.registerRecord.update({ where: { id: r.id }, data: { searchText: searchTextOf(src, r.number, r.values as Values, users, links) } });
    }
  }
}

/** Ключ импорта уникален среди неудалённых записей (индекс в БД); здесь — понятная ошибка до записи. */
async function assertImportKeyFree(tx: Db, reg: RegisterDef, values: Values, exceptId: string | null): Promise<void> {
  const owner = await importKeyOwner(tx, reg, values, exceptId);
  const key = importKeyField(reg);
  if (owner && key) throw conflict('IMPORT_KEY_TAKEN', `«${key.label}» = ${owner.value} уже есть в записи #${owner.number}`);
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
    const input0 = applyInput(reg, {}, input.values, assignable);
    const { values, manualFieldIds } = applyDerived(reg, {
      before: {}, after: input0.values, manual: [], edited: input0.changed.map((f) => f.id), isNew: true,
    });
    // Статус по умолчанию — первый активный вариант.
    const status = reg.fields.find((f) => f.isStatus && !f.archived);
    const firstStatus = status?.options.find((o) => !o.archived);
    if (status && firstStatus && values[status.id] === undefined) values[status.id] = firstStatus.id;
    const defaults = applyDateDefaults(reg, values, todayIso());
    const set = [...input0.changed.map((f) => f.id), ...defaults];
    throwRuleErrors([...dateErrors(reg, values, set), ...(await linkErrors(tx, reg, values, set))]);
    await assertImportKeyFree(tx, reg, values, null);
    const number = await nextNumbers(tx, registerId, 1);
    const users = await loadUsers(tx, userIdsIn(reg, [values]));
    const links = await linkLabelsFor(tx, reg, [values]);
    const row = await tx.registerRecord.create({
      data: { registerId, number, values: values as Prisma.InputJsonValue, manualFieldIds, searchText: searchTextOf(reg, number, values, users, links) },
      select: recordSelect,
    });
    const changes = describeChanges(reg, {}, values, reg.fields.filter((f) => values[f.id] !== undefined), users, links);
    await auditSettings(tx, actor, {
      action: 'register_record.created', entity: 'register_record', entityId: row.id,
      summary: `«${reg.name}»: создана запись #${number}`,
      after: { registerId, number, changes },
    });
    const [dto] = await toRecordDtos(tx, reg, [row]);
    return dto as RecordDto;
  });
}

export const REASON_MAX = 1000;

/**
 * Изменить запись. reason — причина изменения поля, которое при текущем статусе меняется только с причиной
 * (этап 8б: «Устройства» действующего разрешения); пишется в историю записи и журнал.
 */
/** meta — источник правки для журнала (сравнение с реестром: via, файл и его sha256); история карточки показывает via. */
export async function updateRecord(
  db: Db, actor: Actor, id: string, input: { version: number; values: Record<string, unknown>; reason?: string | null }, meta?: Record<string, unknown>,
) {
  return withTx(db, async (tx) => {
    const row = await getRecordRow(tx, id);
    const reg = await loadRegister(tx, row.registerId);
    assertNotArchived(reg);
    if (row.archivedAt) throw conflict('RECORD_ARCHIVED', 'Запись в архиве. Верните её, чтобы изменить');
    if (row.version !== input.version) throw versionConflict();
    const current = (row.values ?? {}) as Values;
    const assignable = await assignableUsers(tx);
    const edited = applyInput(reg, current, input.values, assignable);
    if (edited.changed.length === 0) {
      const [dto] = await toRecordDtos(tx, reg, [row]);
      return dto as RecordDto;
    }
    const { values, manualFieldIds, derived } = applyDerived(reg, {
      before: current, after: edited.values, manual: row.manualFieldIds, edited: edited.changed.map((f) => f.id), isNew: false,
    });
    const changed = [...edited.changed, ...reg.fields.filter((f) => derived.includes(f.id) && !edited.changed.includes(f))]
      .filter((f) => !sameValue(current[f.id], values[f.id]));
    const changedIds = changed.map((f) => f.id);
    const reason = input.reason?.trim().slice(0, REASON_MAX) || null;
    throwRuleErrors([
      ...lockErrors(reg, current, values, changedIds, reason),
      ...dateErrors(reg, values, changedIds),
      ...(await linkErrors(tx, reg, values, changedIds)),
    ]);
    // Причина пишется, только если она требовалась (поле «с причиной» при фиксирующем статусе).
    const locks = recordLocks(reg, current);
    const needsReason = changedIds.some((fid) => locks.get(fid) === 'reason');
    await assertImportKeyFree(tx, reg, values, id);
    const users = await loadUsers(tx, userIdsIn(reg, [current, values]));
    const links = await linkLabelsFor(tx, reg, [current, values]);
    const res = await tx.registerRecord.updateMany({
      where: { id, version: input.version, deletedAt: null },
      data: {
        values: values as Prisma.InputJsonValue, manualFieldIds, searchText: searchTextOf(reg, row.number, values, users, links), version: { increment: 1 },
      },
    });
    await ensureVersioned(res.count, () => tx.registerRecord.findFirst({ where: { id, deletedAt: null } }), 'Запись');
    const changes = describeChanges(reg, current, values, changed, users, links);
    const manualNote = manualFieldIds.length !== row.manualFieldIds.length ? '; критичность — ' + (manualFieldIds.length > row.manualFieldIds.length ? 'вручную' : 'автоматически') : '';
    const reasonNote = needsReason && reason ? `; причина: ${reason}` : '';
    await auditSettings(tx, actor, {
      action: 'register_record.updated', entity: 'register_record', entityId: id,
      summary: `«${reg.name}», запись #${row.number}: ${changes.map((c) => `«${c.label}»`).join(', ') || 'без изменений значений'}${manualNote}${reasonNote}`,
      after: { changes, ...(derived.length ? { derived } : {}), ...(needsReason && reason ? { reason } : {}), ...(meta ?? {}) },
    });
    const title = reg.fields.find((f) => f.isTitle);
    if (title && changedIds.includes(title.id)) await recomputeBacklinkSearch(tx, reg, id);
    return getRecord(tx, id);
  });
}

/** «Считать автоматически»: снять ручную правку критичности и пересчитать её по Оценке. */
export async function resetToAuto(db: Db, actor: Actor, id: string, fieldId: string, version: number) {
  return withTx(db, async (tx) => {
    const row = await getRecordRow(tx, id);
    const reg = await loadRegister(tx, row.registerId);
    assertNotArchived(reg);
    if (row.archivedAt) throw conflict('RECORD_ARCHIVED', 'Запись в архиве. Верните её, чтобы изменить');
    if (row.version !== version) throw versionConflict();
    if (!isVulnRegister(reg) || vulnFields(reg).crit.id !== fieldId) throw badRequest('NOT_DERIVED', 'Это поле не считается автоматически');
    const current = (row.values ?? {}) as Values;
    const values: Values = { ...current, [fieldId]: autoCritOption(reg, current) };
    const manualFieldIds = row.manualFieldIds.filter((x) => x !== fieldId);
    const users = await loadUsers(tx, userIdsIn(reg, [values]));
    const res = await tx.registerRecord.updateMany({
      where: { id, version, deletedAt: null },
      data: { values: values as Prisma.InputJsonValue, manualFieldIds, searchText: searchTextOf(reg, row.number, values, users), version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.registerRecord.findFirst({ where: { id, deletedAt: null } }), 'Запись');
    const field = reg.fields.find((f) => f.id === fieldId) as FieldMeta;
    const changes = sameValue(current[fieldId], values[fieldId]) ? [] : describeChanges(reg, current, values, [field], users);
    await auditSettings(tx, actor, {
      action: 'register_record.updated', entity: 'register_record', entityId: id,
      summary: `«${reg.name}», запись #${row.number}: «${field.label}» считается автоматически`,
      after: { changes, via: 'auto' },
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

const DEPENDENCY_CODES: Record<DependencyReason, string> = {
  locked: 'RECORD_LOCKED', decisions: 'HAS_DECISIONS', evidence: 'HAS_EVIDENCE', tasks: 'HAS_TASKS', links: 'HAS_LINKS',
};

function dependencyError(reason: DependencyReason) {
  return reason === 'locked' ? unprocessable(DEPENDENCY_CODES[reason], DEPENDENCY_TEXT[reason]) : conflict(DEPENDENCY_CODES[reason], DEPENDENCY_TEXT[reason]);
}

/** Снимок значений удалённой записи для журнала: «поле → как показывалось». */
export async function deletedSnapshot(tx: Db, reg: RegisterDef, row: { number: number; values: unknown }) {
  const values = (row.values ?? {}) as Values;
  const users = await loadUsers(tx, userIdsIn(reg, [values]));
  return { number: row.number, values: Object.fromEntries(reg.fields.filter((f) => values[f.id] !== undefined).map((f) => [f.label, displayValue(f, values[f.id], { users })])) };
}

/** Реестр записи — для проверки права на удаление (уязвимости — data.delete). */
export async function registerOfRecord(db: Db, id: string) {
  return loadRegister(db, (await getRecordRow(db, id)).registerId);
}

/**
 * Удаление мягкое (раздел 3.4, 1.6.1): запись скрывается везде, событие с причиной — в корзине (восстанавливает
 * супер-администратор), снимок значений — в журнале. У записи уязвимости в событии — статус и итоговый срок.
 */
export async function deleteRecord(db: Db, actor: Actor, id: string, version: number, input: RecordReason) {
  await withTx(db, async (tx) => {
    const row = await getRecordRow(tx, id);
    const reg = await loadRegister(tx, row.registerId);
    assertNotArchived(reg);
    const why = checkRecordReason(input, isVulnRegister(reg));
    if (row.version !== version) throw versionConflict();
    // Те же зависимости, что и у массового удаления (dependencies.ts); первая найденная — в ответе.
    const [dep] = (await recordDependencies(tx, reg, [row])).get(id) ?? [];
    if (dep) throw dependencyError(dep);
    const snapshot = await vulnSnapshot(tx, reg, [row]);
    const deletionId = await createDeletion(tx, actor, {
      entity: 'register_records', entityId: reg.id, title: reg.name, ...why, counts: { records: 1 }, snapshot,
    });
    const res = await tx.registerRecord.updateMany({ where: { id, version, deletedAt: null }, data: { deletedAt: new Date(), deletionId, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerRecord.findFirst({ where: { id, deletedAt: null } }), 'Запись');
    if (isVulnRegister(reg)) await releaseVulnKeys(tx, [id]);
    await auditSettings(tx, actor, {
      action: 'register_record.deleted', entity: 'register_record', entityId: id,
      summary: `«${reg.name}»: удалена запись #${row.number}. Причина: ${reasonText(why.reasonCode, why.reason)}`,
      before: await deletedSnapshot(tx, reg, row),
      after: { deletionId, ...why, ...(snapshot[0] ? { status: snapshot[0].status, open: snapshot[0].open, due: snapshot[0].due } : {}) },
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
    const diff = (r.diff ?? {}) as { summary?: string; after?: { changes?: Partial<Change>[]; via?: string; reason?: string } };
    return {
      id: r.id.toString(),
      at: r.at.toISOString(),
      actor: r.user,
      action: r.action,
      summary: diff.summary ?? r.action,
      via: diff.after?.via ?? null,
      // Журнал не переписывается (раздел 3.5): в записях решений ОУР до 1.0.0 у изменений нет fieldId.
      changes: (diff.after?.changes ?? []).map((c) => ({
        fieldId: c.fieldId ?? '', label: c.label ?? '', from: String(c.from ?? ''), to: String(c.to ?? ''),
      })),
      reason: diff.after?.reason ?? null,
    };
  });
}

export type { StoredValue };

/**
 * Обратные связи записи (этап 8б): записи других реестров, которые ссылаются на неё полем «Связь с записью»,
 * со статусом и сроком — например, разрешения в карточке устройства.
 */
export async function recordBacklinks(db: Db, id: string) {
  const row = await getRecordRow(db, id);
  const groups = [];
  for (const f of await linkFieldsTo(db, row.registerId)) {
    const ids = (await recordsLinkingTo(db, f.id, id)).map((r) => r.id);
    if (!ids.length) continue;
    const src = await loadRegister(db, f.registerId);
    const rows = await db.registerRecord.findMany({ where: { id: { in: ids } }, select: recordSelect, orderBy: { number: 'desc' } });
    const dtos = await toRecordDtos(db, src, rows);
    const title = src.fields.find((x) => x.isTitle);
    const status = src.fields.find((x) => x.isStatus);
    groups.push({
      registerId: src.id,
      registerName: src.name,
      fieldId: f.id,
      fieldLabel: f.label,
      items: dtos.map((d) => ({
        id: d.id,
        number: d.number,
        title: title ? d.display[title.id] ?? '' : '',
        status: status ? d.display[status.id] ?? '' : '',
        closed: d.closed,
        archived: d.archived,
        deadline: d.deadline,
      })),
    });
  }
  return groups;
}
