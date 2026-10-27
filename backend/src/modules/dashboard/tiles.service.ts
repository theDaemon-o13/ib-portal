// Плитки-счётчики дашборда (этап 8): «записей реестра X, где поле Y ∈ {значения}», без закрытых.
// Добавляет и меняет пользователь с registers.manage; удаление мягкое. Число плитки — countRecords
// по тому же фильтру, что и ссылка в реестр.
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { loadRegister, type FieldMeta, type RegisterDef } from '../registers/definition.js';
import { countRecords, registerLink, type RecordFilter } from '../registers/filter.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';
import type { WidgetData } from './service.js';

const TILE_TYPES = new Set(['select', 'catalog']);
export const TILE_TITLE_MAX = 120;
export const TILE_OPTIONS_MAX = 50;

export interface TileDto {
  id: string;
  title: string;
  register: { id: string; name: string; archived: boolean };
  field: { id: string; label: string; archived: boolean };
  options: { id: string; label: string; archived: boolean }[];
  /** Плитка не считается: реестр или поле в архиве или удалено. Видна только в настройке плиток. */
  broken: string | null;
  sortOrder: number;
  version: number;
}

type TileRow = { id: string; registerId: string; fieldId: string; title: string; optionIds: string[]; sortOrder: number; version: number };

async function toDto(db: Db, t: TileRow, regs: Map<string, RegisterDef>): Promise<TileDto> {
  const reg = regs.get(t.registerId) ?? (await loadRegister(db, t.registerId));
  regs.set(reg.id, reg);
  // loadRegister не возвращает удалённые поля.
  const f: FieldMeta | undefined = reg.fields.find((x) => x.id === t.fieldId);
  const broken = reg.archived ? 'реестр в архиве' : !f ? 'поле удалено' : f.archived ? 'поле в архиве'
    : !TILE_TYPES.has(f.type) ? 'у поля сменили тип' : null;
  return {
    id: t.id,
    title: t.title,
    register: { id: reg.id, name: reg.name, archived: reg.archived },
    field: { id: t.fieldId, label: f?.label ?? 'поле удалено', archived: f?.archived ?? true },
    options: t.optionIds.map((id) => {
      const o = f?.options.find((x) => x.id === id);
      return { id, label: o?.label ?? 'значение удалено', archived: !o || o.archived };
    }),
    broken,
    sortOrder: t.sortOrder,
    version: t.version,
  };
}

const select = { id: true, registerId: true, fieldId: true, title: true, optionIds: true, sortOrder: true, version: true } as const;

