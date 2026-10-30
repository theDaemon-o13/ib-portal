import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ASSESSMENT_PERMISSION } from '../../lib/permissions.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['assessments'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Level = z.number().int().min(1).max(4);

// Личный раздел (ADR-0026): каждый маршрут — только по праву «Самооценка», ib.work не нужен.
const owner = requirePerm(ASSESSMENT_PERMISSION);

const Methodology = z.object({
  code: z.string(), name: z.string(), version: z.number().int(),
  scale: z.array(z.object({ level: z.number().int(), name: z.string() })),
  maturity: z.array(z.object({ code: z.string(), name: z.string(), min: z.number(), max: z.number(), description: z.string() })),
  rules: z.object({ effectiveRequiresMaxIn: z.array(z.string()), fallbackLevel: z.string(), criterionThresholdPct: z.number() }),
  domains: z.array(z.object({
    no: z.number().int(), name: z.string(),
    sections: z.array(z.object({ code: z.string(), name: z.string(), target: z.string(), criteria: z.record(z.string(), z.string()), key: z.boolean().optional() })),
  })),
});
const LevelRef = z.object({ code: z.string(), name: z.string() });
const Score = z.object({
  total: z.number().int(), max: z.number().int(), answered: z.number().int(), sections: z.number().int(), preliminary: z.boolean(),
  level: LevelRef,
  keySections: z.array(z.object({ code: z.string(), name: z.string(), level: z.number().int().nullable() })),
  domains: z.array(z.object({
    no: z.number().int(), name: z.string(), sections: z.number().int(), answered: z.number().int(), sum: z.number().int(), max: z.number().int(),
    avg: z.number().nullable(), targetAvg: z.number().nullable(),
  })),
  distribution: z.object({ 1: z.number().int(), 2: z.number().int(), 3: z.number().int(), 4: z.number().int() }),
  gaps: z.array(z.object({ code: z.string(), name: z.string(), domainNo: z.number().int(), level: z.number().int(), target: z.number().int(), gap: z.number().int(), key: z.boolean() })),
  gapPoints: z.number().int(),
});
const Summary = z.object({
  id: z.string(), title: z.string(), assessedOn: z.string(), status: z.enum(svc.STATUSES), statusName: z.string(),
  total: z.number().int(), max: z.number().int(), answered: z.number().int(), sections: z.number().int(), preliminary: z.boolean(),
  level: LevelRef, finalizedAt: z.string().nullable(), version: z.number().int(),
});
const Profile = z.object({
  organization: z.string().max(300).optional(), respondent: z.string().max(300).optional(), position: z.string().max(300).optional(),
  industries: z.array(z.string().max(300)).max(20).optional(), employees: z.number().int().nullable().optional(),
  kbExperience: z.string().max(300).optional(), kbStaff: z.string().max(300).optional(),
});
const Answer = z.object({
  code: z.string(), level: z.number().int().nullable(), targetLevel: z.number().int().nullable(), comment: z.string(), version: z.number().int(),
  updatedAt: z.string(), updatedBy: z.string().nullable(),
});
const Delta = z.object({
  total: z.number().int(),
  domains: z.array(z.object({ no: z.number().int(), sum: z.number().int().nullable(), avg: z.number().nullable() })),
  sections: z.array(z.object({ code: z.string(), from: z.number().int().nullable(), to: z.number().int().nullable(), delta: z.number().int().nullable() })),
});
const LinkedTask = z.object({
  code: z.string(), id: z.string(), number: z.number().int(), title: z.string(), assignee: z.string().nullable(), dueDate: z.string().nullable(),
  status: z.string(), done: z.boolean(), archived: z.boolean(), deleted: z.boolean(),
});
const Detail = Summary.extend({
  profile: Profile, reopenComment: z.string(), methodology: Methodology, answers: z.array(Answer), score: Score,
  /** Задачи по разделам (связи раздела); в самой задаче следа самооценки нет. */
  tasks: z.array(LinkedTask),
  previous: z.object({
    id: z.string(), title: z.string(), assessedOn: z.string(), total: z.number().int(), level: LevelRef,
    domains: z.array(z.object({ no: z.number().int(), sum: z.number().int(), avg: z.number().nullable() })),
    answers: z.array(z.object({ code: z.string(), level: z.number().int().nullable() })),
    delta: Delta,
  }).nullable(),
});
const Log = z.object({ items: z.array(z.object({ id: z.string(), at: z.string(), actor: z.string(), action: z.string(), summary: z.string() })) });

