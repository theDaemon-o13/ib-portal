import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAuth, requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';
import { DOC_STATUSES } from './status.js';

const tags = ['documents'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });

const Person = z.object({ id: z.string(), fullName: z.string() });
const Status = z.enum(DOC_STATUSES);
const DocItem = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  /** «Редакция» для отображения, например «3.1». */
  edition: z.string(),
  /** Номер показанной версии (1, 2, 3…). */
  versionNo: z.number().int(),
  type: z.object({ id: z.string(), value: z.string() }),
  owner: Person,
  approvedVersionNo: z.number().int().nullable(),
  approvedAt: z.string().nullable(),
  reviewMonths: z.number().int(),
  reviewDue: z.string().nullable(),
  status: Status,
  statusName: z.string(),
  stage: z.number().int().nullable(),
  stageName: z.string().nullable(),
  waitingForMe: z.boolean(),
  archived: z.boolean(),
  version: z.number().int(),
});
const Version_ = z.object({
  id: z.string(), no: z.number().int(), edition: z.string(), title: z.string(), onlyofficeUrl: z.string(), changeNote: z.string(),
  stage: z.number().int(), stageName: z.string(), round: z.number().int(), approvedAt: z.string().nullable(), createdAt: z.string(),
});
const DocDetail = DocItem.extend({
  current: Version_,
  working: Version_.nullable(),
  approved: Version_.nullable(),
  route: z.array(z.object({
    stage: z.number().int(), name: z.string(), state: z.enum(['done', 'current', 'todo']),
    approvers: z.array(z.string()), hint: z.string(), actedBy: z.string().nullable(), actedAt: z.string().nullable(),
    /** Этап не требуется (согласовать мог только владелец): причина. */
    skipped: z.string().nullable(),
  })),
  can: z.object({ edit: z.boolean(), submit: z.boolean(), approve: z.boolean(), revise: z.boolean(), manage: z.boolean() }),
  blockedReason: z.string().nullable(),
  versions: z.array(z.object({
    no: z.number().int(), edition: z.string(), title: z.string(), onlyofficeUrl: z.string(), approvedAt: z.string().nullable(), changeNote: z.string(),
  })),
  history: z.array(z.object({
    id: z.string(), at: z.string(), actor: z.string(), stage: z.number().int(), stageName: z.string(),
    decision: z.enum(['submitted', 'approved', 'returned', 'revision_started', 'skipped']), comment: z.string(), versionNo: z.number().int(), round: z.number().int(),
  })),
});
type DetailOut = z.infer<typeof DocDetail>;
/** Ответ действий: карточка после изменения или null, если документ вам больше не виден (вернули на доработку). */
const Result = z.object({ document: DocDetail.nullable() });

// Раздел «Документы» открыт всем вошедшим (и без ib.work). Кто что видит и может — решает сервис:
// этапы маршрута — по правам docs.approve.*, автор — владелец или docs.manage (CLAUDE.md, правило 8).
const anyUser = requireAuth();

