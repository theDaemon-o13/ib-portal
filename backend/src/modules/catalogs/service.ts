// Справочники (CLAUDE.md, разделы 6 и 7, п. 10; docs/concept.md, раздел 9).
// Сущности ссылаются на значения по id, поэтому переименование ничего не ломает.
import type { Prisma } from '../../generated/prisma/client.js';
import { RECIPIENTS_CATALOG, SYSTEM_OWNER_KEY, SYSTEMS_CATALOG, systemItemWhy } from '../../lib/catalogs.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import type { Tone } from '../../lib/tones.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';
import '../settings/usage-counters.js';
import { catalogItemUsage } from '../settings/usage.js';

const userBrief = { select: { id: true, fullName: true, isActive: true } } as const;
const itemInclude = {
  owner: userBrief,
  members: { include: { user: userBrief }, orderBy: { user: { fullName: 'asc' } } },
} as const;
type ItemRow = Prisma.CatalogItemGetPayload<{ include: typeof itemInclude }>;

export interface CatalogItemDto {
  id: string;
  catalogCode: string;
  value: string;
  color: string | null;
  isSystem: boolean;
  /** Ключ системного значения («system_owner» у метки «Владелец системы»…). */
  systemKey: string | null;
  systemReason: string | null;
  keywords: string[];
  owner: { id: string; fullName: string; isActive: boolean } | null;
  /** «Получатели уведомлений»: участники метки и адреса вне портала. */
  members: { id: string; fullName: string; isActive: boolean }[];
  emails: string[];
  sortOrder: number;
  /** «Статусы задач»: обязателен комментарий при переходе в колонку вперёд / при возврате в неё (ADR-0022). */
  commentForward: boolean;
  commentReturn: boolean;
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
    systemKey: row.systemKey,
    systemReason: row.isSystem ? systemItemWhy(row.catalogCode, row.systemKey) : null,
    keywords: row.keywords,
    owner: row.owner,
    members: row.members.map((m) => m.user),
    emails: row.emails,
    sortOrder: row.sortOrder,
    commentForward: row.commentForward,
    commentReturn: row.commentReturn,
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

const IB_WORK = { roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } } as const;

/** Ответственный по правилу почты — активный сотрудник ИБ. */
async function assertMailOwner(db: Db, userId: string) {
  const user = await db.user.findFirst({ where: { id: userId, isActive: true, ...IB_WORK }, select: { id: true } });
  if (!user) throw badRequest('BAD_OWNER', 'Ответственным может быть только активный сотрудник ИБ');
}

/** Владелец системы — любой активный пользователь портала; без ib.work задачи ему не назначаются. */
async function assertSystemOwner(db: Db, userId: string) {
  const user = await db.user.findFirst({ where: { id: userId, isActive: true }, select: { id: true } });
  if (!user) throw badRequest('BAD_OWNER', 'Владелец системы — активный пользователь портала');
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const MAX_MEMBERS = 50;

function normalizeEmails(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of raw.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (e.length > 254 || !EMAIL_RE.test(e)) throw badRequest('BAD_EMAIL', `«${e}» — не адрес e-mail`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > MAX_MEMBERS) throw badRequest('TOO_MANY', `Не больше ${MAX_MEMBERS} адресов`);
  return out;
}

/**
 * Участники метки — только активные пользователи с ib.work: им ставятся задачи.
 * Остальных можно записать e-mail — для справки: письма портал не отправляет.
 */
async function checkMembers(db: Db, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_MEMBERS) throw badRequest('TOO_MANY', `Не больше ${MAX_MEMBERS} участников`);
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true, isActive: true } });
  const ok = new Set((await db.user.findMany({ where: { id: { in: unique }, isActive: true, ...IB_WORK }, select: { id: true } })).map((u) => u.id));
  const bad = unique.filter((id) => !ok.has(id));
  if (bad.length) {
    const names = bad.map((id) => users.find((u) => u.id === id)?.fullName ?? 'пользователь не найден');
    throw badRequest('NOT_IB_USER',
      `${names.join(', ')}: нет доступа к разделам ИБ — задачи такому участнику не назначить. Укажите его e-mail: письма придут, когда в портале появится почта`);
  }
  return unique;
}

export interface ItemInput {
  value?: string;
  color?: Tone | null;
  keywords?: string[];
  ownerUserId?: string | null;
  memberIds?: string[];
  emails?: string[];
  /** Только «Статусы задач». */
  commentForward?: boolean;
  commentReturn?: boolean;
  /** Только «Статусы задач»: поставить колонку сразу после этой (null — в начало). */
  afterId?: string | null;
}