export const assessmentRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  type Out = z.infer<typeof Detail>;
  const detail = async (id: string) => (await svc.getAssessment(db, id)) as Out;

  app.get('/assessments', {
    preHandler: owner,
    schema: { tags, summary: 'Оценки: название, дата, статус, итог, уровень', response: { 200: z.object({ items: z.array(Summary) }), ...errors } },
  }, async () => svc.listAssessments(db));

  app.get('/assessments/methodology', {
    preHandler: owner,
    schema: { tags, summary: 'Активная методика', response: { 200: Methodology, ...errors } },
  }, async () => (await svc.activeMethodology(db)).content as z.infer<typeof Methodology>);

  app.get('/assessments/assignees', {
    preHandler: owner,
    schema: {
      tags, summary: 'Исполнители для задачи по разрыву: активные сотрудники с ib.work, только id и имя',
      response: { 200: z.object({ items: z.array(z.object({ id: z.string(), fullName: z.string() })) }), ...errors },
    },
  }, async () => svc.taskAssignees(db));

  app.get('/assessments/compare', {
    preHandler: owner,
    schema: {
      tags, summary: 'Сравнение двух оценок по разделам и доменам', querystring: z.object({ a: z.string().uuid(), b: z.string().uuid() }),
      response: {
        200: z.object({
          a: Summary, b: Summary,
          domains: z.array(z.object({ no: z.number().int(), name: z.string(), a: z.number().int().nullable(), b: z.number().int(), aAvg: z.number().nullable(), bAvg: z.number().nullable() })),
          sections: z.array(z.object({ code: z.string(), name: z.string(), a: z.number().int().nullable(), b: z.number().int().nullable() })),
          delta: Delta,
        }),
        ...errors,
      },
    },
  }, async (request) => svc.compareAssessments(db, request.query.a, request.query.b));

  app.post('/assessments', {
    preHandler: owner,
    schema: {
      tags, summary: 'Новая оценка: пустая или копия зафиксированной (баллы и цели без комментариев). Черновик один — иначе 409',
      body: z.object({ title: z.string().max(svc.TITLE_MAX), assessedOn: Day, copyFromId: z.string().uuid().optional() }),
      response: { 201: Detail, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await detail(await svc.createAssessment(db, actorOf(request), request.body))));

  app.get('/assessments/:id', {
    preHandler: owner,
    schema: { tags, summary: 'Оценка: снимок методики, профиль, ответы, итог, сравнение с предыдущей', params: IdParams, response: { 200: Detail, ...errors } },
  }, async (request) => detail(request.params.id));

  app.patch('/assessments/:id', {
    preHandler: owner,
    schema: {
      tags, summary: 'Шапка и профиль (только черновик)', params: IdParams,
      body: Version.extend({ title: z.string().max(svc.TITLE_MAX).optional(), assessedOn: Day.optional(), profile: Profile.optional() }),
      response: { 200: Detail, ...errors },
    },
  }, async (request) => {
    await svc.updateAssessment(db, actorOf(request), request.params.id, request.body);
    return detail(request.params.id);
  });

  app.put('/assessments/:id/answers/:code', {
    preHandler: owner,
    schema: {
      tags, summary: 'Ответ раздела (только черновик); в ответе — пересчитанный итог',
      params: IdParams.extend({ code: z.string().regex(/^\d{1,2}\.\d{1,2}$/) }),
      body: Version.extend({ level: Level.nullable().optional(), targetLevel: Level.nullable().optional(), comment: z.string().max(svc.COMMENT_MAX).optional() }),
      response: { 200: z.object({ answer: Answer.nullable(), score: Score, version: z.number().int() }), ...errors },
    },
  }, async (request) => svc.saveAnswer(db, actorOf(request), request.params.id, request.params.code, request.body));

  app.post('/assessments/:id/answers/:code/tasks', {
    preHandler: owner,
    schema: {
      tags,
      summary: 'Задача по разрыву на общей доске (без «Задачи: постановка другим»); в задаче следа самооценки нет',
      params: IdParams.extend({ code: z.string().regex(/^\d{1,2}\.\d{1,2}$/) }),
      body: z.object({
        title: z.string().max(svc.TASK_TITLE_MAX), categoryId: z.string().uuid(), assigneeId: z.string().uuid(), dueDate: Day.nullable().optional(),
      }),
      response: { 201: LinkedTask, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await svc.createGapTask(db, actorOf(request), request.params.id, request.params.code, request.body)));

  app.get('/assessments/:id/answers/:code/history', {
    preHandler: owner,
    schema: { tags, summary: 'История раздела из журнала (без права «История в карточках»)', params: IdParams.extend({ code: z.string().max(10) }), response: { 200: Log, ...errors } },
  }, async (request) => svc.assessmentLog(db, request.params.id, request.params.code));

  app.get('/assessments/:id/log', {
    preHandler: owner,
    schema: { tags, summary: 'Журнал действий по оценке', params: IdParams, response: { 200: Log, ...errors } },
  }, async (request) => svc.assessmentLog(db, request.params.id));

  for (const [path, fn, summary] of [
    ['finalize', svc.finalizeAssessment, 'Зафиксировать: только при 24 из 24, итог замораживается'],
    ['archive', svc.archiveAssessment, 'В архив (удаления нет)'],
  ] as const) {
    app.post(`/assessments/:id/${path}`, {
      preHandler: owner,
      schema: { tags, summary, params: IdParams, body: Version, response: { 200: Detail, ...errors } },
    }, async (request) => {
      await fn(db, actorOf(request), request.params.id, request.body);
      return detail(request.params.id);
    });
  }

  app.post('/assessments/:id/reopen', {
    preHandler: owner,
    schema: { tags, summary: 'Вернуть в черновик (комментарий необязателен)', params: IdParams, body: Version.extend({ comment: z.string().max(svc.COMMENT_MAX).optional() }), response: { 200: Detail, ...errors } },
  }, async (request) => {
    await svc.reopenAssessment(db, actorOf(request), request.params.id, request.body);
    return detail(request.params.id);
  });
};
