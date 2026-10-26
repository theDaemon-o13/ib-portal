// Справочники (CLAUDE.md, разделы 6 и 7, п. 10; docs/concept.md, раздел 9).
// Сущности ссылаются на значения по id, поэтому переименование ничего не ломает.
import type { Prisma } from '@prisma/client';
import { systemItemWhy } from '../../lib/catalogs.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import type { Tone } from '../../lib/tones.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';
import { catalogItemUsage } from '../settings/usage.js';

const itemInclude = { owner: { select: { id: true, fullName: true, isActive: true } } } as const;
type ItemRow = Prisma.CatalogItemGetPayload<{ include: typeof itemInclude }>;

export interface CatalogItemDto {
  id: string;
  catalogCode: string;
  value: string;
  color: string | null;
  isSystem: boolean;
  systemReason: string | null;
  keywords: string[];
  owner: { id: string; fullName: string; isActive: boolean } | null;
  sortOrder: number;
  version: number;
  archived: boolean;
  usage: number;
}

function toDto(row: ItemRow, usage: number): CatalogItemDto {
  return {
    id: row.id,
    catalogCode: row.catalogCode,
    value: row.value,
    color: row.color,
    isSystem: row.isSystem,
    systemReason: row.isSystem ? systemItemWhy(row.catalogCode, row.systemKey) : null,
    keywords: row.keywords,
    owner: row.owner,
    sortOrder: row.sortOrder,
    version: row.version,
    archived: row.archivedAt !== null,
    usage,
  };
}

async function getCatalog(db: Db, code: string) {
  const catalog = await db.catalog.findUnique({ where: { code } });
  if (!catalog) throw notFound('Справочник');
  return catalog;
}

async function getItem(db: Db, id: string) {
  const item = await db.catalogItem.findFirst({ where: { id, deletedAt: null }, include: { ...itemInclude, catalog: true } });
  if (!item) throw notFound('Значение справочника');
  return item;
}

