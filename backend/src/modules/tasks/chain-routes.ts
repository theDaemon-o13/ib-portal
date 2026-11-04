// Маршруты цепочек задач (релиз 1.7.0, ADR-0035). Все — ib.work (раздел «Задачи»); кто правит цепочку, решает сервис:
// создатель, ответственный или tasks.assign. Видимость задач — visibleTasksWhere.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as chains from './chains.js';
import { suggestChains, SUGGEST_MAX } from './chain-suggest.js';
import { discoverApply, discoverPreview } from './chain-discover.js';
import type { TaskActor } from './flow.js';

const tags = ['task-chains'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');
const Person = z.object({ id: z.string(), fullName: z.string() });
const TaskRef = z.object({ id: z.string().uuid(), version: z.number().int().positive() });

export const Chain = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  status: z.enum(['open', 'closed']),
  owner: Person.nullable(),
  dueDate: z.string().nullable(),
  summary: z.string(),
  createdBy: Person,
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  version: z.number().int(),
  /** По видимым задачам: всего и выполнено, включая архивные. */
  counts: z.object({ total: z.number().int(), done: z.number().int() }),
  /** Все задачи выполнены — предложить «Закрыть цепочку» (портал сам не закрывает). */
  allDone: z.boolean(),
  /** Текущий пользователь может править, закрывать, открывать и удалять цепочку. */
  canManage: z.boolean(),
});
export const ChainDetail = Chain.extend({
  /** Хронология: видимые задачи по дате создания, включая выполненные и архивные. */
  tasks: z.array(z.object({
    id: z.string(), number: z.number().int(), title: z.string(),
    status: z.object({ id: z.string(), value: z.string(), systemKey: z.string().nullable(), color: z.string().nullable() }),
    assignee: Person.nullable(), dueDate: z.string().nullable(), createdAt: z.string(), completedAt: z.string().nullable(), archived: z.boolean(),
  })),
});

const Suggest = z.object({
  /** Ключ заголовка; null — после снятия «RE:», «FW:» ничего не осталось, подсказки нет. */
  key: z.string().nullable(),
  items: z.array(z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('chain'),
      group: z.enum(['open_exact', 'closed_unfinished', 'open_similar', 'closed_recent']),
      chain: z.object({
        id: z.string(), number: z.number().int(), title: z.string(), status: z.enum(['open', 'closed']), closedAt: z.string().nullable(), version: z.number().int(),
        counts: z.object({ total: z.number().int(), done: z.number().int() }), canManage: z.boolean(),
      }),
    }),
    z.object({
      kind: z.literal('tasks'),
      total: z.number().int(),
      tasks: z.array(z.object({
        id: z.string(), number: z.number().int(), title: z.string(), version: z.number().int(), status: z.string(),
        completed: z.boolean(), archived: z.boolean(), createdAt: z.string(),
      })),
    }),
  ])),
});

const taskActor = (request: Parameters<typeof actorOf>[0]): TaskActor => ({ ...actorOf(request), perms: request.user?.permissions ?? new Set<string>() });

