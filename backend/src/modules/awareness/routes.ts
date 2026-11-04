// Маршруты «Осведомлённости» (релиз 1.8.0). Импорт отчёта INDIGO — общий маршрут импорта реестров (?adapter=indigo);
// здесь — «Обновить по сотрудникам» (docs/specs/awareness.md, раздел 5): предпросмотр и применение, право records.edit.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { applyRefresh, previewRefresh } from './refresh.service.js';

const tags = ['awareness'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });

const RefreshItem = z.object({
  recordId: z.string(),
  number: z.number().int(),
  version: z.number().int(),
  fio: z.string(),
  test: z.string(),
  date: z.string().nullable(),
  employee: z.object({ id: z.string(), number: z.number().int(), fio: z.string() }),
  /** Подразделение «было → станет»: из «Группы INDIGO» → из сотрудника. */
  deptFrom: z.string(),
  deptTo: z.string(),
});

export const awarenessRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const edit = requirePerm('records.edit');

  app.post('/registers/:id/awareness/refresh/preview', {
    preHandler: edit,
    schema: {
      tags, params: IdParams,
      summary: '«Обновить по сотрудникам», шаг 1: записи «Не сопоставлен», которые теперь сопоставляются «Точно»',
      response: { 200: z.object({ items: z.array(RefreshItem), total: z.number().int() }), ...errors },
    },
  }, async (request) => previewRefresh(db, request.params.id));

  app.post('/registers/:id/awareness/refresh/apply', {
    preHandler: edit,
    schema: {
      tags, params: IdParams,
      summary: '«Обновить по сотрудникам», шаг 2: отмеченные записи — связь, «Точно», подразделение сотрудника. expected — число строк предпросмотра (разошлось — 409 BULK_CHANGED)',
      body: z.object({ recordIds: z.array(z.string().uuid()).max(20_000), expected: z.number().int().min(0) }),
      response: { 200: z.object({ updated: z.number().int(), skipped: z.number().int() }), ...errors },
    },
  }, async (request) => applyRefresh(db, actorOf(request), request.params.id, request.body));
};
