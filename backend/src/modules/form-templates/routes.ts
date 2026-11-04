import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAnyPerm, requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['form-templates'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

const CheckKind = z.enum(['min', 'max', 'yes', 'text']);
const Field = z.object({
  id: z.string(),
  label: z.string(),
  checkKind: CheckKind,
  threshold: z.number().nullable(),
  sortOrder: z.number().int(),
  version: z.number().int(),
});
export const FormTemplate = z.object({
  id: z.string(),
  name: z.string(),
  basis: z.string(),
  validMonths: z.number().int(),
  version: z.number().int(),
  archived: z.boolean(),
  usage: z.number().int(),
  fields: z.array(Field),
});
const Name = z.string().trim().min(1).max(300);
const Basis = z.string().trim().max(300);
const ValidMonths = z.number().int().min(1).max(120);
const Label = z.string().trim().min(1).max(300);
const Threshold = z.number().finite().min(-1e12).max(1e12).nullable();
const Version = z.object({ version: z.number().int().positive() });
const IdParams = z.object({ id: z.string().uuid() });
const manage = requirePerm('settings.manage');

export const formTemplateRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/form-templates', {
    preHandler: requireAnyPerm(['ib.work', 'settings.manage']),  // служебный администратор (ADR-0036)
    schema: {
      tags,
      summary: 'Шаблоны форм подтверждения',
      querystring: z.object({ includeArchived: z.enum(['true', 'false']).optional() }),
      response: { 200: z.object({ items: z.array(FormTemplate) }), ...errors },
    },
  }, async (request) => ({ items: await svc.listTemplates(db, { includeArchived: request.query.includeArchived === 'true' }) }));

  app.post('/form-templates', {
    preHandler: manage,
    schema: {
      tags, summary: 'Создать шаблон',
      body: z.object({ name: Name, basis: Basis.default(''), validMonths: ValidMonths }),
      response: { 201: FormTemplate, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await svc.createTemplate(db, actorOf(request), request.body)));

  app.patch('/form-templates/:id', {
    preHandler: manage,
    schema: {
      tags, summary: 'Изменить шаблон', params: IdParams,
      body: Version.extend({ name: Name.optional(), basis: Basis.optional(), validMonths: ValidMonths.optional() }),
      response: { 200: FormTemplate, ...errors },
    },
  }, async (request) => svc.updateTemplate(db, actorOf(request), request.params.id, request.body));

  for (const [path, fn, summary] of [
    ['archive', svc.archiveTemplate, 'В архив'],
    ['restore', svc.restoreTemplate, 'Вернуть из архива'],
  ] as const) {
    app.post(`/form-templates/:id/${path}`, {
      preHandler: manage,
      schema: { tags, summary, params: IdParams, body: Version, response: { 200: FormTemplate, ...errors } },
    }, async (request) => fn(db, actorOf(request), request.params.id, request.body.version));
  }

  app.post('/form-templates/:id/delete', {
    preHandler: manage,
    schema: { tags, summary: 'Удалить неиспользуемый шаблон', params: IdParams, body: Version, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await svc.deleteTemplate(db, actorOf(request), request.params.id, request.body.version);
    return reply.status(204).send(null);
  });

  app.post('/form-templates/:id/fields', {
    preHandler: manage,
    schema: {
      tags, summary: 'Добавить поле', params: IdParams,
      body: z.object({ label: Label, checkKind: CheckKind, threshold: Threshold.optional() }),
      response: { 200: FormTemplate, ...errors },
    },
  }, async (request) => svc.addField(db, actorOf(request), request.params.id, request.body));

  app.patch('/form-template-fields/:id', {
    preHandler: manage,
    schema: {
      tags, summary: 'Изменить поле', params: IdParams,
      body: Version.extend({ label: Label.optional(), checkKind: CheckKind.optional(), threshold: Threshold.optional() }),
      response: { 200: FormTemplate, ...errors },
    },
  }, async (request) => svc.updateField(db, actorOf(request), request.params.id, request.body));

  app.post('/form-template-fields/:id/delete', {
    preHandler: manage,
    schema: { tags, summary: 'Удалить поле', params: IdParams, body: Version, response: { 200: FormTemplate, ...errors } },
  }, async (request) => svc.deleteField(db, actorOf(request), request.params.id, request.body.version));

  app.post('/form-template-fields/:id/move', {
    preHandler: manage,
    schema: {
      tags, summary: 'Переместить поле выше или ниже', params: IdParams,
      body: z.object({ direction: z.enum(['up', 'down']) }),
      response: { 200: FormTemplate, ...errors },
    },
  }, async (request) => svc.moveField(db, actorOf(request), request.params.id, request.body.direction));
};