export const chainRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const view = requirePerm('ib.work');

  app.get('/task-chains', {
    preHandler: view,
    schema: {
      tags, summary: 'Цепочки с видимыми задачами: фильтр по статусу и ответственному, поиск по названию или номеру',
      querystring: z.object({
        status: z.enum(['open', 'closed']).optional(),
        ownerId: z.string().uuid().optional(),
        q: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(chains.CHAIN_LIST_LIMIT).default(chains.CHAIN_LIST_LIMIT),
        cursor: z.string().max(20).optional(),
      }),
      response: { 200: z.object({ items: z.array(Chain), nextCursor: z.string().nullable(), total: z.number().int() }), ...errors },
    },
  }, async (request) => chains.listChains(db, taskActor(request), request.query));

  app.get('/task-chains/suggest', {
    preHandler: view,
    schema: {
      tags, summary: `Подсказка цепочки по заголовку задачи: до ${SUGGEST_MAX} вариантов (открытые с тем же ключом, закрытые с незавершёнными, `
        + 'похожие открытые, недавно закрытые, задачи без цепочки). taskId — задача, которую правят (не предлагать её саму и её цепочку)',
      querystring: z.object({ title: z.string().max(1000), taskId: z.string().uuid().optional() }),
      response: { 200: Suggest, ...errors },
    },
  }, async (request) => suggestChains(db, taskActor(request), request.query.title, { taskId: request.query.taskId }));

  const DiscoverTask = z.object({
    id: z.string(), number: z.number().int(), title: z.string(), version: z.number().int(), completed: z.boolean(), archived: z.boolean(), createdAt: z.string(),
  });
  app.post('/task-chains/discover/preview', {
    preHandler: view,
    schema: {
      tags, summary: 'Найти цепочки среди старых задач — предпросмотр («Задачи: постановка другим» или «Настройки»): группы задач без цепочки с одинаковым ключом, от двух задач',
      response: {
        200: z.object({
          groups: z.array(z.object({
            key: z.string(), title: z.string(), tasks: z.array(DiscoverTask),
            target: z.object({ id: z.string(), number: z.number().int(), title: z.string() }).nullable(),
          })),
          total: z.number().int(), tasks: z.number().int(),
        }),
        ...errors,
      },
    },
  }, async (request) => discoverPreview(db, taskActor(request)));

  app.post('/task-chains/discover/apply', {
    preHandler: view,
    schema: {
      tags, summary: 'Найти цепочки среди старых задач — применить выбранные группы одной транзакцией; изменилось после предпросмотра — 409 BULK_CHANGED',
      body: z.object({
        groups: z.array(z.object({
          key: z.string().max(1000), title: z.string().max(chains.CHAIN_TITLE_MAX).optional(),
          tasks: z.array(TaskRef).min(1).max(chains.CHAIN_ATTACH_MAX), chainId: z.string().uuid().nullable(),
        })).min(1).max(500),
      }),
      response: { 200: z.object({ created: z.number().int(), attached: z.number().int(), tasks: z.number().int() }), ...errors },
    },
  }, async (request) => discoverApply(db, taskActor(request), request.body));

  app.post('/task-chains', {
    preHandler: view,
    schema: {
      tags, summary: 'Создать цепочку из задач (хотя бы одной). Задачи в другой цепочке — 409 TASK_IN_OTHER_CHAIN',
      body: z.object({
        title: z.string().max(chains.CHAIN_TITLE_MAX),
        ownerId: z.string().uuid().nullable().optional(),
        dueDate: IsoDate.nullable().optional(),
        summary: z.string().max(chains.CHAIN_SUMMARY_MAX).optional(),
        tasks: z.array(TaskRef).min(1).max(chains.CHAIN_ATTACH_MAX),
      }),
      response: { 201: ChainDetail, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await chains.createChain(db, taskActor(request), request.body)));

  app.get('/task-chains/:id', {
    preHandler: view,
    schema: { tags, summary: 'Цепочка и хронология её видимых задач', params: IdParams, response: { 200: ChainDetail, ...errors } },
  }, async (request) => chains.getChain(db, taskActor(request), request.params.id));

  app.patch('/task-chains/:id', {
    preHandler: view,
    schema: {
      tags, summary: 'Изменить название, ответственного, срок, сводку (создатель, ответственный или «Задачи: постановка другим»)',
      params: IdParams,
      body: Version.extend({
        title: z.string().max(chains.CHAIN_TITLE_MAX).optional(),
        ownerId: z.string().uuid().nullable().optional(),
        dueDate: IsoDate.nullable().optional(),
        summary: z.string().max(chains.CHAIN_SUMMARY_MAX).optional(),
      }),
      response: { 200: ChainDetail, ...errors },
    },
  }, async (request) => chains.updateChain(db, taskActor(request), request.params.id, request.body));

  app.post('/task-chains/:id/close', {
    preHandler: view,
    schema: { tags, summary: 'Закрыть. Незавершённые задачи не мешают — их число в журнале', params: IdParams, body: Version, response: { 200: ChainDetail, ...errors } },
  }, async (request) => chains.closeChain(db, taskActor(request), request.params.id, request.body.version));

  app.post('/task-chains/:id/reopen', {
    preHandler: view,
    schema: { tags, summary: 'Открыть заново', params: IdParams, body: Version, response: { 200: ChainDetail, ...errors } },
  }, async (request) => chains.reopenChain(db, taskActor(request), request.params.id, request.body.version));

  app.post('/task-chains/:id/delete', {
    preHandler: view,
    schema: {
      tags, summary: 'Удалить мягко: задачи отвязываются и остаются. Восстановления нет',
      params: IdParams, body: Version, response: { 204: z.null(), ...errors },
    },
  }, async (request, reply) => {
    await chains.deleteChain(db, taskActor(request), request.params.id, request.body.version);
    return reply.status(204).send(null);
  });

  app.post('/task-chains/:id/tasks', {
    preHandler: view,
    schema: {
      tags, summary: 'Привязать задачи (в том числе выполненные и архивные). Закрытая цепочка — 409 CHAIN_CLOSED, reopen — «Вернуть в работу и добавить»',
      params: IdParams,
      body: z.object({ tasks: z.array(TaskRef).min(1).max(chains.CHAIN_ATTACH_MAX), reopen: z.boolean().optional() }),
      response: { 200: ChainDetail, ...errors },
    },
  }, async (request) => chains.attachTasks(db, taskActor(request), request.params.id, request.body));

  app.post('/task-chains/:id/tasks/:taskId/detach', {
    preHandler: view,
    schema: {
      tags, summary: 'Отвязать задачу', params: z.object({ id: z.string().uuid(), taskId: z.string().uuid() }), body: Version,
      response: { 200: z.object({ taskId: z.string(), chainId: z.string() }), ...errors },
    },
  }, async (request) => chains.detachTask(db, taskActor(request), request.params.id, request.params.taskId, request.body.version));

  app.post('/tasks/:id/move-chain', {
    preHandler: view,
    schema: {
      tags, summary: 'Перенести задачу в другую (открытую) цепочку',
      params: IdParams, body: Version.extend({ toChainId: z.string().uuid() }), response: { 200: ChainDetail, ...errors },
    },
  }, async (request) => chains.moveTask(db, taskActor(request), request.params.id, request.body));
};