export async function listTiles(db: Db): Promise<TileDto[]> {
  const rows = await db.dashboardTile.findMany({ where: { deletedAt: null }, select, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  const regs = new Map<string, RegisterDef>();
  const out: TileDto[] = [];
  for (const r of rows) out.push(await toDto(db, r, regs));
  return out;
}

async function getTile(db: Db, id: string) {
  const t = await db.dashboardTile.findFirst({ where: { id, deletedAt: null }, select });
  if (!t) throw notFound('Плитка');
  return t;
}

/** Проверка определения: действующий реестр, поле-список или справочник, значения этого поля, не закрытые статусы. */
async function validate(db: Db, input: { registerId: string; fieldId: string; optionIds: string[]; title: string }) {
  const title = trimmed(input.title);
  if (!title) throw badRequest('EMPTY_TITLE', 'Укажите название плитки');
  if (title.length > TILE_TITLE_MAX) throw badRequest('TITLE_TOO_LONG', `Название — не длиннее ${TILE_TITLE_MAX} символов`);
  const reg = await loadRegister(db, input.registerId);
  if (reg.archived) throw conflict('REGISTER_ARCHIVED', `Реестр «${reg.name}» в архиве`);
  const f = reg.fields.find((x) => x.id === input.fieldId);
  if (!f) throw badRequest('BAD_FIELD', 'Поле не найдено в этом реестре');
  if (f.archived) throw badRequest('ARCHIVED_FIELD', `Поле «${f.label}» в архиве`);
  if (!TILE_TYPES.has(f.type)) throw badRequest('TILE_FIELD_TYPE', 'Плитка считает по полю-списку или значению справочника');
  const ids = [...new Set(input.optionIds)];
  if (!ids.length) throw badRequest('NO_OPTIONS', 'Выберите хотя бы одно значение');
  if (ids.length > TILE_OPTIONS_MAX) throw badRequest('TOO_MANY_OPTIONS', `Не больше ${TILE_OPTIONS_MAX} значений`);
  for (const id of ids) {
    const o = f.options.find((x) => x.id === id);
    if (!o) throw badRequest('BAD_OPTION', `Значение не найдено в поле «${f.label}». Обновите страницу`);
    // Плитка считает без закрытых записей: закрытый статус дал бы всегда 0.
    if (f.isStatus && o.isClosed) throw badRequest('CLOSED_OPTION', `«${o.label}» закрывает запись — такие записи плитка не считает`);
  }
  return { reg, field: f, title, optionIds: ids };
}

export async function createTile(db: Db, actor: Actor, input: { registerId: string; fieldId: string; optionIds: string[]; title: string }) {
  return withTx(db, async (tx) => {
    const v = await validate(tx, input);
    const max = await tx.dashboardTile.aggregate({ where: { deletedAt: null }, _max: { sortOrder: true } });
    const t = await tx.dashboardTile.create({
      data: { registerId: v.reg.id, fieldId: v.field.id, title: v.title, optionIds: v.optionIds, sortOrder: (max._max.sortOrder ?? 0) + 1, createdBy: actor.id },
      select,
    });
    const labels = v.optionIds.map((id) => v.field.options.find((o) => o.id === id)?.label);
    await auditSettings(tx, actor, {
      action: 'dashboard.tile.created', entity: 'dashboard_tile', entityId: t.id,
      summary: `Дашборд: плитка «${v.title}» — «${v.reg.name}», «${v.field.label}» ∈ {${labels.join(', ')}}`,
      after: { registerId: v.reg.id, fieldId: v.field.id, optionIds: v.optionIds, title: v.title },
    });
    return toDto(tx, t, new Map([[v.reg.id, v.reg]]));
  });
}

export async function updateTile(db: Db, actor: Actor, id: string, input: { version: number; title?: string; optionIds?: string[]; sortOrder?: number }) {
  return withTx(db, async (tx) => {
    const t = await getTile(tx, id);
    if (t.version !== input.version) throw versionConflict();
    const v = await validate(tx, { registerId: t.registerId, fieldId: t.fieldId, title: input.title ?? t.title, optionIds: input.optionIds ?? t.optionIds });
    const sortOrder = input.sortOrder ?? t.sortOrder;
    const res = await tx.dashboardTile.updateMany({
      where: { id, version: input.version, deletedAt: null },
      data: { title: v.title, optionIds: v.optionIds, sortOrder, version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.dashboardTile.findFirst({ where: { id, deletedAt: null } }), 'Плитка');
    await auditSettings(tx, actor, {
      action: 'dashboard.tile.updated', entity: 'dashboard_tile', entityId: id,
      summary: `Дашборд: плитка «${t.title}» изменена`,
      before: { title: t.title, optionIds: t.optionIds, sortOrder: t.sortOrder },
      after: { title: v.title, optionIds: v.optionIds, sortOrder },
    });
    return toDto(tx, await getTile(tx, id), new Map([[v.reg.id, v.reg]]));
  });
}

/** Удаление мягкое (у роли приложения нет DELETE на dashboard_tiles), в журнале — снимок. */
export async function deleteTile(db: Db, actor: Actor, id: string, version: number) {
  await withTx(db, async (tx) => {
    const t = await getTile(tx, id);
    if (t.version !== version) throw versionConflict();
    const res = await tx.dashboardTile.updateMany({ where: { id, version, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.dashboardTile.findFirst({ where: { id, deletedAt: null } }), 'Плитка');
    await auditSettings(tx, actor, {
      action: 'dashboard.tile.deleted', entity: 'dashboard_tile', entityId: id,
      summary: `Дашборд: удалена плитка «${t.title}»`,
      before: { registerId: t.registerId, fieldId: t.fieldId, optionIds: t.optionIds, title: t.title },
    });
  });
}

/** Фильтр плитки — он же в ссылке: открытые записи, поле ∈ {значения}. */
export function tileFilter(t: Pick<TileRow, 'fieldId' | 'optionIds'>, optionIds = t.optionIds): RecordFilter {
  return { state: 'open', field: { fieldId: t.fieldId, values: optionIds } };
}

/** Данные плитки: итог и разбивка по значениям (каждое — ссылка в реестр с тем же фильтром). */
export async function tileData(db: Db, id: string): Promise<WidgetData> {
  const t = await getTile(db, id);
  const reg = await loadRegister(db, t.registerId);
  const dto = await toDto(db, t, new Map([[reg.id, reg]]));
  const base: WidgetData = {
    key: `tile:${t.id}`, title: t.title, kind: 'tile', source: reg.name, registerId: reg.id,
    link: null, total: null, rows: [], stats: [], items: [],
  };
  if (dto.broken) return { ...base, stats: [{ label: dto.broken, value: null, tone: 'muted', link: null }] };
  const total = await countRecords(db, reg, tileFilter(t));
  const rows = await Promise.all(dto.options.map(async (o) => ({
    label: o.label,
    count: await countRecords(db, reg, tileFilter(t, [o.id])),
    link: registerLink(reg.id, tileFilter(t, [o.id])),
    tone: null,
  })));
  return { ...base, total, link: registerLink(reg.id, tileFilter(t)), rows };
}