export async function listCatalogs(db: Db) {
  const catalogs = await db.catalog.findMany({ orderBy: { sortOrder: 'asc' } });
  const counts = await db.catalogItem.groupBy({
    by: ['catalogCode'],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const archived = await db.catalogItem.groupBy({
    by: ['catalogCode'],
    where: { deletedAt: null, archivedAt: { not: null } },
    _count: { _all: true },
  });
  const n = (rows: typeof counts, code: string) => rows.find((r) => r.catalogCode === code)?._count._all ?? 0;
  return catalogs.map((c) => ({
    code: c.code,
    name: c.name,
    description: c.description,
    kind: c.kind as 'values' | 'statuses' | 'mail_rules',
    hasColor: c.hasColor,
    itemCount: n(counts, c.code),
    archivedCount: n(archived, c.code),
  }));
}

/** Значения справочника. Без includeArchived — только активные (для списков выбора). */
export async function listItems(db: Db, code: string, opts: { includeArchived: boolean }): Promise<CatalogItemDto[]> {
  await getCatalog(db, code);
  const rows = await db.catalogItem.findMany({
    where: { catalogCode: code, deletedAt: null, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    include: itemInclude,
    orderBy: [{ sortOrder: 'asc' }, { value: 'asc' }],
  });
  const usage = await catalogItemUsage.count(db, rows.map((r) => r.id));
  return rows.map((r) => toDto(r, usage.get(r.id) ?? 0));
}

function normalizeKeywords(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of raw.map((x) => x.trim().toLowerCase()).filter(Boolean)) if (!out.includes(k)) out.push(k);
  return out;
}

async function assertUnique(db: Db, code: string, value: string, exceptId?: string) {
  const clash = await db.catalogItem.findFirst({
    where: {
      catalogCode: code,
      deletedAt: null,
      value: { equals: value, mode: 'insensitive' },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw conflict('DUPLICATE', `«${value}» уже есть в справочнике`);
}

/** Ответственный по правилу почты — активный сотрудник ИБ. */
async function assertMailOwner(db: Db, userId: string) {
  const user = await db.user.findFirst({
    where: {
      id: userId,
      isActive: true,
      roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } },
    },
    select: { id: true },
  });
  if (!user) throw badRequest('BAD_OWNER', 'Ответственным может быть только активный сотрудник ИБ');
}

export interface ItemInput {
  value?: string;
  color?: Tone | null;
  keywords?: string[];
  ownerUserId?: string | null;
}

function validateShape(catalog: { kind: string; hasColor: boolean }, input: ItemInput) {
  if (input.color != null && !catalog.hasColor) throw badRequest('NO_COLOR', 'У значений этого справочника нет цвета');
  if (catalog.kind !== 'mail_rules' && (input.keywords !== undefined || input.ownerUserId !== undefined)) {
    throw badRequest('NOT_MAIL_RULE', 'Ключевые слова и ответственный есть только у правил разбора почты');
  }
}

export async function createItem(db: Db, actor: Actor, code: string, input: ItemInput & { value: string }) {
  return withTx(db, async (tx) => {
    const catalog = await getCatalog(tx, code);
    if (catalog.kind === 'statuses') {
      throw conflict('FIXED_SET', 'Набор статусов фиксирован: статусы можно только переименовать');
    }
    validateShape(catalog, input);
    const value = trimmed(input.value);
    if (!value) throw badRequest('EMPTY_VALUE', 'Укажите значение');
    await assertUnique(tx, code, value);

    const keywords = normalizeKeywords(input.keywords ?? []);
    if (catalog.kind === 'mail_rules' && keywords.length === 0) {
      throw badRequest('NO_KEYWORDS', 'Укажите хотя бы одно ключевое слово');
    }
    if (input.ownerUserId) await assertMailOwner(tx, input.ownerUserId);

    const max = await tx.catalogItem.aggregate({ where: { catalogCode: code }, _max: { sortOrder: true } });
    const row = await tx.catalogItem.create({
      data: {
        catalogCode: code,
        value,
        color: catalog.hasColor ? (input.color ?? 'muted') : null,
        keywords,
        ownerUserId: input.ownerUserId ?? null,
        sortOrder: (max._max.sortOrder ?? 0) + 1,
      },
      include: itemInclude,
    });
    await auditSettings(tx, actor, {
      action: 'catalog.item.created',
      entity: 'catalog_item',
      entityId: row.id,
      summary: `«${catalog.name}»: добавлено «${value}»`,
      after: { value, color: row.color, keywords, ownerUserId: row.ownerUserId },
    });
    return toDto(row, 0);
  });
}

export async function updateItem(db: Db, actor: Actor, id: string, input: ItemInput & { version: number }) {
  return withTx(db, async (tx) => {
    const item = await getItem(tx, id);
    validateShape(item.catalog, input);

    const data: Prisma.CatalogItemUncheckedUpdateManyInput = {};
    const changes: string[] = [];
    if (input.value !== undefined) {
      const value = trimmed(input.value);
      if (!value) throw badRequest('EMPTY_VALUE', 'Укажите значение');
      if (value !== item.value) {
        // Системные значения не переименовываются; исключение — статусы задач (только переименование).
        if (item.isSystem && item.catalog.kind !== 'statuses') {
          throw conflict('SYSTEM_VALUE', 'Системное значение нельзя переименовать: на него опирается логика портала');
        }
        await assertUnique(tx, item.catalogCode, value, id);
        data.value = value;
        changes.push(`переименовано «${item.value}» → «${value}»`);
      }
    }
    if (input.color !== undefined && input.color !== item.color) {
      data.color = input.color ?? 'muted';
      changes.push(`цвет «${item.value}»`);
    }
    if (input.keywords !== undefined) {
      const keywords = normalizeKeywords(input.keywords);
      if (keywords.length === 0) throw badRequest('NO_KEYWORDS', 'Укажите хотя бы одно ключевое слово');
      if (keywords.join('|') !== item.keywords.join('|')) {
        data.keywords = keywords;
        changes.push(`ключевые слова «${item.value}»`);
      }
    }
    if (input.ownerUserId !== undefined && input.ownerUserId !== item.ownerUserId) {
      if (input.ownerUserId) await assertMailOwner(tx, input.ownerUserId);
      data.ownerUserId = input.ownerUserId;
      changes.push(`ответственный «${item.value}»`);
    }

    if (changes.length > 0) {
      const res = await tx.catalogItem.updateMany({
        where: { id, version: input.version, deletedAt: null },
        data: { ...data, version: { increment: 1 } },
      });
      await ensureVersioned(res.count, () => tx.catalogItem.findFirst({ where: { id, deletedAt: null } }), 'Значение справочника');
      await auditSettings(tx, actor, {
        action: 'catalog.item.updated',
        entity: 'catalog_item',
        entityId: id,
        summary: `«${item.catalog.name}»: ${changes.join(', ')}`,
        before: { value: item.value, color: item.color, keywords: item.keywords, ownerUserId: item.ownerUserId },
        after: { ...data },
      });
    } else if (input.version !== item.version) {
      throw versionConflict();
    }
    const fresh = await getItem(tx, id);
    const usage = await catalogItemUsage.count(tx, [id]);
    return toDto(fresh, usage.get(id) ?? 0);
  });
}

async function setArchived(db: Db, actor: Actor, id: string, version: number, archived: boolean) {
  return withTx(db, async (tx) => {
    const item = await getItem(tx, id);
    if (item.isSystem) {
      throw conflict('SYSTEM_VALUE', 'Системное значение нельзя отправить в архив: на него опирается логика портала');
    }
    const res = await tx.catalogItem.updateMany({
      where: { id, version, deletedAt: null },
      data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.catalogItem.findFirst({ where: { id, deletedAt: null } }), 'Значение справочника');
    await auditSettings(tx, actor, {
      action: archived ? 'catalog.item.archived' : 'catalog.item.restored',
      entity: 'catalog_item',
      entityId: id,
      summary: `«${item.catalog.name}»: ${archived ? 'отправлено в архив' : 'возвращено из архива'} «${item.value}»`,
    });
    const usage = await catalogItemUsage.count(tx, [id]);
    return toDto(await getItem(tx, id), usage.get(id) ?? 0);
  });
}

export const archiveItem = (db: Db, actor: Actor, id: string, version: number) => setArchived(db, actor, id, version, true);
export const restoreItem = (db: Db, actor: Actor, id: string, version: number) => setArchived(db, actor, id, version, false);

/** Удаление мягкое (deleted_at) и только для несистемного неиспользуемого значения. */
export async function deleteItem(db: Db, actor: Actor, id: string, version: number) {
  await withTx(db, async (tx) => {
    const item = await getItem(tx, id);
    if (item.isSystem) throw conflict('SYSTEM_VALUE', 'Системное значение нельзя удалить: на него опирается логика портала');
    const used = (await catalogItemUsage.count(tx, [id])).get(id) ?? 0;
    if (used > 0) {
      throw conflict('IN_USE', `«${item.value}» используется (${used}). Отправьте значение в архив: старые записи его сохранят`);
    }
    const res = await tx.catalogItem.updateMany({
      where: { id, version, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.catalogItem.findFirst({ where: { id, deletedAt: null } }), 'Значение справочника');
    await auditSettings(tx, actor, {
      action: 'catalog.item.deleted',
      entity: 'catalog_item',
      entityId: id,
      summary: `«${item.catalog.name}»: удалено «${item.value}»`,
      before: { value: item.value },
    });
  });
}
