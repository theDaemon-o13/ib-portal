import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { describeRules } from '../automations/service.js';
import * as bulk from './bulk.js';
import type { TaskActor } from './flow.js';
import { PROCESS_ACTIONS, runAction, withActions } from './process.js';
import { exportTaskReport, REPORT_LIMIT, REPORT_PERIODS } from './report.js';
import { STATS_LIMIT, taskStats } from './stats.js';
import { replaceReviewer } from './reviewer.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
import * as svc from './service.js';

const tags = ['tasks'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

const Item = z.object({ id: z.string(), value: z.string(), color: z.string().nullable(), systemKey: z.string().nullable() });
const Person = z.object({ id: z.string(), fullName: z.string() });
const OriginLetter = z.object({ id: z.string(), number: z.number().int(), status: z.enum(['draft', 'review', 'approved', 'sent']), deleted: z.boolean() });
export const Task = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  description: z.string(),
  status: Item,
  priority: Item,
  category: Item,
  assignee: Person.nullable(),
  /** Общая задача (1.6.4): кто может взять её себе; пусто — любой сотрудник ИБ. */
  candidates: z.array(Person),
  /** Проверяющий (релиз 1.4.0, ADR-0028): у задачи «На проверке»; null — проверка по правилам до 1.4.0 или задача не на проверке. */
  reviewer: Person.nullable(),
  dueDate: z.string().nullable(),
  overdue: z.boolean(),
  urgent: z.boolean(),
  /**
   * Откуда задача: manual, mail, automation, document, evidence. Строка, а не перечисление: значение из более новой
   * версии портала отдаётся как есть, без 500 (1.9.0, «расширить → перенести → сузить»); интерфейс показывает «Другое».
   */
  source: z.string(),
  /** Задача модуля писем (1.9.0): расписание — правило, плановая дата, письмо и этапы; письмо — срочная рассылка или доработка. */
  origin: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('schedule'),
      rule: z.object({ id: z.string(), title: z.string() }),
      plannedDate: z.string(),
      letter: OriginLetter.nullable(),
      /** Этапы: черновик, согласование, отправка — выполнены по статусу письма; просрочен — невыполненный со сроком раньше сегодня. */
      stages: z.array(z.object({ key: z.enum(['draft', 'review', 'send']), due: z.string(), done: z.boolean(), overdue: z.boolean() })),
      /** Письмо отмечено отправленным — подсказка «Письмо отправлено — завершите задачу». */
      letterSent: z.boolean(),
    }),
    z.object({ kind: z.literal('letter'), reason: z.enum(['urgent', 'rework']), letter: OriginLetter, letterSent: z.boolean() }),
    /** Задача автоматизации контроля документа (1.11.0): документ, автоматизация, механизм контроля, номинальная дата запуска. */
    z.object({
      kind: z.literal('document_control'),
      document: z.object({ id: z.string(), number: z.number().int(), title: z.string() }),
      automation: z.object({ id: z.string(), title: z.string() }),
      control: z.object({ position: z.number().int(), requirement: z.string() }).nullable(),
      nominalDate: z.string(),
    }),
  ]).nullable(),
  record: z.object({ id: z.string(), registerId: z.string(), number: z.number().int() }).nullable(),
  automationId: z.string().nullable(),
  /** Метки получателей задачи автоматизации («Руководитель ДИКТ», «Владелец системы»…). */
  recipientLabel: z.string().nullable(),
  /** Задача по документу (этап 6): пересмотр (review) или доработка после возврата (returned). */
  document: z.object({ id: z.string(), number: z.number().int(), reason: z.enum(['review', 'returned', 'stage']) }).nullable(),
  /** Задача по доказательству (этап 7): отклонено или истекает срок действия. */
  evidence: z.object({ id: z.string(), number: z.number().int(), reason: z.enum(['rejected', 'expiring']) }).nullable(),
  completedAt: z.string().nullable(),
  /** Цепочка (1.7.0, ADR-0035): группировка по теме, на процесс не влияет. */
  chain: z.object({ id: z.string(), number: z.number().int(), title: z.string(), status: z.enum(['open', 'closed']) }).nullable(),
  createdBy: Person.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
  commentCount: z.number().int(),
  version: z.number().int(),
  /** Кнопки процесса, доступные текущему пользователю (ADR-0022, ADR-0028): take, start, submit, complete, accept, return. */
  actions: z.array(z.enum(PROCESS_ACTIONS)),
});
const TaskDetail = Task.extend({
  record: z.object({
    id: z.string(), registerId: z.string(), registerName: z.string(), number: z.number().int(), title: z.string(),
    /** 1.6.1: реестр или запись удалены — задача остаётся. */
    registerDeleted: z.boolean(), recordDeleted: z.boolean(),
  }).nullable(),
  /** Метки и их e-mail: если ответственного нет, сотрудник ИБ пишет им вручную (для справки: письма портал не отправляет). */
  recipients: z.array(z.object({ label: z.string(), emails: z.array(z.string()) })),
  mail: z.object({
    from: z.string(), subject: z.string(), sent: z.string(), body: z.string(),
    rule: z.object({ id: z.string(), label: z.string() }).nullable(), ruleHits: z.array(z.string()), dueReason: z.string(),
  }).nullable(),
});
const Comment = z.object({
  id: z.string(), body: z.string(), author: Person.nullable(), automatic: z.boolean(), createdAt: z.string(),
  /** Комментарий перехода между колонками (релиз 1.2.0): откуда, куда и проверяющий, зафиксированный переходом (1.4.0). */
  transition: z.object({ from: z.string().nullable(), to: z.string(), reviewer: z.string().nullable() }).nullable(),
});

