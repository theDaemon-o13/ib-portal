import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAnyPerm, requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['calendar'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

const WorkWeek = z.object({
  /** ISO: 1 — понедельник … 7 — воскресенье. */
  weekendDays: z.array(z.number().int().min(1).max(7)),
  version: z.number().int(),
});
const Kind = z.enum(['holiday', 'workday']);
export const CalendarDay = z.object({ id: z.string(), day: z.string(), kind: Kind, title: z.string(), version: z.number().int() });
const DayStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IdParams = z.object({ id: z.string().uuid() });

export const calendarRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/calendar/week', {
    preHandler: requireAnyPerm(['ib.work', 'settings.manage']),  // служебный администратор (ADR-0036)
    schema: { tags, summary: 'Выходные дни недели', response: { 200: WorkWeek, ...errors } },
  }, async () => svc.getWorkWeek(db));

  app.put('/calendar/week', {
    preHandler: requirePerm('settings.manage'),
    schema: {
      tags,
      summary: 'Изменить выходные дни недели',
      body: z.object({ weekendDays: z.array(z.number().int().min(1).max(7)).max(7), version: z.number().int().min(0) }),
      response: { 200: WorkWeek, ...errors },
    },
  }, async (request) => svc.setWorkWeek(db, actorOf(request), request.body));

  app.get('/calendar/days', {
    preHandler: requireAnyPerm(['ib.work', 'settings.manage']),  // служебный администратор (ADR-0036)
    schema: {
      tags,
      summary: 'Праздники и переносы за год',
      querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100) }),
      response: { 200: z.object({ items: z.array(CalendarDay) }), ...errors },
    },
  }, async (request) => ({ items: await svc.listDays(db, request.query.year) }));

  app.post('/calendar/days', {
    preHandler: requirePerm('settings.manage'),
    schema: {
      tags,
      summary: 'Добавить праздник или перенос',
      body: z.object({ day: DayStr, kind: Kind, title: z.string().trim().min(1).max(200) }),
      response: { 201: CalendarDay, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await svc.createDay(db, actorOf(request), request.body)));

  app.patch('/calendar/days/:id', {
    preHandler: requirePerm('settings.manage'),
    schema: {
      tags,
      summary: 'Изменить запись календаря',
      params: IdParams,
      body: z.object({
        version: z.number().int().positive(),
        day: DayStr.optional(),
        kind: Kind.optional(),
        title: z.string().trim().min(1).max(200).optional(),
      }),
      response: { 200: CalendarDay, ...errors },
    },
  }, async (request) => svc.updateDay(db, actorOf(request), request.params.id, request.body));

  app.post('/calendar/days/:id/delete', {
    preHandler: requirePerm('settings.manage'),
    schema: {
      tags,
      summary: 'Удалить запись календаря',
      params: IdParams,
      body: z.object({ version: z.number().int().positive() }),
      response: { 204: z.null(), ...errors },
    },
  }, async (request, reply) => {
    await svc.deleteDay(db, actorOf(request), request.params.id, request.body.version);
    return reply.status(204).send(null);
  });
};
