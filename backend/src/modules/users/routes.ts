import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { PageQuery, pageSchema } from '../../lib/pagination.js';
import type { PasswordHasher } from '../../lib/passwords.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['users'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

export const AdminUser = z.object({
  id: z.string(),
  login: z.string(),
  fullName: z.string(),
  position: z.string(),
  department: z.string(),
  isActive: z.boolean(),
  roles: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Руководитель (ADR-0020); null — не назначен. */
  manager: z.object({ id: z.string(), login: z.string(), fullName: z.string(), isActive: z.boolean() }).nullable(),
  /** Прямых подчинённых. */
  subordinateCount: z.number().int(),
  /** «Является начальником ИБ» (1.4.0): не больше одного пользователя. */
  isIbHead: z.boolean(),
  mustChangePassword: z.boolean(),
  passwordExpiresAt: z.string(),
  locked: z.boolean(),
  lockedUntil: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  version: z.number().int(),
});
/** Временный пароль показывается один раз: в ответе на создание и сброс. */
const WithTemporaryPassword = z.object({ user: AdminUser, temporaryPassword: z.string() });
const Text = z.string().trim().max(200);
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const manage = requirePerm('users.manage');

export const userRoutes: FastifyPluginAsyncZod<{ db: Db; hasher: PasswordHasher }> = async (app, { db, hasher }) => {
  app.get('/users', {
    preHandler: requirePerm('ib.work'),
    schema: {
      tags, summary: 'Пользователи портала',
      querystring: PageQuery.extend({ q: z.string().max(100).optional() }),
      response: { 200: pageSchema(AdminUser), ...errors },
    },
  }, async (request) => svc.listUsers(db, { ...request.query, search: request.query.q }));

  app.get('/users/options', {
    preHandler: requirePerm('ib.work'),
    schema: {
      tags, summary: 'Активные сотрудники ИБ для выбора ответственного; scope=all — все активные (владелец системы)',
      querystring: z.object({ scope: z.enum(['ib', 'all']).optional() }),
      response: {
        200: z.object({ items: z.array(z.object({ id: z.string(), login: z.string(), fullName: z.string(), ibWork: z.boolean() })) }),
        ...errors,
      },
    },
  }, async (request) => ({ items: await svc.userOptions(db, request.query.scope ?? 'ib') }));

  app.post('/users', {
    preHandler: manage,
    schema: {
      tags, summary: 'Создать пользователя (временный пароль генерируется и возвращается один раз)',
      body: z.object({
        login: z.string().trim().min(3).max(64),
        fullName: z.string().trim().min(1).max(200),
        position: Text.default(''),
        department: Text.default(''),
        roleIds: z.array(z.string().uuid()).max(50),
        managerId: z.string().uuid().nullable().optional(),
      }),
      response: { 201: WithTemporaryPassword, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await svc.createUser(db, actorOf(request), hasher, request.body)));

  app.patch('/users/:id', {
    preHandler: manage,
    schema: {
      tags, summary: 'Изменить ФИО, должность, подразделение, роли, руководителя', params: IdParams,
      body: Version.extend({
        fullName: z.string().trim().min(1).max(200).optional(),
        position: Text.optional(),
        department: Text.optional(),
        roleIds: z.array(z.string().uuid()).max(50).optional(),
        managerId: z.string().uuid().nullable().optional(),
      }),
      response: { 200: AdminUser, ...errors },
    },
  }, async (request) => svc.updateUser(db, actorOf(request), request.params.id, request.body));

  for (const [path, active, summary] of [
    ['disable', false, 'Отключить (сессии закрываются)'],
    ['enable', true, 'Включить'],
  ] as const) {
    app.post(`/users/:id/${path}`, {
      preHandler: manage,
      schema: { tags, summary, params: IdParams, body: Version, response: { 200: AdminUser, ...errors } },
    }, async (request) => svc.setActive(db, actorOf(request), request.params.id, request.body.version, active));
  }

  app.put('/users/:id/ib-head', {
    preHandler: manage,
    schema: {
      tags, params: IdParams,
      summary: 'Отметка «Является начальником ИБ»: поставить или снять. Отметка у другого — 409 IB_HEAD_TAKEN (details.holder); transfer=true — передать',
      body: Version.extend({ value: z.boolean(), transfer: z.boolean().optional() }),
      response: { 200: AdminUser, ...errors },
    },
  }, async (request) => svc.setIbHead(db, actorOf(request), request.params.id, request.body));

  app.post('/users/:id/reset-password', {
    preHandler: manage,
    schema: {
      tags, summary: 'Сбросить пароль (временный пароль возвращается один раз)', params: IdParams, body: Version,
      response: { 200: WithTemporaryPassword, ...errors },
    },
  }, async (request) => svc.resetPassword(db, actorOf(request), hasher, request.params.id, request.body.version));

  app.post('/users/:id/unlock', {
    preHandler: manage,
    schema: { tags, summary: 'Снять блокировку входа', params: IdParams, body: Version, response: { 200: AdminUser, ...errors } },
  }, async (request) => svc.unlock(db, actorOf(request), request.params.id, request.body.version));
};