export const documentRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const access = (request: Parameters<typeof actorOf>[0]) => svc.accessOf(db, actorOf(request).id);
  const detail = async (request: Parameters<typeof actorOf>[0], id: string) =>
    (await svc.getDocument(db, await access(request), id)) as DetailOut;
  const result = async (request: Parameters<typeof actorOf>[0], id: string) => ({
    document: await detail(request, id).catch((err: unknown) => {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }),
  });

  app.get('/documents', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Реестр документов. Без ib.work — утверждённые, «ждёт вас» и согласованные вами в текущем круге',
      querystring: z.object({
        archived: z.enum(['true', 'false']).optional(),
        status: Status.optional(),
        typeId: z.string().uuid().optional(),
        q: z.string().max(200).optional(),
        waiting: z.enum(['me']).optional(),
        limit: z.coerce.number().int().min(1).max(svc.LIST_LIMIT).default(200),
        cursor: z.string().max(20).optional(),
      }),
      response: { 200: z.object({ items: z.array(DocItem), nextCursor: z.string().nullable(), total: z.number().int(), archivedTotal: z.number().int() }), ...errors },
    },
  }, async (request) => {
    const q = request.query;
    return svc.listDocuments(db, await access(request), {
      archived: q.archived === 'true', status: q.status, typeId: q.typeId, q: q.q, waiting: q.waiting === 'me', limit: q.limit, cursor: q.cursor,
    });
  });

  app.get('/documents/summary', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Счётчик в меню: ждут вас; просроченный пересмотр (только с ib.work)',
      response: { 200: z.object({ waitingForMe: z.number().int(), reviewOverdue: z.number().int() }), ...errors },
    },
  }, async (request) => svc.documentSummary(db, await access(request)));

  app.post('/documents', {
    preHandler: requirePerm('docs.manage'),
    schema: {
      tags, summary: 'Новый документ: версия 1, черновик на этапе «Автор»',
      body: z.object({
        title: z.string().max(svc.TITLE_MAX),
        typeId: z.string().uuid(),
        ownerId: z.string().uuid(),
        onlyofficeUrl: z.string().max(svc.URL_MAX),
        edition: z.string().max(svc.EDITION_MAX).optional(),
        changeNote: z.string().max(svc.NOTE_MAX).optional(),
        reviewMonths: z.number().int().min(1).max(60).optional(),
      }),
      response: { 201: Result, ...errors },
    },
  }, async (request, reply) => {
    const id = await svc.createDocument(db, actorOf(request), request.body);
    return reply.status(201).send(await result(request, id));
  });

  app.get('/documents/:id', {
    preHandler: anyUser,
    schema: { tags, summary: 'Карточка: версии, маршрут и кто может согласовать этапы, история согласования', params: IdParams, response: { 200: DocDetail, ...errors } },
  }, async (request) => detail(request, request.params.id));

  app.patch('/documents/:id', {
    preHandler: anyUser,
    schema: {
      tags,
      summary: 'Правка: содержимое черновика — владелец или docs.manage; тип, владелец, цикл — docs.manage. Нужна version; 409 — документ изменили',
      params: IdParams,
      body: Version.extend({
        title: z.string().max(svc.TITLE_MAX).optional(),
        edition: z.string().max(svc.EDITION_MAX).optional(),
        onlyofficeUrl: z.string().max(svc.URL_MAX).optional(),
        changeNote: z.string().max(svc.NOTE_MAX).optional(),
        typeId: z.string().uuid().optional(),
        ownerId: z.string().uuid().optional(),
        reviewMonths: z.number().int().min(1).max(60).optional(),
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.updateDocument(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  const RouteBody = Version.extend({ stage: z.number().int().min(0).max(3), comment: z.string().max(svc.COMMENT_MAX).optional() });
  for (const [path, fn, summary] of [
    ['submit', svc.submitDocument, 'Этап «Автор»: отправить на согласование (владелец или docs.manage)'],
    ['approve', svc.approveDocument, 'Согласовать текущий этап (право этапа; не супер-администратор; не второй этап той же версии)'],
    ['return', svc.returnDocument, 'Вернуть на доработку с комментарием: маршрут заново, владельцу — задача'],
  ] as const) {
    app.post(`/documents/:id/${path}`, {
      preHandler: anyUser,
      schema: { tags, summary, params: IdParams, body: RouteBody, response: { 200: Result, ...errors } },
    }, async (request) => {
      await fn(db, actorOf(request), request.params.id, request.body);
      return result(request, request.params.id);
    });
  }

  app.post('/documents/:id/revise', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Новая версия утверждённого документа (правка или пересмотр без изменений): владелец или docs.manage',
      params: IdParams,
      body: Version.extend({
        title: z.string().max(svc.TITLE_MAX).optional(),
        edition: z.string().max(svc.EDITION_MAX).optional(),
        onlyofficeUrl: z.string().max(svc.URL_MAX).optional(),
        changeNote: z.string().max(svc.NOTE_MAX).optional(),
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.reviseDocument(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  for (const [path, archived, summary] of [['archive', true, 'В архив'], ['restore', false, 'Вернуть из архива']] as const) {
    app.post(`/documents/:id/${path}`, {
      preHandler: requirePerm('docs.manage'),
      schema: { tags, summary, params: IdParams, body: Version, response: { 200: Result, ...errors } },
    }, async (request) => {
      await svc.setDocumentArchived(db, actorOf(request), request.params.id, request.body.version, archived);
      return result(request, request.params.id);
    });
  }
};