function validateShape(catalog: { code: string; kind: string; hasColor: boolean }, input: ItemInput, systemKey: string | null = null) {
  if (input.color != null && !catalog.hasColor) throw badRequest('NO_COLOR', 'У значений этого справочника нет цвета');
  if (catalog.kind !== 'mail_rules' && input.keywords !== undefined) {
    throw badRequest('NOT_MAIL_RULE', 'Ключевые слова есть только у правил разбора почты');
  }
  if (catalog.kind !== 'mail_rules' && catalog.code !== SYSTEMS_CATALOG && input.ownerUserId !== undefined) {
    throw badRequest('NOT_MAIL_RULE', 'Ответственный есть только у правил разбора почты и систем');
  }
  if (catalog.code !== RECIPIENTS_CATALOG && (input.memberIds !== undefined || input.emails !== undefined)) {
    throw badRequest('NOT_RECIPIENTS', 'Участники и e-mail есть только у меток «Получатели уведомлений»');
  }
  if (catalog.kind !== 'statuses' && (input.commentForward !== undefined || input.commentReturn !== undefined || input.afterId !== undefined)) {
    throw badRequest('NOT_STATUSES', 'Признаки комментария и место есть только у колонок доски задач');
  }
  if (systemKey === SYSTEM_OWNER_KEY && (input.memberIds?.length || input.emails?.length)) {
    throw badRequest('SYSTEM_OWNER_LABEL', '«Владелец системы» берётся из справочника «Системы» — участников у метки нет');
  }
}

const assertOwner = (db: Db, catalogCode: string, userId: string) =>
  (catalogCode === SYSTEMS_CATALOG ? assertSystemOwner(db, userId) : assertMailOwner(db, userId));

async function setMembers(db: Db, itemId: string, ids: readonly string[]) {
  await db.catalogItemUser.deleteMany({ where: { itemId, userId: { notIn: [...ids] } } });
  await db.catalogItemUser.createMany({ data: ids.map((userId) => ({ itemId, userId })), skipDuplicates: true });
}

export async function createItem(db: Db, actor: Actor, code: string, input: ItemInput & { value: string }) {
  return withTx(db, async (tx) => {
    const catalog = await getCatalog(tx, code);
    validateShape(catalog, input);
    const value = trimmed(input.value);
    if (!value) throw badRequest('EMPTY_VALUE', 'Укажите значение');
    await assertUnique(tx, code, value);

    const keywords = normalizeKeywords(input.keywords ?? []);
    if (catalog.kind === 'mail_rules' && keywords.length === 0) {
      throw badRequest('NO_KEYWORDS', 'Укажите хотя бы одно ключевое слово');
    }
    if (input.ownerUserId) await assertOwner(tx, code, input.ownerUserId);
    const memberIds = input.memberIds ? await checkMembers(tx, input.memberIds) : [];
    const emails = normalizeEmails(input.emails ?? []);

    const max = await tx.catalogItem.aggregate({ where: { catalogCode: code }, _max: { sortOrder: true } });
    const row = await tx.catalogItem.create({
      data: {
        catalogCode: code,
        value,
        color: catalog.hasColor ? (input.color ?? 'muted') : null,
        keywords,
        ownerUserId: input.ownerUserId ?? null,
        emails,
        sortOrder: (max._max.sortOrder ?? 0) + 1,
        commentForward: catalog.kind === 'statuses' ? input.commentForward ?? false : false,
        commentReturn: catalog.kind === 'statuses' ? input.commentReturn ?? false : false,
      },
    });
    if (memberIds.length) await setMembers(tx, row.id, memberIds);
    if (catalog.kind === 'statuses' && input.afterId !== undefined) await placeAfter(tx, code, row.id, input.afterId);
    await auditSettings(tx, actor, {
      action: 'catalog.item.created',
      entity: 'catalog_item',
      entityId: row.id,
      summary: `«${catalog.name}»: добавлено «${value}»`,
      after: {
        value, color: row.color, keywords, ownerUserId: row.ownerUserId, memberIds, emails,
        ...(catalog.kind === 'statuses' ? { commentForward: row.commentForward, commentReturn: row.commentReturn } : {}),
      },
    });
    return toDto(await getItem(tx, row.id), 0);
  });
}

