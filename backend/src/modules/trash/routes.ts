// Корзина (1.6.1, ADR-0033): просмотр — ib.work, только чтение; восстановление — системная роль «Супер-администратор».
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm, requireSuperAdmin } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { DELETION_ENTITIES, listDeletions, restoreDeletion } from './service.js';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

const Deletion = z.object({
  id: z.string(),
  entity: z.enum(DELETION_ENTITIES),
  entityLabel: z.string(),
  entityId: z.string(),
  vulns: z.boolean(),
  title: z.string(),
  path: z.string(),
  reasonCode: z.string().nullable(),
  reasonLabel: z.string().nullable(),
  reason: z.string(),
  counts: z.record(z.string(), z.number()),
  /** Записи уязвимостей, открытые на момент удаления. */
  openRecords: z.number().int(),
  items: z.array(z.object({ number: z.number().int(), title: z.string(), status: z.string().nullable(), open: z.boolean().nullable(), due: z.string().nullable() })),
  deletedAt: z.string(),
  deletedBy: z.string(),
  restoredAt: z.string().nullable(),
  restoredBy: z.string().nullable(),
});

export const trashRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const superAdmin = requireSuperAdmin(async (userId) => (await db.userRole.count({ where: { userId, role: { code: 'super_admin' } } })) > 0);

  app.get('/trash', {
    preHandler: requirePerm('ib.work'),
    schema: {
      tags: ['trash'], summary: 'Корзина: события удаления, новые сверху. scope=vulns — раздел «Уязвимости» (с узлом или группой)',
      querystring: z.object({
        entity: z.enum(DELETION_ENTITIES).optional(),
        scope: z.enum(['vulns']).optional(),
        nodeId: z.string().uuid().optional(),
        groupId: z.string().uuid().optional(),
        restored: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        cursor: z.string().uuid().optional(),
      }),
      response: { 200: z.object({ items: z.array(Deletion), nextCursor: z.string().nullable() }), ...errors },
    },
  }, async (request) => {
    const { restored, ...q } = request.query;
    return listDeletions(db, { ...q, restored: restored === undefined ? undefined : restored === 'true' });
  });

  app.post('/trash/:id/restore', {
    preHandler: superAdmin,
    schema: {
      tags: ['trash'], summary: 'Восстановить всё, что скрыто этим удалением. Название занято — newName',
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ newName: z.string().max(400).nullish() }).nullish(),
      response: { 200: z.object({ id: z.string(), counts: z.record(z.string(), z.number()) }), ...errors },
    },
  }, async (request) => restoreDeletion(db, actorOf(request), request.params.id, request.body ?? {}));
};
