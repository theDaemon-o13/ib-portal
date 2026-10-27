import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['tasks'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

const Item = z.object({ id: z.string(), value: z.string(), color: z.string().nullable(), systemKey: z.string().nullable() });
const Person = z.object({ id: z.string(), fullName: z.string() });
export const Task = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  description: z.string(),
  status: Item,
  priority: Item,
  category: Item,
  assignee: Person.nullable(),
  dueDate: z.string().nullable(),
  overdue: z.boolean(),
  urgent: z.boolean(),
  source: z.enum(['manual', 'mail', 'automation']),
  record: z.object({ id: z.string(), registerId: z.string(), number: z.number().int() }).nullable(),
  automationId: z.string().nullable(),
  /** Метки получателей задачи автоматизации («Руководитель ДИКТ», «Владелец системы»…). */
  recipientLabel: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdBy: Person.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
  commentCount: z.number().int(),
  version: z.number().int(),
});
const TaskDetail = Task.extend({
  record: z.object({ id: z.string(), registerId: z.string(), registerName: z.string(), number: z.number().int(), title: z.string() }).nullable(),
  /** Метки и их e-mail: если ответственного нет, сотрудник ИБ пишет им вручную (письма — этап 9). */
  recipients: z.array(z.object({ label: z.string(), emails: z.array(z.string()) })),
  mail: z.object({
    from: z.string(), subject: z.string(), sent: z.string(), body: z.string(),
    rule: z.object({ id: z.string(), label: z.string() }).nullable(), ruleHits: z.array(z.string()), dueReason: z.string(),
  }).nullable(),
});
const Comment = z.object({ id: z.string(), body: z.string(), author: Person.nullable(), automatic: z.boolean(), createdAt: z.string() });

const view = requirePerm('ib.work');

type TaskOut = z.infer<typeof Task>;
const asTask = (t: unknown) => t as TaskOut;

