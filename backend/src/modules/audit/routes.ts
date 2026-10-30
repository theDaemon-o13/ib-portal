// Раздел «Журнал» (ADR-0021): только чтение audit_log по праву audit.view; без права — 403.
import type { FastifyRequest } from 'fastify';
import { ASSESSMENT_PERMISSION } from '../../lib/permissions.js';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { PageQuery, pageSchema } from '../../lib/pagination.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['audit'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse };
const view = requirePerm('audit.view');
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const Filter = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  userId: z.union([z.string().uuid(), z.literal('system')]).optional(),
  action: z.string().max(100).optional(),
  entity: z.string().max(500).optional(),
  ip: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
});

export const AuditEntry = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.object({ id: z.string(), login: z.string(), fullName: z.string() }).nullable(),
  actorRoles: z.array(z.string()),
  action: z.string(),
  actionLabel: z.string(),
  entity: z.string().nullable(),
  entityLabel: z.string(),
  entityId: z.string().nullable(),
  summary: z.string(),
  ip: z.string().nullable(),
  /** Переход к объекту; null — объекта нет, он удалён или у раздела нет страницы. */
  href: z.string().nullable(),
  objectDeleted: z.boolean(),
  /** Подробности изменения; ключи с паролями и хешами вырезаны. */
  diff: z.unknown(),
});

const Option = z.object({ code: z.string(), label: z.string() });

/** Записи самооценки — только держателям assessment.manage (ADR-0026): фильтр в запросе, а не в интерфейсе. */
const hideAssessment = (request: FastifyRequest) => !request.user?.permissions.has(ASSESSMENT_PERMISSION);

export const auditRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/audit', {
    preHandler: view,
    schema: {
      tags, summary: 'Журнал действий пользователей (новые сверху)',
      querystring: PageQuery.merge(Filter),
      response: { 200: pageSchema(AuditEntry), ...errors },
    },
  }, async (request) => svc.listAudit(db, { ...request.query, hideAssessment: hideAssessment(request) }));

  app.get('/audit/facets', {
    preHandler: view,
    schema: {
      tags, summary: 'Виды действий и разделы журнала для фильтров',
      response: {
        200: z.object({
          users: z.array(z.object({ id: z.string(), login: z.string(), fullName: z.string(), isActive: z.boolean() })),
          actions: z.array(Option),
          entities: z.array(Option),
        }),
        ...errors,
      },
    },
  }, async (request) => svc.auditFacets(db, { hideAssessment: hideAssessment(request) }));

  app.get('/audit/export', {
    preHandler: view,
    schema: { tags, summary: `Выгрузка журнала в Excel по фильтру (до ${svc.EXPORT_LIMIT} строк)`, querystring: Filter },
  }, async (request, reply) => {
    const { fileName, buffer } = await svc.exportAudit(db, actorOf(request), { ...request.query, hideAssessment: hideAssessment(request) });
    return reply
      .header('Content-Type', XLSX_TYPE)
      .header('Content-Disposition', `attachment; filename="audit.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header('Cache-Control', 'no-store')
      .send(buffer);
  });
};
