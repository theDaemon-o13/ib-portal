import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { PageQuery } from '../../lib/pagination.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { EVENT_TYPES, type Action, type Condition } from './conditions.js';
import * as svc from './service.js';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });

const ConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('before'), fieldId: z.string().uuid(), days: z.number().int().min(0).max(365) }),
  z.object({
    kind: z.literal('overdue'),
    fieldId: z.string().uuid(),
    workdays: z.number().int().min(1).max(365).nullable().optional(),
    unlessFilledFieldId: z.string().uuid().nullable().optional(),
  }),
  z.object({ kind: z.literal('equals'), fieldId: z.string().uuid(), optionId: z.string().uuid() }),
]);
const RecipientSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), fieldId: z.string().uuid() }),
  z.object({ kind: z.literal('label'), label: z.string().trim().min(1).max(100) }),
]);
const ActionSchema = z.object({
  eventType: z.enum(EVENT_TYPES),
  recipients: z.array(RecipientSchema).min(1).max(svc.MAX_RECIPIENTS),
});
const Rule = z.object({
  id: z.string(),
  registerId: z.string(),
  systemKey: z.string().nullable(),
  condition: ConditionSchema,
  action: ActionSchema,
  enabled: z.boolean(),
  archived: z.boolean(),
  version: z.number().int(),
  /** Готовые фразы для списка: «За 3 дн. до «Срок устранения»», «Напомнить: Ответственный». */
  when: z.string(),
  then: z.string(),
  createdAt: z.string(),
});
const EventRecipient = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string(), name: z.string() }),
  z.object({ kind: z.literal('label'), label: z.string() }),
]);
const Event = z.object({
  id: z.string(),
  recordId: z.string(),
  recordNumber: z.number().int(),
  recordTitle: z.string(),
  automationId: z.string(),
  when: z.string(),
  then: z.string(),
  eventType: z.enum(EVENT_TYPES),
  recipients: z.array(EventRecipient),
  triggerKey: z.string(),
  fireAt: z.string(),
  status: z.enum(['new', 'processed']),
  processedAt: z.string().nullable(),
  processedBy: z.string().nullable(),
  createdAt: z.string(),
});

const view = requirePerm('ib.work');
const manage = requirePerm('registers.manage');
const edit = requirePerm('records.edit');

type RuleOut = z.infer<typeof Rule>;
const asRule = (r: unknown) => r as RuleOut;

export const automationRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/registers/:id/automations', {
    preHandler: view,
    schema: {
      tags: ['automations'], summary: 'Правила «условие → действие» реестра', params: IdParams,
      querystring: z.object({ includeArchived: z.enum(['true', 'false']).optional() }),
      response: { 200: z.object({ items: z.array(Rule) }), ...errors },
    },
  }, async (request) => ({
    items: (await svc.listRules(db, request.params.id, { includeArchived: request.query.includeArchived === 'true' })).map(asRule),
  }));

  app.post('/registers/:id/automations', {
    preHandler: manage,
    schema: {
      tags: ['automations'], summary: 'Добавить правило', params: IdParams,
      body: z.object({ condition: ConditionSchema, action: ActionSchema }), response: { 201: Rule, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(asRule(await svc.createRule(db, actorOf(request), request.params.id, {
    condition: request.body.condition as Condition, action: request.body.action as Action,
  }))));

  app.patch('/register-automations/:id', {
    preHandler: manage,
    schema: {
      tags: ['automations'], summary: 'Изменить правило или включить/выключить (системное — только включить/выключить)', params: IdParams,
      body: Version.extend({ condition: ConditionSchema.optional(), action: ActionSchema.optional(), enabled: z.boolean().optional() }),
      response: { 200: Rule, ...errors },
    },
  }, async (request) => asRule(await svc.updateRule(db, actorOf(request), request.params.id, {
    version: request.body.version,
    condition: request.body.condition as Condition | undefined,
    action: request.body.action as Action | undefined,
    enabled: request.body.enabled,
  })));

  for (const [path, archived, summary] of [['archive', true, 'Правило в архив'], ['restore', false, 'Вернуть правило из архива']] as const) {
    app.post(`/register-automations/:id/${path}`, {
      preHandler: manage,
      schema: { tags: ['automations'], summary, params: IdParams, body: Version, response: { 200: Rule, ...errors } },
    }, async (request) => asRule(await svc.setRuleArchived(db, actorOf(request), request.params.id, request.body.version, archived)));
  }

  app.post('/register-automations/:id/delete', {
    preHandler: manage,
    schema: { tags: ['automations'], summary: 'Удалить правило без событий', params: IdParams, body: Version, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await svc.deleteRule(db, actorOf(request), request.params.id, request.body.version);
    return reply.status(204).send(null);
  });

  app.post('/registers/:id/automations/run', {
    preHandler: manage,
    schema: {
      tags: ['automations'], summary: 'Проверить правила реестра сейчас (без ожидания часового прогона)', params: IdParams,
      response: { 200: z.object({ ran: z.boolean(), today: z.string(), rules: z.number().int(), checked: z.number().int(), created: z.number().int() }), ...errors },
    },
  }, async (request) => svc.runAutomations(db, { registerId: request.params.id }));

  app.get('/registers/:id/automation-events', {
    preHandler: view,
    schema: {
      tags: ['automations'], summary: 'События автоматизаций реестра или записи', params: IdParams,
      querystring: PageQuery.extend({ status: z.enum(['new', 'processed']).optional(), recordId: z.string().uuid().optional() }),
      response: { 200: z.object({ items: z.array(Event), nextCursor: z.string().nullable(), total: z.number().int() }), ...errors },
    },
  }, async (request) => svc.listEvents(db, request.params.id, request.query));

  app.post('/automation-events/:id/process', {
    preHandler: edit,
    schema: { tags: ['automations'], summary: 'Отметить событие обработанным', params: IdParams, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await svc.processEvent(db, actorOf(request), request.params.id);
    return reply.status(204).send(null);
  });
};
