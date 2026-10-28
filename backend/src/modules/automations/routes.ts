import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { PageQuery } from '../../lib/pagination.js';
import { forbidden } from '../../lib/errors.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { EVENT_TYPES, type Action, type Condition } from './conditions.js';
import * as svc from './service.js';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
/** Задачи правила при его архиве или удалении (релиз 1.1.0): по умолчанию — оставить. */
const TasksChoice = z.object({
  action: z.enum(['keep', 'archive', 'delete']),
  onlyUntouched: z.boolean().optional(),
  expected: z.object({ total: z.number().int(), affected: z.number().int() }).optional(),
});
const TaskBulkPreview = z.object({
  total: z.number().int(), affected: z.number().int(), alreadyInState: z.number().int(), untouched: z.number().int(),
  byStatus: z.array(z.object({ statusId: z.string(), label: z.string(), count: z.number().int() })),
});
const TaskBulkResult = z.object({ archived: z.number().int(), deleted: z.number().int(), skipped: z.number().int() });
const Run = z.object({
  id: z.string(), registerId: z.string().nullable(), trigger: z.enum(svc.RUN_TRIGGERS), actor: z.string().nullable(),
  startedAt: z.string(), finishedAt: z.string().nullable(), rules: z.number().int(), checked: z.number().int(),
  eventsCreated: z.number().int(), tasksCreated: z.number().int(), tasksCommented: z.number().int(), error: z.string().nullable(),
});
/** Удалить задачи правила — только с правом «Задачи: удаление» (кроме права маршрута registers.manage). */
const assertTasksDelete = (request: { user?: { permissions: ReadonlySet<string> } | null }, choice?: z.infer<typeof TasksChoice>) => {
  if (choice?.action === 'delete' && !request.user?.permissions.has('tasks.delete')) throw forbidden();
};

const ConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('before'), fieldId: z.string().uuid(), days: z.number().int().min(0).max(365), skipYearEnd: z.boolean().optional() }),
  /** Ежегодно ДД.ММ — сводная задача по реестру (этап 8б). */
  z.object({ kind: z.literal('yearly'), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31), statusOptionIds: z.array(z.string().uuid()).max(50).optional() }),
  /** Канал открыт без действующего основания (поле link_basis). */
  z.object({ kind: z.literal('basis_missing'), fieldId: z.string().uuid() }),
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
  /** Метка — по id значения справочника «Получатели уведомлений» (название, если прислано, не используется). */
  z.object({ kind: z.literal('label'), itemId: z.string().uuid() }),
  z.object({ kind: z.literal('user'), userId: z.string().uuid(), name: z.string().optional() }),
]);
/** «Установить значение» (этап 8б): поле-список получает значение, если сейчас у него одно из fromOptionIds. */
const SetOptionSchema = z.object({
  eventType: z.literal('set_option'),
  fieldId: z.string().uuid(),
  optionId: z.string().uuid(),
  fromOptionIds: z.array(z.string().uuid()).min(1).max(50),
  recipients: z.array(z.never()).max(0),
});
const ActionSchema = z.union([
  z.object({
    eventType: z.enum(EVENT_TYPES),
    recipients: z.array(RecipientSchema).min(1).max(svc.MAX_RECIPIENTS),
    /** Свой заголовок задачи; {год} — следующий год. */
    title: z.string().trim().max(200).optional(),
  }),
  SetOptionSchema,
]);
const ActionOut = z.union([
  z.object({
    eventType: z.enum(EVENT_TYPES),
    recipients: z.array(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('field'), fieldId: z.string() }),
      /** missing — метки нет в справочнике: «получатель не найден», задачи по ней без ответственного. */
      z.object({ kind: z.literal('label'), itemId: z.string().nullable(), label: z.string(), missing: z.boolean() }),
      z.object({ kind: z.literal('user'), userId: z.string(), name: z.string().optional() }),
    ])),
    title: z.string().optional(),
  }),
  SetOptionSchema,
]);
const Rule = z.object({
  id: z.string(),
  registerId: z.string(),
  systemKey: z.string().nullable(),
  condition: ConditionSchema,
  action: ActionOut,
  recipientMissing: z.boolean(),
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
  z.object({ kind: z.literal('label'), label: z.string(), itemId: z.string().nullable().optional() }),
]);
const Event = z.object({
  id: z.string(),
  recordId: z.string(),
  recordNumber: z.number().int(),
  recordTitle: z.string(),
  automationId: z.string(),
  when: z.string(),
  then: z.string(),
  /** set_option — значение поставлено автоматически (этап 8б), задачи нет. */
  eventType: z.enum([...EVENT_TYPES, 'set_option']),
  recipients: z.array(EventRecipient),
  triggerKey: z.string(),
  fireAt: z.string(),
  status: z.enum(['new', 'processed']),
  processedAt: z.string().nullable(),
  processedBy: z.string().nullable(),
  tasks: z.array(z.object({ id: z.string(), number: z.number().int(), title: z.string(), action: z.enum(['created', 'commented']) })),
  createdAt: z.string(),
});

