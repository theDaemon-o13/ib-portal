import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { forbidden } from '../../lib/errors.js';
import { TONES } from '../../lib/tones.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAuth, requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['catalogs'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

export const Catalog = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(['values', 'statuses', 'mail_rules']),
  hasColor: z.boolean(),
  itemCount: z.number().int(),
  archivedCount: z.number().int(),
});

export const CatalogItem = z.object({
  id: z.string(),
  catalogCode: z.string(),
  value: z.string(),
  color: z.enum(TONES).nullable(),
  isSystem: z.boolean(),
  systemKey: z.string().nullable(),
  systemReason: z.string().nullable(),
  keywords: z.array(z.string()),
  owner: z.object({ id: z.string(), fullName: z.string(), isActive: z.boolean() }).nullable(),
  /** «Получатели уведомлений»: участники (пользователи с ib.work) и адреса вне портала. */
  members: z.array(z.object({ id: z.string(), fullName: z.string(), isActive: z.boolean() })),
  emails: z.array(z.string()),
  sortOrder: z.number().int(),
  /** «Статусы задач»: обязателен комментарий при переходе вперёд / при возврате (ADR-0022). */
  commentForward: z.boolean(),
  commentReturn: z.boolean(),
  version: z.number().int(),
  archived: z.boolean(),
  /** Сколько записей ссылается на значение. */
  usage: z.number().int(),
});

const Value = z.string().trim().min(1).max(200);
const Keywords = z.array(z.string().max(100)).max(50);
const Members = z.array(z.string().uuid()).max(50);
const Emails = z.array(z.string().max(254)).max(50);
const Version = z.object({ version: z.number().int().positive() });
const IdParams = z.object({ id: z.string().uuid() });

export const catalogRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/catalogs', {
    preHandler: requireAuth(),
    schema: { tags, summary: 'Справочники', response: { 200: z.object({ items: z.array(Catalog) }), ...errors } },
  }, async () => ({ items: await svc.listCatalogs(db) }));

  app.get('/catalogs/:code/items', {
    preHandler: requireAuth(),
    schema: {
      tags,
      summary: 'Значения справочника. includeArchived — для настроек (нужно право «Работа в разделах ИБ»)',
      params: z.object({ code: z.string().max(64) }),
      querystring: z.object({ includeArchived: z.enum(['true', 'false']).optional() }),
      response: { 200: z.object({ items: z.array(CatalogItem) }), ...errors },
    },
  }, async (request) => {
    const includeArchived = request.query.includeArchived === 'true';
    // Архивные значения — сотрудникам ИБ и тем, кто ведёт справочники (служебный администратор, ADR-0036).
    if (includeArchived && !request.user?.permissions.has('ib.work') && !request.user?.permissions.has('settings.manage')) throw forbidden();
    return { items: (await svc.listItems(db, request.params.code, { includeArchived })) as z.infer<typeof CatalogItem>[] };
  });

  app.post('/catalogs/:code/items', {
    preHandler: requirePerm('settings.manage'),
    schema: {
      tags,
      summary: 'Добавить значение',
      params: z.object({ code: z.string().max(64) }),
      body: z.object({
        value: Value,
        color: z.enum(TONES).nullable().optional(),
        keywords: Keywords.optional(),
        ownerUserId: z.string().uuid().nullable().optional(),
        memberIds: Members.optional(),
        emails: Emails.optional(),
        commentForward: z.boolean().optional(),
        commentReturn: z.boolean().optional(),
        afterId: z.string().uuid().nullable().optional(),
      }),
      response: { 201: CatalogItem, ...errors },
    },
  }, async (request, reply) => {
    const item = await svc.createItem(db, actorOf(request), request.params.code, request.body);
    return reply.status(201).send(item as z.infer<typeof CatalogItem>);
  });

  app.patch('/catalog-items/:id', {
    preHandler: requirePerm('settings.manage'),
    schema: {
      tags,
      summary: 'Изменить значение (переименование, цвет, правило почты, владелец системы, участники и e-mail метки)',
      params: IdParams,
      body: Version.extend({
        value: Value.optional(),
        color: z.enum(TONES).nullable().optional(),
        keywords: Keywords.optional(),
        ownerUserId: z.string().uuid().nullable().optional(),
        memberIds: Members.optional(),
        emails: Emails.optional(),
        commentForward: z.boolean().optional(),
        commentReturn: z.boolean().optional(),
        afterId: z.string().uuid().nullable().optional(),
      }),
      response: { 200: CatalogItem, ...errors },
    },
  }, async (request) =>
    (await svc.updateItem(db, actorOf(request), request.params.id, request.body)) as z.infer<typeof CatalogItem>);

  app.post('/catalog-items/:id/archive', {
    preHandler: requirePerm('settings.manage'),
    schema: { tags, summary: 'В архив', params: IdParams, body: Version, response: { 200: CatalogItem, ...errors } },
  }, async (request) =>
    (await svc.archiveItem(db, actorOf(request), request.params.id, request.body.version)) as z.infer<typeof CatalogItem>);

  app.post('/catalog-items/:id/restore', {
    preHandler: requirePerm('settings.manage'),
    schema: { tags, summary: 'Вернуть из архива', params: IdParams, body: Version, response: { 200: CatalogItem, ...errors } },
  }, async (request) =>
    (await svc.restoreItem(db, actorOf(request), request.params.id, request.body.version)) as z.infer<typeof CatalogItem>);

  app.post('/catalog-items/:id/delete', {
    preHandler: requirePerm('settings.manage'),
    schema: {
      tags,
      summary: 'Удалить неиспользуемое значение (мягкое удаление)',
      params: IdParams,
      body: Version,
      response: { 204: z.null(), ...errors },
    },
  }, async (request, reply) => {
    await svc.deleteItem(db, actorOf(request), request.params.id, request.body.version);
    return reply.status(204).send(null);
  });
};