const view = requirePerm('ib.work');

type TaskOut = z.infer<typeof Task>;
const asTask = (t: unknown) => t as TaskOut;
/** Пользователь с правами сессии: процесс задач проверяет их в сервисе (tasks.assign, tasks.status.override; tasks.review — задачи до 1.4.0). */
const taskActor = (request: Parameters<typeof actorOf>[0]): TaskActor => ({ ...actorOf(request), perms: request.user?.permissions ?? new Set<string>() });

export const taskRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/tasks', {
    preHandler: view,
    schema: {
      tags, summary: 'Задачи на доске или в архиве (archived=true), с фильтром по категории',
      querystring: z.object({
        archived: z.enum(['true', 'false']).optional(),
        categoryId: z.string().uuid().optional(),
        /** Создано правилом автоматизации (релиз 1.1.0). */
        automationId: z.string().uuid().optional(),
        overdue: z.enum(['true', 'false']).optional(),
        /** Только задачи цепочки (1.7.0). */
        chainId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(svc.BOARD_LIMIT).default(svc.BOARD_LIMIT),
        cursor: z.string().max(20).optional(),
      }),
      response: {
        200: z.object({
          items: z.array(Task), nextCursor: z.string().nullable(), total: z.number().int(),
          categories: z.array(z.object({ categoryId: z.string(), count: z.number().int() })), archivedTotal: z.number().int(),
          automations: z.array(z.object({ automationId: z.string(), label: z.string(), count: z.number().int() })),
        }),
        ...errors,
      },
    },
  }, async (request) => {
    const q = request.query;
    const page = await svc.listTasks(db, {
      archived: q.archived === 'true', categoryId: q.categoryId, automationId: q.automationId, overdue: q.overdue === 'true', chainId: q.chainId,
      limit: q.limit, cursor: q.cursor,
    });
    const names = await describeRules(db, page.automations.map((a) => a.automationId));
    const automations = page.automations.map((a) => ({ ...a, label: names.get(a.automationId) ?? 'Правило' })).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    return { ...page, items: (await withActions(db, taskActor(request), page.items)).map(asTask), automations };
  });

  app.get('/tasks/summary', {
    preHandler: view,
    schema: { tags, summary: 'Просроченные задачи: всего и мои (счётчик в меню)', response: { 200: z.object({ overdue: z.number().int(), overdueMine: z.number().int() }), ...errors } },
  }, async (request) => svc.taskSummary(db, actorOf(request).id));

  // Отчёт в Excel (релиз 1.2.0, ADR-0022) — по праву «Задачи: отчёт».
  app.get('/tasks/report', {
    preHandler: requirePerm('tasks.report'),
    schema: {
      tags, summary: `Отчёт по задачам в Excel (до ${REPORT_LIMIT} задач; больше — 409 «Сузьте период»)`,
      querystring: z.object({
        period: z.enum(REPORT_PERIODS).default('created'),
        from: IsoDate.optional(),
        to: IsoDate.optional(),
        assigneeId: z.string().uuid().optional(),
        creatorId: z.string().uuid().optional(),
        categoryId: z.string().uuid().optional(),
        statusId: z.string().uuid().optional(),
        overdue: z.enum(['true', 'false']).optional(),
        archived: z.enum(['true', 'false']).optional(),
      }),
    },
  }, async (request, reply) => {
    const q = request.query;
    const { fileName, buffer } = await exportTaskReport(db, actorOf(request), { ...q, overdue: q.overdue === 'true', archived: q.archived === 'true' });
    return reply
      .header('Content-Type', XLSX_TYPE)
      .header('Content-Disposition', `attachment; filename="tasks-report.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header('Cache-Control', 'no-store')
      .send(buffer);
  });

  // Отчёт по выполненным задачам (1.6.4) — по тому же праву «Задачи: отчёт».
  const Named = z.object({ id: z.string(), fullName: z.string() });
  app.get('/tasks/stats', {
    preHandler: requirePerm('tasks.report'),
    schema: {
      tags, summary: `Выполненные задачи за период: цифры, по неделям, сотрудникам и категориям, список (до ${STATS_LIMIT}; больше — 409)`,
      querystring: z.object({
        from: IsoDate, to: IsoDate,
        assigneeId: z.string().uuid().optional(),
        categoryId: z.string().uuid().optional(),
        late: z.enum(['true', 'false']).optional(),
        archived: z.enum(['true', 'false']).optional(),
      }).refine((q) => q.from <= q.to, { message: 'Начало периода позже конца', path: ['from'] }),
      response: {
        200: z.object({
          summary: z.object({ done: z.number().int(), onTime: z.number().int(), late: z.number().int(), avgLateDays: z.number().nullable(), avgLeadDays: z.number().nullable() }),
          weeks: z.array(z.object({ week: z.string(), onTime: z.number().int(), late: z.number().int() })),
          byAssignee: z.array(z.object({ id: z.string().nullable(), fullName: z.string(), done: z.number().int(), onTime: z.number().int(), late: z.number().int(), avgLeadDays: z.number().nullable() })),
          byCategory: z.array(z.object({ id: z.string(), value: z.string(), color: z.string().nullable(), done: z.number().int() })),
          items: z.array(z.object({
            id: z.string(), number: z.number().int(), title: z.string(),
            category: z.object({ id: z.string(), value: z.string(), color: z.string().nullable() }),
            assignee: Named.nullable(), createdAt: z.string(), startedAt: z.string().nullable(), completedAt: z.string(), dueDate: z.string().nullable(),
            lateDays: z.number().int().nullable(), leadDays: z.number().int(),
            closedBy: z.object({ how: z.enum(['accepted', 'self', 'system', 'override']), fullName: z.string().nullable() }),
          })),
        }),
        ...errors,
      },
    },
  }, async (request) => {
    const q = request.query;
    return taskStats(db, { from: q.from, to: q.to, assigneeId: q.assigneeId, categoryId: q.categoryId, late: q.late === 'true', archived: q.archived === 'true' });
  });

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
        /** Цепочка из подсказки (1.7.0): существующая (reopen — «Вернуть в работу и добавить») или новая с задачами без цепочки. */
        chain: z.union([
          z.object({ id: z.string().uuid(), reopen: z.boolean().optional() }),
          z.object({ newTitle: z.string().max(300).optional(), withTasks: z.array(z.object({ id: z.string().uuid(), version: z.number().int().positive() })).max(200).optional() }),
        ]).optional(),
      }),
      response: { 201: Task, ...errors },
    },
  }, async (request, reply) => {
    const actor = taskActor(request);
    const [t] = await withActions(db, actor, [await svc.createTask(db, actor, request.body)]);
    return reply.status(201).send(asTask(t));
  });

  app.get('/tasks/:id', {
    preHandler: view,
    schema: { tags, summary: 'Карточка задачи', params: IdParams, response: { 200: TaskDetail, ...errors } },
  }, async (request) => {
    const [t] = await withActions(db, taskActor(request), [await svc.getTask(db, request.params.id)]);
    return t as z.infer<typeof TaskDetail>;
  });

  app.patch('/tasks/:id', {
    preHandler: view,
    schema: {
      tags,
      summary: 'Изменить задачу. statusId (перетаскивание) — только с правом tasks.status.override, иначе 403; другого исполнителя — tasks.assign. Нужна version; 409 — задачу успели изменить',
      params: IdParams,
      body: Version.extend({
        title: z.string().max(svc.TITLE_MAX).optional(),
        description: z.string().max(svc.DESCRIPTION_MAX).optional(),
        statusId: z.string().uuid().optional(),
        priorityId: z.string().uuid().optional(),
        categoryId: z.string().uuid().optional(),
        assigneeId: z.string().uuid().nullable().optional(),
        dueDate: IsoDate.nullable().optional(),
        /** Комментарий к смене statusId: обязателен, если этого требует признак колонки. */
        comment: z.string().max(svc.COMMENT_MAX).optional(),
      }),
      response: { 200: Task, ...errors },
    },
  }, async (request) => {
    const actor = taskActor(request);
    const [t] = await withActions(db, actor, [await svc.updateTask(db, actor, request.params.id, request.body)]);
    return asTask(t);
  });

  // Кнопки процесса (релиз 1.2.0, ADR-0022): кто может — проверяет сервис по исполнителю, автору, иерархии и правам.
  app.post('/tasks/:id/actions/:action', {
    preHandler: view,
    schema: {
      tags,
      summary: 'Шаг процесса: take — взять себе, start — в работу, submit — на проверку (проверяющий фиксируется; нет руководителя — 409 NO_REVIEWER), complete — завершить без проверки (только исполнитель без руководителя), accept — принять, return — вернуть в работу (только проверяющий)',
      params: IdParams.extend({ action: z.enum(PROCESS_ACTIONS) }),
      body: Version.extend({ comment: z.string().max(svc.COMMENT_MAX).optional() }),
      response: { 200: Task, ...errors },
    },
  }, async (request) => {
    const actor = taskActor(request);
    const [t] = await withActions(db, actor, [await runAction(db, actor, request.params.id, request.params.action, request.body)]);
    return asTask(t);
  });

  // «Заменить проверяющего» (релиз 1.4.0, ADR-0028): задача «На проверке», новый — активный сотрудник ИБ, не исполнитель.
  app.post('/tasks/:id/reviewer', {
    preHandler: requirePerm('tasks.status.override'),
    schema: {
      tags,
      summary: 'Заменить проверяющего задачи «На проверке» (право tasks.status.override); запись в журнале, уведомление новому проверяющему',
      params: IdParams,
      body: Version.extend({ reviewerId: z.string().uuid(), comment: z.string().max(svc.COMMENT_MAX).optional() }),
      response: { 200: Task, ...errors },
    },
  }, async (request) => {
    const actor = taskActor(request);
    const [t] = await withActions(db, actor, [await replaceReviewer(db, actor, request.params.id, request.body)]);
    return asTask(t);
  });

  for (const [path, archived, summary] of [['archive', true, 'В архив'], ['restore', false, 'Вернуть на доску']] as const) {
    app.post(`/tasks/:id/${path}`, {
      preHandler: view,
      schema: { tags, summary, params: IdParams, body: Version, response: { 200: Task, ...errors } },
    }, async (request) => {
      const actor = taskActor(request);
      const [t] = await withActions(db, actor, [await svc.setTaskArchived(db, actor, request.params.id, request.body.version, archived)]);
      return asTask(t);
    });
  }

  app.post('/tasks/:id/delete', {
    preHandler: requirePerm('tasks.delete'),
    schema: { tags, summary: 'Удалить задачу (мягко, по праву «Задачи: удаление»)', params: IdParams, body: Version, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await svc.deleteTask(db, actorOf(request), request.params.id, request.body.version);
    return reply.status(204).send(null);
  });

  // Массовые действия на доске (релиз 1.1.0, ADR-0016): архив — ib.work, удаление — tasks.delete.
  const Ids = z.array(z.string().uuid()).min(1).max(bulk.TASK_BULK_MAX_IDS);
  const Expected = z.object({ total: z.number().int(), affected: z.number().int() });
  const BulkPreview = z.object({
    total: z.number().int(), affected: z.number().int(), alreadyInState: z.number().int(), untouched: z.number().int(),
    linkedToLetters: z.number().int(),
    byStatus: z.array(z.object({ statusId: z.string(), label: z.string(), count: z.number().int() })),
  });
  const BulkResult = z.object({ archived: z.number().int(), deleted: z.number().int(), skipped: z.number().int() });
  for (const [action, perm, what] of [['archive', view, 'В архив'], ['delete', requirePerm('tasks.delete'), 'Удалить (мягко)']] as const) {
    app.post(`/tasks/bulk-${action}/preview`, {
      preHandler: perm,
      schema: { tags, summary: `${what} выбранные задачи: предпросмотр`, body: z.object({ ids: Ids }), response: { 200: BulkPreview, ...errors } },
    }, async (request) => bulk.previewTaskBulk(db, action, { ids: request.body.ids }));
    app.post(`/tasks/bulk-${action}/apply`, {
      preHandler: perm,
      schema: { tags, summary: `${what} выбранные задачи: применить`, body: z.object({ ids: Ids, expected: Expected }), response: { 200: BulkResult, ...errors } },
    }, async (request) => bulk.applyTaskBulk(db, actorOf(request), action, { ids: request.body.ids }, request.body.expected,
      { label: action === 'archive' ? 'массовая отправка в архив на доске' : 'массовое удаление на доске', entity: 'task', entityId: 'board' }));
  }

  app.get('/tasks/:id/comments', {
    preHandler: view,
    schema: { tags, summary: 'Комментарии', params: IdParams, response: { 200: z.object({ items: z.array(Comment) }), ...errors } },
  }, async (request) => ({ items: await svc.listComments(db, request.params.id) }));

  app.post('/tasks/:id/comments', {
    preHandler: view,
    schema: { tags, summary: 'Добавить комментарий', params: IdParams, body: z.object({ body: z.string().max(svc.COMMENT_MAX) }), response: { 201: Comment, ...errors } },
  }, async (request, reply) => reply.status(201).send(await svc.addComment(db, actorOf(request), request.params.id, request.body.body)));

  // История — по праву «История в карточках» (релиз 1.2.0, ADR-0021); комментарии видят все, кто видит задачу.
  app.get('/tasks/:id/history', {
    preHandler: requirePerm('history.view'),
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
