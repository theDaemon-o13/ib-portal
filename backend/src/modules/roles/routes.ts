import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { PERMISSION_CODES, type PermissionCode } from '../../lib/permissions.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['roles'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const Perm = z.enum(PERMISSION_CODES as [PermissionCode, ...PermissionCode[]]);

export const Role = z.object({
  id: z.string(),
  code: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  isSystem: z.boolean(),
  version: z.number().int(),
  permissions: z.array(Perm),
  lockedPermissions: z.array(Perm),
  forbiddenPermissions: z.array(Perm),
  activeUserCount: z.number().int(),
  userCount: z.number().int(),
});
const Permission = z.object({ code: z.string(), name: z.string(), description: z.string() });
const IdParams = z.object({ id: z.string().uuid() });
const manage = requirePerm('users.manage');

export const roleRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/permissions', {
    preHandler: requirePerm('ib.work'),
    schema: { tags, summary: 'Коды прав', response: { 200: z.object({ items: z.array(Permission) }), ...errors } },
  }, async () => ({ items: await svc.listPermissions(db) }));

  app.get('/roles', {
    preHandler: requirePerm('ib.work'),
    schema: { tags, summary: 'Роли и их права', response: { 200: z.object({ items: z.array(Role) }), ...errors } },
  }, async () => ({ items: await svc.listRoles(db) }));

  app.post('/roles', {
    preHandler: manage,
    schema: {
      tags, summary: 'Создать роль',
      body: z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(300).default('') }),
      response: { 201: Role, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await svc.createRole(db, actorOf(request), request.body)));

  app.patch('/roles/:id', {
    preHandler: manage,
    schema: {
      tags, summary: 'Переименовать роль или изменить описание', params: IdParams,
      body: z.object({
        version: z.number().int().positive(),
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().trim().max(300).optional(),
      }),
      response: { 200: Role, ...errors },
    },
  }, async (request) => svc.updateRole(db, actorOf(request), request.params.id, request.body));

  app.post('/roles/:id/delete', {
    preHandler: manage,
    schema: {
      tags, summary: 'Удалить несистемную роль без пользователей', params: IdParams,
      body: z.object({ version: z.number().int().positive() }),
      response: { 204: z.null(), ...errors },
    },
  }, async (request, reply) => {
    await svc.deleteRole(db, actorOf(request), request.params.id, request.body.version);
    return reply.status(204).send(null);
  });

  app.put('/roles/:id/permissions/:code', {
    preHandler: manage,
    schema: {
      tags, summary: 'Выдать или снять право у роли',
      params: z.object({ id: z.string().uuid(), code: Perm }),
      body: z.object({ granted: z.boolean() }),
      response: { 200: Role, ...errors },
    },
  }, async (request) => svc.setRolePermission(db, actorOf(request), request.params.id, request.params.code, request.body.granted));
};