export async function updateItem(db: Db, actor: Actor, id: string, input: ItemInput & { version: number }) {
  return withTx(db, async (tx) => {
    const item = await getItem(tx, id);
    validateShape(item.catalog, input, item.systemKey);

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
      if (input.ownerUserId) await assertOwner(tx, item.catalogCode, input.ownerUserId);
      data.ownerUserId = input.ownerUserId;
      changes.push(item.catalogCode === SYSTEMS_CATALOG ? `владелец «${item.value}»` : `ответственный «${item.value}»`);
    }
    let memberIds: string[] | null = null;
    const membersBefore = item.members.map((m) => m.userId);
    if (input.memberIds !== undefined) {
      const next = await checkMembers(tx, input.memberIds);
      if ([...next].sort().join('|') !== [...membersBefore].sort().join('|')) {
        memberIds = next;
        changes.push(`участники «${item.value}»`);
      }
    }
    if (input.emails !== undefined) {
      const emails = normalizeEmails(input.emails);
      if (emails.join('|') !== item.emails.join('|')) {
        data.emails = emails;
        changes.push(`e-mail «${item.value}»`);
      }
    }
    for (const [key, label] of [['commentForward', 'комментарий при переходе вперёд'], ['commentReturn', 'комментарий при возврате']] as const) {
      const v = input[key];
      if (v !== undefined && v !== item[key]) {
        data[key] = v;
        changes.push(`«${item.value}»: ${label} — ${v ? 'обязателен' : 'не обязателен'}`);
      }
    }
    let moved = false;
    if (input.afterId !== undefined) {
      if (item.isSystem) throw conflict('SYSTEM_ORDER', 'Порядок колонок процесса задач не меняется; свою колонку можно поставить между ними');
      moved = true;
      changes.push(`«${item.value}» перемещена`);
    }

    if (changes.length > 0) {
      const res = await tx.catalogItem.updateMany({
        where: { id, version: input.version, deletedAt: null },
        data: { ...data, version: { increment: 1 } },
      });
      await ensureVersioned(res.count, () => tx.catalogItem.findFirst({ where: { id, deletedAt: null } }), 'Значение справочника');
      if (memberIds) await setMembers(tx, id, memberIds);
      if (moved) await placeAfter(tx, item.catalogCode, id, input.afterId ?? null);
      await auditSettings(tx, actor, {
        action: 'catalog.item.updated',
        entity: 'catalog_item',
        entityId: id,
        summary: `«${item.catalog.name}»: ${changes.join(', ')}`,
        before: {
          value: item.value, color: item.color, keywords: item.keywords, ownerUserId: item.ownerUserId, memberIds: membersBefore, emails: item.emails,
          ...(item.catalog.kind === 'statuses' ? { commentForward: item.commentForward, commentReturn: item.commentReturn, sortOrder: item.sortOrder } : {}),
        },
        after: { ...data, ...(memberIds ? { memberIds } : {}) },
      });
    } else if (input.version !== item.version) {
      throw versionConflict();
    }
    const fresh = await getItem(tx, id);
    const usage = await catalogItemUsage.count(tx, [id]);
    return toDto(fresh, usage.get(id) ?? 0);
  });
}

/** Колонка доски задач встаёт сразу после afterId (null — в начало); порядок остальных сохраняется. */
async function placeAfter(tx: Db, code: string, id: string, afterId: string | null) {
  const rows = await tx.catalogItem.findMany({ where: { catalogCode: code, deletedAt: null }, select: { id: true }, orderBy: [{ sortOrder: 'asc' }, { value: 'asc' }] });
  const rest = rows.map((r) => r.id).filter((x) => x !== id);
  if (afterId !== null && !rest.includes(afterId)) throw badRequest('UNKNOWN_COLUMN', 'Колонка, после которой поставить, не найдена. Обновите страницу');
  rest.splice(afterId === null ? 0 : rest.indexOf(afterId) + 1, 0, id);
  // Системные колонки процесса сохраняют свой порядок относительно друг друга: свою колонку можно поставить только между ними.
  for (const [i, x] of rest.entries()) await tx.catalogItem.update({ where: { id: x }, data: { sortOrder: i + 1 } });
}

async function setArchived(db: Db, actor: Actor, id: string, version: number, archived: boolean) {
  return withTx(db, async (tx) => {
    const item = await getItem(tx, id);
    if (item.isSystem) {
      throw conflict('SYSTEM_VALUE', 'Системное значение нельзя отправить в архив: на него опирается логика портала');
    }
    // Колонка доски: в архив — только пустая, иначе её задачи пропали бы с доски (ADR-0022).
    if (archived && item.catalog.kind === 'statuses') {
      const open = await tx.task.count({ where: { statusId: id, deletedAt: null, archivedAt: null } });
      if (open > 0) throw conflict('COLUMN_NOT_EMPTY', `В колонке «${item.value}» задач: ${open}. Перенесите их в другую колонку, затем отправьте её в архив`);
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
