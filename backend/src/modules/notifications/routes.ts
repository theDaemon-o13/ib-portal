// Уведомления адресата (релиз 1.2.0, ADR-0023): все запросы — только по пользователю из сессии.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { KIOSK_PERMISSION, PERMISSION_CODES } from '../../lib/permissions.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAnyPerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['notifications'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse };
/** Любой вошедший пользователь, кроме настенного монитора. */
const anyUser = requireAnyPerm(PERMISSION_CODES.filter((c) => c !== KIOSK_PERMISSION));

const Notification = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  /** Кто сделал; null — система. */
  actor: z.string().nullable(),
  createdAt: z.string(),
  read: z.boolean(),
  task: z.object({ id: z.string(), number: z.number().int(), deleted: z.boolean() }).nullable(),
  /** Куда ведёт щелчок; null — некуда (задача удалена). */
  link: z.string().nullable(),
});

export const notificationRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/notifications', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Мои уведомления, новые сверху; unread=true — только непрочитанные',
      querystring: z.object({
        unread: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(svc.LIST_LIMIT).default(20),
        cursor: z.string().uuid().optional(),
      }),
      response: { 200: z.object({ items: z.array(Notification), nextCursor: z.string().nullable(), unread: z.number().int() }), ...errors },
    },
  }, async (request) => svc.listNotifications(db, actorOf(request).id, { ...request.query, unread: request.query.unread === 'true' }));

  app.get('/notifications/count', {
    preHandler: anyUser,
    schema: { tags, summary: 'Число непрочитанных (значок; опрос фоновым запросом)', response: { 200: z.object({ unread: z.number().int() }), ...errors } },
  }, async (request) => ({ unread: await svc.unreadCount(db, actorOf(request).id) }));

  app.post('/notifications/:id/read', {
    preHandler: anyUser,
    schema: { tags, summary: 'Отметить своё уведомление прочитанным (чужое — 404)', params: z.object({ id: z.string().uuid() }), response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await svc.markRead(db, actorOf(request).id, request.params.id);
    return reply.status(204).send(null);
  });

  app.post('/notifications/read-all', {
    preHandler: anyUser,
    schema: { tags, summary: 'Прочитать все мои уведомления', response: { 200: z.object({ marked: z.number().int() }), ...errors } },
  }, async (request) => ({ marked: await svc.markAllRead(db, actorOf(request).id) }));
};
