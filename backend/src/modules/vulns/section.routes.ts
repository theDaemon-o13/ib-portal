// Раздел «Уязвимости» (релиз 1.5.0, ADR-0029, ADR-0030): группы, узлы, сканы, сроки.
// Просмотр — ib.work; структура (группы, типы) — registers.manage; записи, импорт, передача ИКТ — records.edit.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import type { FileStore } from '../../lib/file-store.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as groups from './groups.service.js';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });

const Node = z.object({
  id: z.string(),
  groupId: z.string(),
  systemType: z.object({ id: z.string(), label: z.string(), archived: z.boolean() }).nullable(),
  label: z.string(),
  legacy: z.boolean(),
});
export const VulnGroup = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['service', 'department', 'temporary']),
  kindLabel: z.string(),
  system: z.boolean(),
  version: z.number().int(),
  nodes: z.array(Node),
});

const view = requirePerm('ib.work');
const structure = requirePerm('registers.manage');

export const vulnSectionRoutes: FastifyPluginAsyncZod<{ db: Db; store: FileStore }> = async (app, { db }) => {
  app.get('/vulns/groups', {
    preHandler: view,
    schema: { tags: ['vulns'], summary: 'Группы и узлы раздела «Уязвимости»: обычные по названию, «Без группы» — последней', response: { 200: z.object({ items: z.array(VulnGroup) }), ...errors } },
  }, async () => ({ items: await groups.listGroups(db) }));

  app.post('/vulns/groups', {
    preHandler: structure,
    schema: {
      tags: ['vulns'], summary: 'Создать группу: название (уникально без регистра), вид, хотя бы один тип систем',
      body: z.object({ name: z.string().max(400), kind: z.enum(groups.GROUP_KINDS), systemTypeIds: z.array(z.string().uuid()).min(1).max(50) }),
      response: { 201: VulnGroup, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await groups.createGroup(db, actorOf(request), request.body)));

  app.patch('/vulns/groups/:id', {
    preHandler: structure,
    schema: {
      tags: ['vulns'], summary: 'Переименовать группу (уникальность без регистра, журнал). «Без группы» не переименовывается',
      params: IdParams, body: z.object({ name: z.string().max(400), version: z.number().int() }), response: { 200: VulnGroup, ...errors },
    },
  }, async (request) => groups.renameGroup(db, actorOf(request), request.params.id, request.body));

  app.post('/vulns/groups/:id/nodes', {
    preHandler: structure,
    schema: {
      tags: ['vulns'], summary: '«Добавить тип»: новые узлы группы',
      params: IdParams, body: z.object({ systemTypeIds: z.array(z.string().uuid()).min(1).max(50) }), response: { 200: VulnGroup, ...errors },
    },
  }, async (request) => groups.addNodes(db, actorOf(request), request.params.id, request.body.systemTypeIds));
};
