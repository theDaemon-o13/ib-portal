import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { TONES } from '../../lib/tones.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAnyPerm, requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import type { DashboardCache } from '../dashboard/cache.js';
import { Kpi, WidgetData } from '../dashboard/routes.js';
import * as slides from './slides.service.js';

const Tone = z.enum(TONES).nullable();

const Vulns = z.object({
    registerId: z.string(),
    total: z.number().int(),
    items: z.array(z.object({
      id: z.string(), number: z.number().int(), title: z.string(), pkg: z.string(), desc: z.string(),
      crit: z.object({ label: z.string(), tone: Tone }).nullable(),
      hits: z.number().nullable(), score: z.number().nullable(), due: z.string().nullable(), days: z.number().int().nullable(),
    })),
    buckets: z.array(z.object({ key: z.enum(['overdue', 'd0_7', 'd8_14', 'd15_30', 'd31', 'none']), label: z.string(), count: z.number().int(), tone: Tone })),
    dates: z.array(z.object({ date: z.string(), days: z.number().int(), count: z.number().int() })),
    packages: z.array(z.object({ label: z.string(), count: z.number().int() })),
});
const Item = z.object({
  kind: z.enum(['task', 'document', 'risk', 'evidence']), id: z.string(), title: z.string(), sub: z.string(), due: z.string(), days: z.number().int(),
});
const Filter = z.object({
  period: z.enum(['all', 'overdue', 'within']).optional(), days: z.number().int().min(1).max(365).optional(),
  kpis: z.array(z.string().max(40)).max(20).optional(),
  crit: z.array(z.string().uuid()).max(20).optional(), departments: z.array(z.string().uuid()).max(100).optional(),
  systems: z.array(z.string().uuid()).max(200).optional(), categories: z.array(z.string().uuid()).max(50).optional(),
  types: z.array(z.string().uuid()).max(50).optional(), registerId: z.string().uuid().optional(),
});
const SlideIn = z.object({
  kind: z.enum(slides.SLIDE_KINDS), title: z.string().max(120), seconds: z.number().int(),
  filter: Filter, enabled: z.boolean(), skipEmpty: z.boolean(),
});
const Slide = SlideIn.extend({ id: z.string(), sortOrder: z.number().int(), version: z.number().int() });
const SlideData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('kpis'), items: z.array(Kpi) }),
  z.object({ kind: z.literal('vulns'), vulns: Vulns.nullable() }),
  z.object({ kind: z.literal('items'), items: z.array(Item) }),
  z.object({ kind: z.literal('dlp'), widget: WidgetData.omit({ computedAt: true }).nullable() }),
]);
const SlideWithData = Slide.extend({ data: SlideData, empty: z.boolean() });
const MonitorResponse = z.object({
  computedAt: z.string(),
  /** Меняется, когда меняется набор слайдов: экран переключается на новый набор на границе слайда. */
  signature: z.string(),
  slides: z.array(SlideWithData),
});
const Option = z.object({ id: z.string(), label: z.string() });
const IdParams = z.object({ id: z.string().uuid() });
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

export const monitorRoutes: FastifyPluginAsyncZod<{ db: Db; cache: DashboardCache }> = async (app, { db, cache }) => {
  app.get('/monitor', {
    // Сотрудник ИБ или учётная запись настенного монитора (единственный маршрут данных, открытый киоску).
    preHandler: requireAnyPerm(['ib.work', 'monitor.kiosk']),
    config: { kiosk: true },
    schema: {
      tags: ['monitor'],
      summary: 'Экран мониторинга одним запросом (кэш 1 минута): включённые слайды по порядку с данными каждого (релиз 1.1.0)',
      response: { 200: MonitorResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
  }, async () => {
    const { value, computedAt } = await cache.get('monitor', () => slides.monitorScreen(db));
    return { ...value, computedAt };
  });

  // ------------------------------------------------------------ настройка слайдов (settings.manage, ADR-0019)
  const manage = requirePerm('settings.manage');
  // Правка слайдов — экран видит её при следующем обновлении (кэш сбрасывается сразу).
  const changed = <T>(v: T): T => {
    cache.invalidate('monitor');
    return v;
  };

  app.get('/monitor/slides', {
    preHandler: manage,
    schema: { tags: ['monitor'], summary: 'Слайды экрана мониторинга (и выключенные)', response: { 200: z.object({ items: z.array(Slide) }), ...errors } },
  }, async () => ({ items: await slides.listSlides(db) }));

  app.get('/monitor/slide-options', {
    preHandler: manage,
    schema: {
      tags: ['monitor'], summary: 'Значения для формы слайда',
      response: {
        200: z.object({
          kinds: z.array(z.object({ kind: z.enum(slides.SLIDE_KINDS), label: z.string() })),
          kpis: z.array(Option), crit: z.array(Option), departments: z.array(Option), systems: z.array(Option),
          categories: z.array(Option), types: z.array(Option), registers: z.array(Option),
          seconds: z.object({ min: z.number().int(), max: z.number().int(), default: z.number().int() }),
        }),
        ...errors,
      },
    },
  }, async () => slides.slideOptions(db));

  app.post('/monitor/slides/preview', {
    preHandler: manage,
    schema: { tags: ['monitor'], summary: 'Предпросмотр слайда — данные так, как они будут на мониторе', body: SlideIn, response: { 200: SlideWithData, ...errors } },
  }, async (request) => slides.previewSlide(db, request.body));

  app.post('/monitor/slides', {
    preHandler: manage,
    schema: { tags: ['monitor'], summary: 'Добавить слайд (в конец)', body: SlideIn, response: { 201: Slide, ...errors } },
  }, async (request, reply) => reply.status(201).send(changed(await slides.createSlide(db, actorOf(request), request.body))));

  app.patch('/monitor/slides/:id', {
    preHandler: manage,
    schema: { tags: ['monitor'], summary: 'Изменить слайд', params: IdParams, body: SlideIn.extend({ version: z.number().int() }), response: { 200: Slide, ...errors } },
  }, async (request) => {
    const { version, ...input } = request.body;
    return changed(await slides.updateSlide(db, actorOf(request), request.params.id, version, input));
  });

  app.post('/monitor/slides/:id/move', {
    preHandler: manage,
    schema: { tags: ['monitor'], summary: 'Слайд выше или ниже', params: IdParams, body: z.object({ direction: z.enum(['up', 'down']) }), response: { 200: z.object({ items: z.array(Slide) }), ...errors } },
  }, async (request) => ({ items: changed(await slides.moveSlide(db, actorOf(request), request.params.id, request.body.direction)) }));

  app.post('/monitor/slides/:id/delete', {
    preHandler: manage,
    schema: { tags: ['monitor'], summary: 'Удалить слайд (мягко)', params: IdParams, body: z.object({ version: z.number().int() }), response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await slides.deleteSlide(db, actorOf(request), request.params.id, request.body.version);
    changed(null);
    return reply.status(204).send(null);
  });
};
