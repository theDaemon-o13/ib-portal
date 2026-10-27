import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { unauthorized } from '../../lib/errors.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { FileOut } from '../files/routes.js';
import * as svc from './service.js';
import { EVIDENCE_KINDS, EVIDENCE_STATES } from './status.js';

const tags = ['evidence'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const Person = z.object({ id: z.string(), fullName: z.string() });
const DateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ObjectType = z.enum(['record', 'document', 'system']);
const State = z.enum(EVIDENCE_STATES);

const Item = z.object({
  id: z.string(),
  number: z.number().int(),
  kind: z.enum(EVIDENCE_KINDS),
  kindName: z.string(),
  title: z.string(),
  object: z.object({ type: ObjectType, id: z.string(), label: z.string(), registerId: z.string().nullable() }),
  template: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Сверка формы: «passed из total», несоответствия по названиям полей. */
  result: z.object({ passed: z.number().int(), total: z.number().int(), fails: z.array(z.string()) }).nullable(),
  files: z.array(z.object({ id: z.string(), name: z.string(), mime: z.string() })),
  uploadedBy: Person,
  owner: Person,
  confirmedBy: z.string(),
  createdAt: z.string(),
  validUntil: z.string().nullable(),
  daysLeft: z.number().int().nullable(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  /** С учётом срока действия: истекает (≤ 30 дней), истекло. */
  state: State,
  stateName: z.string(),
  archived: z.boolean(),
  version: z.number().int(),
});
const Check = z.object({
  fieldId: z.string(), label: z.string(), checkKind: z.enum(['min', 'max', 'yes', 'text']), threshold: z.number().nullable(),
  requirement: z.string(), value: z.string(), ok: z.boolean(),
});
const Detail = Item.extend({
  basis: z.string(),
  checks: z.array(Check).nullable(),
  fileList: z.array(FileOut.extend({ addedAt: z.string(), addedBy: z.string() })),
  decision: z.object({
    label: z.string(), documentTitle: z.string(), documentNumber: z.string(), documentDate: z.string(), reviewDue: z.string().nullable(),
  }).nullable(),
  reviewedBy: Person.nullable(),
  reviewedAt: z.string().nullable(),
  reviewComment: z.string(),
  can: z.object({ review: z.boolean(), addFiles: z.boolean(), removeFiles: z.boolean(), archive: z.boolean() }),
  reviewBlocked: z.string().nullable(),
  history: z.array(z.object({ id: z.string(), at: z.string(), actor: z.string(), summary: z.string() })),
});
type DetailOut = z.infer<typeof Detail>;

const ibWork = requirePerm('ib.work');

export const evidenceRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const viewer = (request: Parameters<typeof actorOf>[0]) => {
    if (!request.user) throw unauthorized();
    return { id: request.user.id, perms: request.user.permissions as ReadonlySet<string> };
  };
  const detail = async (request: Parameters<typeof actorOf>[0], id: string) => (await svc.getEvidence(db, viewer(request), id)) as DetailOut;

  app.get('/evidence', {
    preHandler: ibWork,
    schema: {
      tags, summary: 'Реестр доказательств: сначала на проверке, истекло, истекает',
      querystring: z.object({
        archived: z.enum(['true', 'false']).optional(),
        state: State.optional(),
        kind: z.enum(EVIDENCE_KINDS).optional(),
        templateId: z.string().uuid().optional(),
        objectType: ObjectType.optional(),
        objectId: z.string().uuid().optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(svc.LIST_LIMIT).default(200),
        cursor: z.string().max(20).optional(),
      }),
      response: {
        200: z.object({ items: z.array(Item), nextCursor: z.string().nullable(), total: z.number().int(), counts: z.record(State, z.number().int()) }),
        ...errors,
      },
    },
  }, async (request) => {
    const q = request.query;
    return svc.listEvidence(db, {
      archived: q.archived === 'true', state: q.state, kind: q.kind, templateId: q.templateId,
      object: q.objectType && q.objectId ? { type: q.objectType, id: q.objectId } : undefined,
      q: q.q, limit: q.limit, cursor: q.cursor,
    });
  });

  app.get('/evidence/summary', {
    preHandler: ibWork,
    schema: {
      tags, summary: 'Счётчики: на проверке, истекает, истекло',
      response: { 200: z.object({ pending: z.number().int(), expiring: z.number().int(), expired: z.number().int() }), ...errors },
    },
  }, async () => svc.evidenceSummary(db));

  app.get('/evidence/coverage', {
    preHandler: ibWork,
    schema: {
      tags, summary: 'Покрытие систем формами шаблона: последняя неотклонённая форма по каждой системе',
      querystring: z.object({ templateId: z.string().uuid() }),
      response: {
        200: z.object({
          template: z.object({ id: z.string(), name: z.string(), basis: z.string() }),
          items: z.array(z.object({
            system: z.object({ id: z.string(), value: z.string() }),
            evidenceId: z.string().nullable(), number: z.number().int().nullable(),
            state: State.nullable(), stateName: z.string(), validUntil: z.string().nullable(),
          })),
        }),
        ...errors,
      },
    },
  }, async (request) => svc.coverage(db, request.query.templateId));

  app.get('/evidence/:id', {
    preHandler: ibWork,
    schema: { tags, summary: 'Карточка доказательства: данные, поля формы со сверкой, файлы, история', params: IdParams, response: { 200: Detail, ...errors } },
  }, async (request) => detail(request, request.params.id));

  app.post('/evidence', {
    preHandler: ibWork,
    schema: {
      tags,
      summary: 'Загрузить доказательство: форма по шаблону (снимок полей и значений) или файл; файлы — из POST /files',
      body: z.object({
        kind: z.enum(['form', 'file']),
        object: z.object({ type: ObjectType, id: z.string().uuid() }),
        templateId: z.string().uuid().optional(),
        values: z.record(z.string().uuid(), z.union([z.string().max(1000), z.number(), z.boolean()])).optional(),
        title: z.string().max(svc.TITLE_MAX).optional(),
        confirmedBy: z.string().max(svc.CONFIRMED_MAX).optional(),
        validUntil: DateIso.nullable().optional(),
        ownerId: z.string().uuid().optional(),
        fileIds: z.array(z.string().uuid()).min(1).max(svc.MAX_FILES),
      }),
      response: { 201: Detail, ...errors },
    },
  }, async (request, reply) => {
    const id = await svc.createEvidence(db, actorOf(request), request.body);
    return reply.status(201).send(await detail(request, id));
  });

  app.patch('/evidence/:id', {
    preHandler: ibWork,
    schema: {
      tags, summary: 'Название и ответственный за продление', params: IdParams,
      body: Version.extend({ title: z.string().max(svc.TITLE_MAX).optional(), ownerId: z.string().uuid().optional() }),
      response: { 200: Detail, ...errors },
    },
  }, async (request) => {
    await svc.updateEvidence(db, actorOf(request), request.params.id, request.body);
    return detail(request, request.params.id);
  });

  app.post('/evidence/:id/files', {
    preHandler: ibWork,
    schema: {
      tags, summary: 'Добавить файлы: принятое или отклонённое доказательство снова уходит на проверку', params: IdParams,
      body: Version.extend({ fileIds: z.array(z.string().uuid()).min(1).max(svc.MAX_FILES) }),
      response: { 200: Detail, ...errors },
    },
  }, async (request) => {
    await svc.addEvidenceFiles(db, actorOf(request), request.params.id, request.body);
    return detail(request, request.params.id);
  });

  app.post('/evidence/:id/files/:fileId/remove', {
    preHandler: ibWork,
    schema: {
      tags, summary: 'Убрать файл (только у доказательства на проверке; загрузивший или проверяющий). Файл без других ссылок помечается удалённым',
      params: IdParams.extend({ fileId: z.string().uuid() }), body: Version, response: { 200: Detail, ...errors },
    },
  }, async (request) => {
    await svc.removeEvidenceFile(db, { ...actorOf(request), perms: viewer(request).perms }, request.params.id, request.params.fileId, request.body.version);
    return detail(request, request.params.id);
  });

  app.post('/evidence/:id/review', {
    preHandler: requirePerm('evidence.review'),
    schema: {
      tags, summary: 'Принять или отклонить (с комментарием; загрузившему — задача). Своё доказательство не проверяют',
      params: IdParams,
      body: Version.extend({ decision: z.enum(['accept', 'reject']), comment: z.string().max(svc.COMMENT_MAX).optional() }),
      response: { 200: Detail, ...errors },
    },
  }, async (request) => {
    await svc.reviewEvidence(db, actorOf(request), request.params.id, request.body);
    return detail(request, request.params.id);
  });

  for (const [path, archived, summary] of [['archive', true, 'В архив'], ['restore', false, 'Вернуть из архива']] as const) {
    app.post(`/evidence/:id/${path}`, {
      preHandler: ibWork,
      schema: { tags, summary, params: IdParams, body: Version, response: { 200: Detail, ...errors } },
    }, async (request) => {
      await svc.setEvidenceArchived(db, actorOf(request), request.params.id, request.body.version, archived);
      return detail(request, request.params.id);
    });
  }
};
