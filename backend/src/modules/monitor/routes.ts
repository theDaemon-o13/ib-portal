import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { TONES } from '../../lib/tones.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAnyPerm } from '../../plugins/rbac.js';
import type { DashboardCache } from '../dashboard/cache.js';
import { Kpi } from '../dashboard/routes.js';
import { monitorData } from './service.js';

const Tone = z.enum(TONES).nullable();

const MonitorResponse = z.object({
  computedAt: z.string(),
  kpis: z.array(Kpi),
  vulns: z.object({
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
  }).nullable(),
  items: z.array(z.object({
    kind: z.enum(['task', 'document', 'risk', 'evidence']), id: z.string(), title: z.string(), sub: z.string(), due: z.string(), days: z.number().int(),
  })),
});

export const monitorRoutes: FastifyPluginAsyncZod<{ db: Db; cache: DashboardCache }> = async (app, { db, cache }) => {
  app.get('/monitor', {
    // Сотрудник ИБ или учётная запись настенного монитора (единственный маршрут данных, открытый киоску).
    preHandler: requireAnyPerm(['ib.work', 'monitor.kiosk']),
    config: { kiosk: true },
    schema: {
      tags: ['monitor'],
      summary: 'Экран мониторинга одним запросом (кэш 1 минута): KPI, уязвимости с днями до срока, задачи, документы, риски, доказательства',
      response: { 200: MonitorResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
  }, async () => {
    const { value, computedAt } = await cache.get('monitor', () => monitorData(db));
    return { ...value, computedAt };
  });
};