const view = requirePerm('ib.work');
const manage = requirePerm('registers.manage');

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

  app.post('/register-automations/:id/archive', {
    preHandler: manage,
    schema: {
      tags: ['automations'], summary: 'Правило в архив; его задачи — оставить, в архив или удалить', params: IdParams,
      body: Version.extend({ tasks: TasksChoice.optional() }), response: { 200: Rule.extend({ tasks: TaskBulkResult.nullable() }), ...errors },
    },
  }, async (request) => {
    assertTasksDelete(request, request.body.tasks);
    return asRule(await svc.setRuleArchived(db, actorOf(request), request.params.id, request.body.version, true, request.body.tasks)) as RuleOut & { tasks: null };
  });

  app.post('/register-automations/:id/restore', {
    preHandler: manage,
    schema: { tags: ['automations'], summary: 'Вернуть правило из архива', params: IdParams, body: Version, response: { 200: Rule, ...errors } },
  }, async (request) => asRule(await svc.setRuleArchived(db, actorOf(request), request.params.id, request.body.version, false)));

  app.post('/register-automations/:id/delete', {
    preHandler: manage,
    schema: {
      tags: ['automations'], summary: 'Удалить правило (мягко; события сохраняются); его задачи — оставить, в архив или удалить', params: IdParams,
      body: Version.extend({ tasks: TasksChoice.optional() }), response: { 200: z.object({ tasks: TaskBulkResult.nullable() }), ...errors },
    },
  }, async (request) => {
    assertTasksDelete(request, request.body.tasks);
    return { tasks: await svc.deleteRule(db, actorOf(request), request.params.id, request.body.version, request.body.tasks) };
  });

  app.post('/register-automations/:id/tasks/preview', {
    preHandler: manage,
    schema: {
      tags: ['automations'], summary: 'Задачи, созданные правилом: сколько, по статусам, нетронутые', params: IdParams,
      body: z.object({ action: z.enum(['archive', 'delete']), onlyUntouched: z.boolean().optional() }),
      response: { 200: TaskBulkPreview, ...errors },
    },
  }, async (request) => svc.ruleTasksPreview(db, request.params.id, request.body.action, !!request.body.onlyUntouched));

  app.get('/registers/:id/automation-runs', {
    preHandler: view,
    schema: {
      tags: ['automations'], summary: 'Журнал запусков автоматизаций реестра (и общих прогонов)', params: IdParams, querystring: PageQuery,
      response: { 200: z.object({ items: z.array(Run), nextCursor: z.string().nullable(), total: z.number().int() }), ...errors },
    },
  }, async (request) => svc.listRuns(db, request.params.id, request.query));

  app.post('/registers/:id/automation-runs/clear', {
    preHandler: manage,
    schema: {
      tags: ['automations'], summary: 'Очистить журнал запусков: старше N дней или весь (null)', params: IdParams,
      body: z.object({ olderThanDays: z.number().int().min(1).max(3650).nullable() }),
      response: { 200: z.object({ deleted: z.number().int() }), ...errors },
    },
  }, async (request) => svc.clearRuns(db, actorOf(request), request.params.id, request.body.olderThanDays));

  app.get('/registers/:id/unlinked-tasks', {
    preHandler: view,
    schema: {
      tags: ['automations'], summary: 'Задачи автоматизаций без привязки к правилу (правило — по событию)', params: IdParams,
      response: {
        200: z.object({
          total: z.number().int(),
          byRule: z.array(z.object({ automationId: z.string(), when: z.string(), then: z.string(), deleted: z.boolean(), count: z.number().int() })),
        }),
        ...errors,
      },
    },
  }, async (request) => svc.unlinkedTasksPreview(db, request.params.id));

  app.post('/registers/:id/unlinked-tasks/link', {
    preHandler: manage,
    schema: {
      tags: ['automations'], summary: 'Привязать задачи без привязки к правилам (после предпросмотра)', params: IdParams,
      body: z.object({ expected: z.object({ total: z.number().int() }) }),
      response: { 200: z.object({ linked: z.number().int() }), ...errors },
    },
  }, async (request) => svc.linkUnlinkedTasks(db, actorOf(request), request.params.id, request.body.expected));

  app.post('/registers/:id/automations/run', {
    preHandler: manage,
    schema: {
      tags: ['automations'], summary: 'Проверить правила реестра сейчас (без ожидания часового прогона)', params: IdParams,
      response: { 200: z.object({ ran: z.boolean(), today: z.string(), rules: z.number().int(), checked: z.number().int(), created: z.number().int(), tasksCreated: z.number().int(), tasksCommented: z.number().int() }), ...errors },
    },
  }, async (request) => svc.runAutomations(db, { registerId: request.params.id, trigger: 'manual', actorId: request.user?.id ?? null }));

  app.get('/registers/:id/automation-events', {
    preHandler: view,
    schema: {
      tags: ['automations'], summary: 'События автоматизаций реестра или записи', params: IdParams,
      querystring: PageQuery.extend({ status: z.enum(['new', 'processed']).optional(), recordId: z.string().uuid().optional() }),
      response: { 200: z.object({ items: z.array(Event), nextCursor: z.string().nullable(), total: z.number().int() }), ...errors },
    },
  }, async (request) => svc.listEvents(db, request.params.id, request.query));

};
