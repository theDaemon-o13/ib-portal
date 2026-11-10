import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAllPerms, requireAuth } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['party-directory'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

const Person = z.object({
  id: z.string(),
  fullName: z.string(),
  position: z.string(),
  /** Почта (1.13.6); нет — ''. */
  email: z.string(),
  active: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const Items = z.object({ items: z.array(Person) });
const ItemParams = z.object({ itemId: z.string().uuid() });

export const partyDirectoryRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  // Справочник с реальными ФИО и должностями — данные банка: settings.manage и ib.work (1.8.0, ADR-0036).
  const manage = requireAllPerms(['settings.manage', 'ib.work']);

  app.get('/settings/party-directory', {
    preHandler: manage,
    schema: { tags, summary: 'Справочник «Ответственные лица»: все записи, включая отключённые, по ФИО (1.6.7)', response: { 200: Items, ...errors } },
  }, async () => ({ items: await svc.listDirectory(db) }));

  app.post('/settings/party-directory', {
    preHandler: manage,
    schema: {
      tags, summary: 'Добавить запись. Такое же ФИО и такая же почта не запрещены: sameName и sameEmail — записи с тем же ФИО и той же почтой',
      body: z.object({ fullName: z.string().max(svc.PERSON_NAME_MAX), position: z.string().max(svc.PERSON_POSITION_MAX).optional(), email: z.string().max(400).optional() }),
      response: { 200: z.object({ item: Person, sameName: z.array(Person), sameEmail: z.array(Person) }), ...errors },
    },
  }, async (request) => svc.createPerson(db, actorOf(request), request.body));

  app.patch('/settings/party-directory/:itemId', {
    preHandler: manage,
    schema: {
      tags, summary: 'Изменить ФИО, должность и почту, отключить или включить; sameEmail — у кого ещё такая почта. Удаления нет. Уже добавленные в документы лица не меняются',
      params: ItemParams,
      body: z.object({
        version: z.number().int(),
        fullName: z.string().max(svc.PERSON_NAME_MAX).optional(),
        position: z.string().max(svc.PERSON_POSITION_MAX).optional(),
        /** '' — снять почту. */
        email: z.string().max(400).optional(),
        active: z.boolean().optional(),
      }),
      response: { 200: z.object({ item: Person, sameEmail: z.array(Person) }), ...errors },
    },
  }, async (request) => svc.updatePerson(db, actorOf(request), request.params.itemId, request.body));

  // Раздел «Документы» открыт всем вошедшим; кто ведёт лиц документа — решает сервис (как у POST /documents/:id/parties).
  app.get('/documents/:id/party-directory', {
    preHandler: requireAuth(),
    schema: {
      tags, summary: 'Активные записи справочника для выбора ответственного лица: автору и начальнику ИБ на этапах 11–14',
      params: z.object({ id: z.string().uuid() }),
      response: { 200: Items, ...errors },
    },
  }, async (request) => ({ items: await svc.directoryForDocument(db, actorOf(request).id, request.params.id) }));
};
