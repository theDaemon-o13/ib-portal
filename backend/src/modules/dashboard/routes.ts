import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { TONES } from '../../lib/tones.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import type { DashboardCache } from './cache.js';
import { computeKpis, DASHBOARD_KPIS, KPI_KEYS, listWidgets, widgetData } from './service.js';
import * as tiles from './tiles.service.js';

const tags = ['dashboard'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const view = requirePerm('ib.work');
const manage = requirePerm('registers.manage');
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const Tone = z.enum(TONES).nullable();

export const Kpi = z.object({
  key: z.enum(KPI_KEYS),
  label: z.string(),
  value: z.number().int().nullable(),
  tone: z.enum(['bad', 'warn']).nullable(),
  source: z.string(),
  link: z.string().nullable(),
});
const WidgetKind = z.enum(['distribution', 'metric', 'timeline', 'deadline', 'tile', 'bars']);
const WidgetRef = z.object({ key: z.string(), title: z.string(), kind: WidgetKind, source: z.string(), registerId: z.string().nullable() });
const WidgetData = WidgetRef.extend({
  link: z.string().nullable(),
  total: z.number().int().nullable(),
  rows: z.array(z.object({ label: z.string(), count: z.number().int(), link: z.string().nullable(), tone: Tone })),
  stats: z.array(z.object({ label: z.string(), value: z.number().nullable(), tone: Tone, link: z.string().nullable() })),
  items: z.array(z.object({ id: z.string(), title: z.string(), sub: z.string(), date: z.string().nullable(), days: z.number().int().nullable(), link: z.string() })),
  computedAt: z.string(),
});
const Tile = z.object({
  id: z.string(),
  title: z.string(),
  register: z.object({ id: z.string(), name: z.string(), archived: z.boolean() }),
  field: z.object({ id: z.string(), label: z.string(), archived: z.boolean() }),
  options: z.array(z.object({ id: z.string(), label: z.string(), archived: z.boolean() })),
  broken: z.string().nullable(),
  sortOrder: z.number().int(),
  version: z.number().int(),
});
const TileTitle = z.string().max(tiles.TILE_TITLE_MAX);
const OptionIds = z.array(z.string().uuid()).min(1).max(tiles.TILE_OPTIONS_MAX);

export const dashboardRoutes: FastifyPluginAsyncZod<{ db: Db; cache: DashboardCache }> = async (app, { db, cache }) => {
  app.get('/dashboard/kpis', {
    preHandler: view,
    schema: {
      tags, summary: 'KPI дашборда одним запросом (кэш 1 минута). У каждого — ссылка в раздел с тем же фильтром',
      response: { 200: z.object({ items: z.array(Kpi), computedAt: z.string() }), ...errors },
    },
  }, async () => {
    const { value, computedAt } = await cache.get('kpis', () => computeKpis(db));
    return { items: value.filter((k) => DASHBOARD_KPIS.includes(k.key)), computedAt };
  });

  app.get('/dashboard/widgets', {
    preHandler: view,
    schema: {
      tags, summary: 'Состав дашборда: плитки-счётчики и виджеты из полей с ролью аналитики (без данных)',
      response: { 200: z.object({ tiles: z.array(WidgetRef), widgets: z.array(WidgetRef) }), ...errors },
    },
  }, async () => {
    const list = await tiles.listTiles(db);
    return {
      tiles: list.filter((t) => !t.broken).map((t) => ({ key: `tile:${t.id}`, title: t.title, kind: 'tile' as const, source: t.register.name, registerId: t.register.id })),
      widgets: await listWidgets(db),
    };
  });

  app.get('/dashboard/widgets/:key', {
    preHandler: view,
    schema: {
      tags, summary: 'Данные одного виджета или плитки (кэш 1 минута): field:<id>, tile:<id>, tasks.categories, documents.status, evidence.state',
      params: z.object({ key: z.string().max(64).regex(/^(field:|tile:)?[0-9a-z.-]+$/i) }),
      response: { 200: WidgetData, ...errors },
    },
  }, async (request) => {
    const { key } = request.params;
    const tileId = /^tile:([0-9a-f-]{36})$/i.exec(key)?.[1];
    const { value, computedAt } = await cache.get(`widget:${key}`, () => (tileId ? tiles.tileData(db, tileId) : widgetData(db, key)));
    return { ...value, computedAt };
  });

  app.get('/dashboard/tiles', {
    preHandler: view,
    schema: { tags, summary: 'Плитки-счётчики: настройка (с признаком «не считается»)', response: { 200: z.object({ items: z.array(Tile) }), ...errors } },
  }, async () => ({ items: await tiles.listTiles(db) }));

  app.post('/dashboard/tiles', {
    preHandler: manage,
    schema: {
      tags, summary: 'Добавить плитку: записи реестра, где поле ∈ {значения}, без закрытых',
      body: z.object({ registerId: z.string().uuid(), fieldId: z.string().uuid(), optionIds: OptionIds, title: TileTitle }),
      response: { 201: Tile, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await tiles.createTile(db, actorOf(request), request.body)));

  app.patch('/dashboard/tiles/:id', {
    preHandler: manage,
    schema: {
      tags, summary: 'Изменить плитку: название, значения, порядок', params: IdParams,
      body: Version.extend({ title: TileTitle.optional(), optionIds: OptionIds.optional(), sortOrder: z.number().int().min(0).max(100_000).optional() }),
      response: { 200: Tile, ...errors },
    },
  }, async (request) => {
    const tile = await tiles.updateTile(db, actorOf(request), request.params.id, request.body);
    cache.invalidate(`widget:tile:${tile.id}`);
    return tile;
  });

  app.post('/dashboard/tiles/:id/delete', {
    preHandler: manage,
    schema: { tags, summary: 'Удалить плитку (мягкое удаление)', params: IdParams, body: Version, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await tiles.deleteTile(db, actorOf(request), request.params.id, request.body.version);
    cache.invalidate(`widget:tile:${request.params.id}`);
    return reply.status(204).send(null);
  });
};
