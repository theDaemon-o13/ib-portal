import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { ASSESSMENT_PERMISSION } from '../../lib/permissions.js';
import { IMPORT_BODY_LIMIT, XLSX_TYPE } from '../registers/routes.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as excel from './excel.js';
import * as presentation from './presentation.js';
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
    /** Входит ли домен в итог и уровень КБ (1.13.10, ADR-0050); нет поля — входит. */
    inTotal: z.boolean().optional(),
    sections: z.array(z.object({ code: z.string(), name: z.string(), target: z.string(), criteria: z.record(z.string(), z.string()), key: z.boolean().optional() })),
  })),
});
const LevelRef = z.object({ code: z.string(), name: z.string() });
const Score = z.object({
  total: z.number().int(), max: z.number().int(), answered: z.number().int(), sections: z.number().int(), preliminary: z.boolean(),
  level: LevelRef,
  keySections: z.array(z.object({ code: z.string(), name: z.string(), level: z.number().int().nullable() })),
  domains: z.array(z.object({
    no: z.number().int(), name: z.string(), inTotal: z.boolean(), sections: z.number().int(), answered: z.number().int(), sum: z.number().int(), max: z.number().int(),
    avg: z.number().nullable(), targetAvg: z.number().nullable(),
  })),
  distribution: z.object({ 1: z.number().int(), 2: z.number().int(), 3: z.number().int(), 4: z.number().int() }),
  gaps: z.array(z.object({ code: z.string(), name: z.string(), domainNo: z.number().int(), level: z.number().int(), target: z.number().int(), gap: z.number().int(), key: z.boolean(), inTotal: z.boolean() })),
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
  profile: Profile, reopenComment: z.string(), methodology: Methodology,
  /** Черновик на прежней методике: куда можно обновить (1.13.10); иначе null. */
  methodologyUpgrade: z.object({ code: z.string(), version: z.number().int(), name: z.string() }).nullable(),
  answers: z.array(Answer), score: Score,
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

  app.get('/assessments/export.xlsx', {
    preHandler: owner,
    schema: {
      tags, summary: 'Выгрузка таблиц для анализа: «Оценки», «Ответы», «Домены», «Задачи», «Методика». Без ids — все, кроме архивных',
      querystring: z.object({ ids: z.string().max(4000).optional() }),
    },
  }, async (request, reply) => {
    const ids = request.query.ids?.split(',').map((x) => x.trim()).filter(Boolean);
    if (ids?.some((x) => !z.string().uuid().safeParse(x).success)) throw badRequest('BAD_ID', 'Неверный список оценок');
    const { fileName, buffer } = await excel.exportAssessments(db, actorOf(request), ids);
    return reply
      .header('Content-Type', XLSX_TYPE)
      .header('Content-Disposition', `attachment; filename="assessment.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .send(buffer);
  });

  app.get('/assessments/compare', {
    preHandler: owner,
    schema: {
      tags, summary: 'Сравнение двух оценок по разделам и доменам', querystring: z.object({ a: z.string().uuid(), b: z.string().uuid() }),
      response: {
        200: z.object({
          a: Summary, b: Summary,
          domains: z.array(z.object({ no: z.number().int(), name: z.string(), a: z.number().int().nullable(), b: z.number().int(), aAvg: z.number().nullable(), bAvg: z.number().nullable() })),
          sections: z.array(z.object({ code: z.string(), name: z.string(), inA: z.boolean(), a: z.number().int().nullable(), b: z.number().int().nullable() })),
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

  const ImportResult = z.object({
    format: z.enum(['checklist', 'answers']), version: z.number().int(), found: z.number().int(), answered: z.number().int(),
    changes: z.array(z.object({ code: z.string(), name: z.string(), from: z.number().int().nullable(), to: z.number().int().nullable(), comment: z.boolean() })),
    profile: z.array(z.object({ label: z.string(), from: z.string(), to: z.string() })),
    errors: z.array(z.object({ row: z.number().int().nullable(), code: z.string().nullable(), message: z.string() })),
    notes: z.array(z.string()),
    sources: z.array(z.object({ id: z.string(), title: z.string(), date: z.string().nullable() })),
    sourceId: z.string().nullable(),
    total: z.number().int(), max: z.number().int(), level: LevelRef, preliminary: z.boolean(), applied: z.boolean(),
  });
  app.post('/assessments/:id/import', {
    preHandler: owner,
    bodyLimit: IMPORT_BODY_LIMIT,
    schema: {
      tags,
      summary: 'Импорт Excel в черновик. Тело — файл .xlsx. dryRun=true — предпросмотр «раздел, было, станет»; применение — тот же файл и version из предпросмотра',
      params: IdParams,
      querystring: z.object({
        dryRun: z.enum(['true', 'false']).optional(), version: z.coerce.number().int().positive().optional(), sourceId: z.string().max(64).optional(),
      }),
      body: z.any(),
      response: { 200: ImportResult, ...errors },
    },
  }, async (request) => {
    if (!Buffer.isBuffer(request.body)) throw badRequest('BAD_FILE', 'Отправьте файл .xlsx');
    return excel.importAssessment(db, actorOf(request), request.params.id, request.body, {
      dryRun: request.query.dryRun === 'true', version: request.query.version, sourceId: request.query.sourceId ?? null,
    });
  });

  app.get('/assessments/:id/answers/:code/history', {
    preHandler: owner,
    schema: { tags, summary: 'История раздела из журнала (без права «История в карточках»)', params: IdParams.extend({ code: z.string().max(10) }), response: { 200: Log, ...errors } },
  }, async (request) => svc.assessmentLog(db, request.params.id, request.params.code));

  app.get('/assessments/:id/log', {
    preHandler: owner,
    schema: { tags, summary: 'Журнал действий по оценке', params: IdParams, response: { 200: Log, ...errors } },
  }, async (request) => svc.assessmentLog(db, request.params.id));

  for (const [path, fn, summary] of [
    ['finalize', svc.finalizeAssessment, 'Зафиксировать: только при всех разделах снимка (24 у v1, 28 у v2), итог замораживается'],
    ['archive', svc.archiveAssessment, 'В архив (удаления нет)'],
    ['upgrade-methodology', svc.upgradeMethodology, 'Обновить методику черновика до активной: ответы сохраняются, новые разделы пустые; та же — 409 SAME_METHODOLOGY'],
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

// Подпись «Спроектировано» в презентации (Д5): правит «Настройки → Презентация» (settings.manage), раздел только читает.
const Signature = z.object({ signature: z.string(), version: z.number().int() });

export const presentationRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/settings/presentation', {
    preHandler: requirePerm('settings.manage'),
    schema: { tags: ['settings'], summary: 'Подпись «Спроектировано» в презентации самооценки', response: { 200: Signature, ...errors } },
  }, async () => presentation.getSignature(db));

  app.put('/settings/presentation', {
    preHandler: requirePerm('settings.manage'),
    schema: {
      tags: ['settings'], summary: 'Изменить подпись «Спроектировано» (запись в журнал)',
      body: z.object({ signature: z.string().max(presentation.SIGNATURE_MAX * 2), version: z.number().int().min(0) }),
      response: { 200: Signature, ...errors },
    },
  }, async (request) => presentation.setSignature(db, actorOf(request), request.body));

  app.get('/assessments/presentation-settings', {
    preHandler: owner,
    schema: {
      tags, summary: 'Строка «Спроектировано» для презентации (только чтение)',
      response: { 200: z.object({ signature: z.string() }), ...errors },
    },
  }, async () => ({ signature: (await presentation.getSignature(db)).signature }));
};