export const taskRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/tasks', {
    preHandler: view,
    schema: {
      tags, summary: 'Задачи на доске или в архиве (archived=true), с фильтром по категории',
      querystring: z.object({
        archived: z.enum(['true', 'false']).optional(),
        categoryId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(svc.BOARD_LIMIT).default(svc.BOARD_LIMIT),
        cursor: z.string().max(20).optional(),
      }),
      response: {
        200: z.object({
          items: z.array(Task), nextCursor: z.string().nullable(), total: z.number().int(),
          categories: z.array(z.object({ categoryId: z.string(), count: z.number().int() })), archivedTotal: z.number().int(),
        }),
        ...errors,
      },
    },
  }, async (request) => {
    const q = request.query;
    const page = await svc.listTasks(db, { archived: q.archived === 'true', categoryId: q.categoryId, limit: q.limit, cursor: q.cursor });
    return { ...page, items: page.items.map(asTask) };
  });

  app.get('/tasks/summary', {
    preHandler: view,
    schema: { tags, summary: 'Просроченные задачи: всего и мои (счётчик в меню)', response: { 200: z.object({ overdue: z.number().int(), overdueMine: z.number().int() }), ...errors } },
  }, async (request) => svc.taskSummary(db, actorOf(request).id));

  app.post('/tasks/mail-draft', {
    preHandler: view,
    schema: {
      tags, summary: '«Почта → задача»: разобрать текст письма в черновик. Ничего не сохраняет',
      body: z.object({ raw: z.string().max(svc.RAW_MAX) }),
      response: {
        200: z.object({
          from: z.string(), subject: z.string(), sent: z.string(), body: z.string(), title: z.string(),
          dueDate: z.string(), dueReason: z.string(), urgent: z.boolean(), priorityId: z.string(), categoryId: z.string(),
          rule: z.object({ id: z.string(), label: z.string(), hits: z.array(z.string()) }).nullable(),
          assignee: Person.nullable(), assigneeReason: z.string(),
        }),
        ...errors,
      },
    },
  }, async (request) => svc.mailDraft(db, request.body.raw));

  app.post('/tasks', {
    preHandler: view,
    schema: {
      tags, summary: 'Поставить задачу. С mail.raw — задача из письма (категория «Почта», письмо сохраняется)',
      body: z.object({
        title: z.string().max(svc.TITLE_MAX),
        description: z.string().max(svc.DESCRIPTION_MAX).optional(),
        categoryId: z.string().uuid().optional(),
        priorityId: z.string().uuid().optional(),
        assigneeId: z.string().uuid().nullable().optional(),
        dueDate: IsoDate.nullable().optional(),
        mail: z.object({ raw: z.string().max(svc.RAW_MAX) }).optional(),
      }),
      response: { 201: Task, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(asTask(await svc.createTask(db, actorOf(request), request.body))));

  app.get('/tasks/:id', {
    preHandler: view,
    schema: { tags, summary: 'Карточка задачи', params: IdParams, response: { 200: TaskDetail, ...errors } },
  }, async (request) => (await svc.getTask(db, request.params.id)) as z.infer<typeof TaskDetail>);

  app.patch('/tasks/:id', {
    preHandler: view,
    schema: {
      tags, summary: 'Изменить задачу (и перетаскивание: statusId). Нужна version; 409 — задачу успели изменить',
      params: IdParams,
      body: Version.extend({
        title: z.string().max(svc.TITLE_MAX).optional(),
        description: z.string().max(svc.DESCRIPTION_MAX).optional(),
        statusId: z.string().uuid().optional(),
        priorityId: z.string().uuid().optional(),
        categoryId: z.string().uuid().optional(),
        assigneeId: z.string().uuid().nullable().optional(),
        dueDate: IsoDate.nullable().optional(),
      }),
      response: { 200: Task, ...errors },
    },
  }, async (request) => asTask(await svc.updateTask(db, actorOf(request), request.params.id, request.body)));

  for (const [path, archived, summary] of [['archive', true, 'В архив'], ['restore', false, 'Вернуть на доску']] as const) {
    app.post(`/tasks/:id/${path}`, {
      preHandler: view,
      schema: { tags, summary, params: IdParams, body: Version, response: { 200: Task, ...errors } },
    }, async (request) => asTask(await svc.setTaskArchived(db, actorOf(request), request.params.id, request.body.version, archived)));
  }

  app.post('/tasks/:id/delete', {
    preHandler: requirePerm('tasks.delete'),
    schema: { tags, summary: 'Удалить задачу (мягко, по праву «Задачи: удаление»)', params: IdParams, body: Version, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await svc.deleteTask(db, actorOf(request), request.params.id, request.body.version);
    return reply.status(204).send(null);
  });

  app.get('/tasks/:id/comments', {
    preHandler: view,
    schema: { tags, summary: 'Комментарии', params: IdParams, response: { 200: z.object({ items: z.array(Comment) }), ...errors } },
  }, async (request) => ({ items: await svc.listComments(db, request.params.id) }));

  app.post('/tasks/:id/comments', {
    preHandler: view,
    schema: { tags, summary: 'Добавить комментарий', params: IdParams, body: z.object({ body: z.string().max(svc.COMMENT_MAX) }), response: { 201: Comment, ...errors } },
  }, async (request, reply) => reply.status(201).send(await svc.addComment(db, actorOf(request), request.params.id, request.body.body)));

  app.get('/tasks/:id/history', {
    preHandler: view,
    schema: {
      tags, summary: 'История изменений из журнала аудита', params: IdParams,
      response: {
        200: z.object({
          items: z.array(z.object({
            id: z.string(), at: z.string(), actor: z.object({ fullName: z.string(), login: z.string() }).nullable(), action: z.string(), summary: z.string(),
            changes: z.array(z.object({ label: z.string(), from: z.string(), to: z.string() })),
          })),
        }),
        ...errors,
      },
    },
  }, async (request) => ({ items: await svc.taskHistory(db, request.params.id) }));
};
