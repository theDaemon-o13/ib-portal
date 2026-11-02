// «Параметры портала» (релиз 1.6.0): только системная роль «Супер-администратор», не отдельное право.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireSuperAdmin } from '../../plugins/rbac.js';
import { actorOf } from './common.js';
import { listPortalParams, resetPortalParam, updatePortalParam } from './portal-params.js';

const tags = ['settings'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const Param = z.object({
  key: z.string(), title: z.string(), description: z.string(), form: z.enum(['vulns', 'assets', 'lines', 'text', 'json']),
  value: z.unknown(), defaultValue: z.unknown(), isDefault: z.boolean(), version: z.number().int(),
});
const Option = z.object({ id: z.string(), label: z.string() });
const Key = z.object({ key: z.string().max(100) });

export const portalParamRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const guard = requireSuperAdmin(async (userId) => (await db.userRole.count({ where: { userId, role: { code: 'super_admin' } } })) > 0);

  app.get('/settings/portal-params', {
    preHandler: guard,
    schema: {
      tags, summary: 'Параметры портала: значение, значение по умолчанию, варианты для форм',
      response: { 200: z.object({ items: z.array(Param), options: z.object({ levels: z.array(Option), systemTypes: z.array(Option), registers: z.array(Option) }) }), ...errors },
    },
  }, async () => listPortalParams(db));

  app.put('/settings/portal-params/:key', {
    preHandler: guard,
    schema: { tags, summary: 'Изменить параметр: проверка по схеме ключа, журнал было → стало', params: Key, body: z.object({ value: z.unknown(), version: z.number().int() }), response: { 200: Param, ...errors } },
  }, async (request) => updatePortalParam(db, actorOf(request), request.params.key, request.body));

  app.post('/settings/portal-params/:key/reset', {
    preHandler: guard,
    schema: { tags, summary: 'Сбросить к умолчанию: строка удаляется, журнал было → стало', params: Key, body: z.object({ version: z.number().int() }), response: { 200: Param, ...errors } },
  }, async (request) => resetPortalParam(db, actorOf(request), request.params.key, request.body));
};
