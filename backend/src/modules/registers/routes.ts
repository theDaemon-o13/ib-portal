import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { PageQuery } from '../../lib/pagination.js';
import { ANALYTICS_ROLES, FIELD_TYPES } from '../../lib/register-values.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { registerAnalytics } from './analytics.service.js';
import * as excel from './excel.service.js';
import * as records from './records.service.js';
import * as structure from './structure.service.js';
import { loadRegister } from './definition.js';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const Direction = z.object({ direction: z.enum(['up', 'down']) });
const FieldType = z.enum(FIELD_TYPES);
const Role = z.enum(ANALYTICS_ROLES);
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const IMPORT_BODY_LIMIT = 25 * 1024 * 1024;

const CalcRule = z.object({
  fromFieldId: z.string().uuid(),
  byFieldId: z.string().uuid(),
  days: z.record(z.string().uuid(), z.number().int().min(0).max(3650)),
  overrideFieldId: z.string().uuid().nullable(),
});
const Option = z.object({
  id: z.string(), label: z.string(), isClosed: z.boolean(), archived: z.boolean(), sortOrder: z.number().int(), version: z.number().int(),
});
const Field = z.object({
  id: z.string(),
  label: z.string(),
  type: FieldType,
  sortOrder: z.number().int(),
  analyticsRole: z.string().nullable(),
  isTitle: z.boolean(),
  isStatus: z.boolean(),
  calcRule: CalcRule.nullable(),
  archived: z.boolean(),
  version: z.number().int(),
  options: z.array(Option),
});
export const RegisterDetail = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  ownerUserId: z.string().nullable(),
  archived: z.boolean(),
  version: z.number().int(),
  fields: z.array(Field),
});
const RegisterListItem = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  owner: z.object({ id: z.string(), fullName: z.string() }).nullable(),
  archived: z.boolean(),
  version: z.number().int(),
  fieldCount: z.number().int(),
  recordCount: z.number().int(),
});
const Decision = z.object({
  optionId: z.string(), label: z.string(), documentTitle: z.string(), documentNumber: z.string(), documentDate: z.string(),
  hasFile: z.boolean(), decidedAt: z.string(), decidedBy: z.string(),
});
export const RegisterRecord = z.object({
  id: z.string(),
  number: z.number().int(),
  values: z.record(z.string(), z.union([z.string(), z.number()])),
  display: z.record(z.string(), z.string()),
  calc: z.record(z.string(), z.string().nullable()),
  decisions: z.record(z.string(), Decision.nullable()),
  closed: z.boolean(),
  archived: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const HistoryEntry = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.object({ fullName: z.string(), login: z.string() }).nullable(),
  action: z.string(),
  summary: z.string(),
  via: z.string().nullable(),
  changes: z.array(z.object({ fieldId: z.string(), label: z.string(), from: z.string(), to: z.string() })),
});
const TypePreview = z.object({
  kind: z.enum(['empty', 'to_text', 'from_text']),
  affected: z.number().int(),
  errors: z.array(z.object({ number: z.number().int(), value: z.string() })),
  newOptions: z.array(z.string()),
  samples: z.array(z.object({ number: z.number().int(), from: z.string(), to: z.string() })),
});
const ImportSummary = z.object({
  fileName: z.string(),
  rows: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  errorRows: z.number().int(),
  fieldChanges: z.array(z.object({ fieldId: z.string(), label: z.string(), count: z.number().int() })),
  errors: z.array(z.object({ row: z.number().int(), id: z.string().nullable(), field: z.string().nullable(), message: z.string() })),
  warnings: z.array(z.string()),
});
const ImportPreview = z.object({ id: z.string(), status: z.string(), expiresAt: z.string(), summary: ImportSummary });
const Label = z.string().trim().min(1).max(200);

const view = requirePerm('ib.work');
const manage = requirePerm('registers.manage');
const edit = requirePerm('records.edit');

type Detail = z.infer<typeof RegisterDetail>;
type Rec = z.infer<typeof RegisterRecord>;
const asDetail = (r: unknown) => r as Detail;
const asRecord = (r: unknown) => r as Rec;

export const registerRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  // ------------------------------------------------------------ реестры
  app.get('/registers', {
    preHandler: view,
    schema: {
      tags: ['registers'], summary: 'Реестры',
      querystring: z.object({ includeArchived: z.enum(['true', 'false']).optional() }),
      response: { 200: z.object({ items: z.array(RegisterListItem) }), ...errors },
    },
  }, async (request) => ({ items: await structure.listRegisters(db, { includeArchived: request.query.includeArchived === 'true' }) }));

  app.get('/registers/:id', {
    preHandler: view,
    schema: { tags: ['registers'], summary: 'Реестр с полями', params: IdParams, response: { 200: RegisterDetail, ...errors } },
  }, async (request) => asDetail(await loadRegister(db, request.params.id)));

  app.get('/registers/:id/analytics', {
    preHandler: view,
    schema: {
      tags: ['registers'], summary: 'Предпросмотр «Попадёт на дашборд»: виджеты по полям с ролью аналитики', params: IdParams,
      response: {
        200: z.object({
          items: z.array(z.object({
            fieldId: z.string(), label: z.string(), role: z.string(),
            kind: z.enum(['distribution', 'metric', 'timeline', 'deadline']),
            rows: z.array(z.object({ label: z.string(), count: z.number().int() })),
            empty: z.number().int(), avg: z.number().nullable(), max: z.number().nullable(), filled: z.number().int(),
          })),
        }),
        ...errors,
      },
    },
  }, async (request) => ({ items: await registerAnalytics(db, request.params.id) }));

  app.post('/registers', {
    preHandler: manage,
    schema: {
      tags: ['registers'], summary: 'Создать реестр',
      body: z.object({ name: Label, description: z.string().trim().max(500).optional(), ownerUserId: z.string().uuid().nullable().optional() }),
      response: { 201: RegisterDetail, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(asDetail(await structure.createRegister(db, actorOf(request), request.body))));

  app.patch('/registers/:id', {
    preHandler: manage,
    schema: {
      tags: ['registers'], summary: 'Переименовать реестр, описание, владелец', params: IdParams,
      body: Version.extend({ name: Label.optional(), description: z.string().trim().max(500).optional(), ownerUserId: z.string().uuid().nullable().optional() }),
      response: { 200: RegisterDetail, ...errors },
    },
  }, async (request) => asDetail(await structure.updateRegister(db, actorOf(request), request.params.id, request.body)));

  for (const [path, archived, summary] of [['archive', true, 'В архив'], ['restore', false, 'Вернуть из архива']] as const) {
    app.post(`/registers/:id/${path}`, {
      preHandler: manage,
      schema: { tags: ['registers'], summary, params: IdParams, body: Version, response: { 200: RegisterDetail, ...errors } },
    }, async (request) => asDetail(await structure.setRegisterArchived(db, actorOf(request), request.params.id, request.body.version, archived)));
  }

  // ------------------------------------------------------------ поля
  app.post('/registers/:id/fields', {
    preHandler: manage,
    schema: {
      tags: ['register-fields'], summary: 'Добавить поле', params: IdParams,
      body: z.object({
        label: Label,
        type: FieldType,
        options: z.array(z.string().max(200)).max(200).optional(),
        analyticsRole: Role.nullable().optional(),
        calcRule: CalcRule.optional(),
      }),
      response: { 200: RegisterDetail, ...errors },
    },
  }, async (request) => asDetail(await structure.addField(db, actorOf(request), request.params.id, request.body)));

  app.patch('/register-fields/:id', {
    preHandler: manage,
    schema: {
      tags: ['register-fields'], summary: 'Переименовать поле, роль аналитики, заголовок, статус, правило', params: IdParams,
      body: Version.extend({
        label: Label.optional(),
        analyticsRole: Role.nullable().optional(),
        isTitle: z.boolean().optional(),
        isStatus: z.boolean().optional(),
        calcRule: CalcRule.optional(),
      }),
      response: { 200: RegisterDetail, ...errors },
    },
  }, async (request) => asDetail(await structure.updateField(db, actorOf(request), request.params.id, request.body)));

  app.post('/register-fields/:id/move', {
    preHandler: manage,
    schema: { tags: ['register-fields'], summary: 'Переместить поле', params: IdParams, body: Direction, response: { 200: RegisterDetail, ...errors } },
  }, async (request) => asDetail(await structure.moveField(db, actorOf(request), request.params.id, request.body.direction)));

  for (const [path, archived, summary] of [['archive', true, 'В архив (значения сохраняются)'], ['restore', false, 'Вернуть из архива']] as const) {
    app.post(`/register-fields/:id/${path}`, {
      preHandler: manage,
      schema: { tags: ['register-fields'], summary, params: IdParams, body: Version, response: { 200: RegisterDetail, ...errors } },
    }, async (request) => asDetail(await structure.setFieldArchived(db, actorOf(request), request.params.id, request.body.version, archived)));
  }

  app.post('/register-fields/:id/delete', {
    preHandler: manage,
    schema: { tags: ['register-fields'], summary: 'Удалить поле без данных', params: IdParams, body: Version, response: { 200: RegisterDetail, ...errors } },
  }, async (request) => asDetail(await structure.deleteField(db, actorOf(request), request.params.id, request.body.version)));

  app.post('/register-fields/:id/type/preview', {
    preHandler: manage,
    schema: {
      tags: ['register-fields'], summary: 'Предпросмотр смены типа: сколько записей изменится', params: IdParams,
      body: z.object({ to: FieldType }), response: { 200: TypePreview, ...errors },
    },
  }, async (request) => structure.previewTypeChange(db, request.params.id, request.body.to));

  app.post('/register-fields/:id/type', {
    preHandler: manage,
    schema: {
      tags: ['register-fields'], summary: 'Сменить тип поля (после предпросмотра)', params: IdParams,
      body: Version.extend({ to: FieldType }), response: { 200: RegisterDetail, ...errors },
    },
  }, async (request) => asDetail(await structure.applyTypeChange(db, actorOf(request), request.params.id, request.body)));

  // ------------------------------------------------------------ значения списков
  app.post('/register-fields/:id/options', {
    preHandler: manage,
    schema: { tags: ['register-fields'], summary: 'Добавить значение списка', params: IdParams, body: z.object({ label: Label }), response: { 200: RegisterDetail, ...errors } },
  }, async (request) => asDetail(await structure.addOption(db, actorOf(request), request.params.id, request.body)));

  app.patch('/register-field-options/:id', {
    preHandler: manage,
    schema: {
      tags: ['register-fields'], summary: 'Переименовать значение, признак закрытого статуса', params: IdParams,
      body: Version.extend({ label: Label.optional(), isClosed: z.boolean().optional() }), response: { 200: RegisterDetail, ...errors },
    },
  }, async (request) => asDetail(await structure.updateOption(db, actorOf(request), request.params.id, request.body)));

  app.post('/register-field-options/:id/move', {
    preHandler: manage,
    schema: { tags: ['register-fields'], summary: 'Переместить значение', params: IdParams, body: Direction, response: { 200: RegisterDetail, ...errors } },
  }, async (request) => asDetail(await structure.moveOption(db, actorOf(request), request.params.id, request.body.direction)));

  for (const [path, archived, summary] of [['archive', true, 'В архив'], ['restore', false, 'Вернуть из архива']] as const) {
    app.post(`/register-field-options/:id/${path}`, {
      preHandler: manage,
      schema: { tags: ['register-fields'], summary, params: IdParams, body: Version, response: { 200: RegisterDetail, ...errors } },
    }, async (request) => asDetail(await structure.setOptionArchived(db, actorOf(request), request.params.id, request.body.version, archived)));
  }

  app.post('/register-field-options/:id/delete', {
    preHandler: manage,
    schema: { tags: ['register-fields'], summary: 'Удалить неиспользуемое значение', params: IdParams, body: Version, response: { 200: RegisterDetail, ...errors } },
  }, async (request) => asDetail(await structure.deleteOption(db, actorOf(request), request.params.id, request.body.version)));

  // ------------------------------------------------------------ записи
  app.get('/registers/:id/records', {
    preHandler: view,
    schema: {
      tags: ['register-records'], summary: 'Записи реестра: поиск, сортировка, пагинация', params: IdParams,
      querystring: PageQuery.extend({
        q: z.string().max(200).optional(),
        sort: z.string().max(64).optional(),
        dir: z.enum(['asc', 'desc']).optional(),
        includeArchived: z.enum(['true', 'false']).optional(),
      }),
      response: { 200: z.object({ items: z.array(RegisterRecord), nextCursor: z.string().nullable(), total: z.number().int() }), ...errors },
    },
  }, async (request) => {
    const page = await records.listRecords(db, request.params.id, { ...request.query, includeArchived: request.query.includeArchived === 'true' });
    return { ...page, items: page.items.map(asRecord) };
  });

  app.get('/register-records/:id', {
    preHandler: view,
    schema: { tags: ['register-records'], summary: 'Запись', params: IdParams, response: { 200: RegisterRecord, ...errors } },
  }, async (request) => asRecord(await records.getRecord(db, request.params.id)));

  app.get('/register-records/:id/history', {
    preHandler: view,
    schema: { tags: ['register-records'], summary: 'История изменений записи', params: IdParams, response: { 200: z.object({ items: z.array(HistoryEntry) }), ...errors } },
  }, async (request) => ({ items: await records.recordHistory(db, request.params.id) }));

  const Values = z.record(z.string().uuid(), z.union([z.string().max(4000), z.number(), z.null()]));

  app.post('/registers/:id/records', {
    preHandler: edit,
    schema: { tags: ['register-records'], summary: 'Создать запись', params: IdParams, body: z.object({ values: Values }), response: { 201: RegisterRecord, ...errors } },
  }, async (request, reply) => reply.status(201).send(asRecord(await records.createRecord(db, actorOf(request), request.params.id, request.body))));

  app.patch('/register-records/:id', {
    preHandler: edit,
    schema: {
      tags: ['register-records'], summary: 'Изменить запись (только переданные поля; null — очистить)', params: IdParams,
      body: Version.extend({ values: Values }), response: { 200: RegisterRecord, ...errors },
    },
  }, async (request) => asRecord(await records.updateRecord(db, actorOf(request), request.params.id, request.body)));

  for (const [path, archived, summary] of [['archive', true, 'В архив'], ['restore', false, 'Вернуть из архива']] as const) {
    app.post(`/register-records/:id/${path}`, {
      preHandler: edit,
      schema: { tags: ['register-records'], summary, params: IdParams, body: Version, response: { 200: RegisterRecord, ...errors } },
    }, async (request) => asRecord(await records.setRecordArchived(db, actorOf(request), request.params.id, request.body.version, archived)));
  }

  app.post('/register-records/:id/delete', {
    preHandler: requirePerm('records.delete'),
    schema: { tags: ['register-records'], summary: 'Удалить запись (мягкое удаление)', params: IdParams, body: Version, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await records.deleteRecord(db, actorOf(request), request.params.id, request.body.version);
    return reply.status(204).send(null);
  });

  // ------------------------------------------------------------ Excel
  app.get('/registers/:id/export', {
    preHandler: view,
    schema: { tags: ['register-excel'], summary: 'Экспорт в Excel (колонка ID, справка для заполнения)', params: IdParams },
  }, async (request, reply) => {
    const { fileName, buffer } = await excel.exportRegister(db, request.params.id);
    return reply
      .header('Content-Type', XLSX_TYPE)
      .header('Content-Disposition', `attachment; filename="register.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header('Cache-Control', 'no-store')
      .send(buffer);
  });

  app.post('/registers/:id/imports', {
    preHandler: edit,
    bodyLimit: IMPORT_BODY_LIMIT,
    schema: {
      tags: ['register-excel'],
      summary: 'Импорт, шаг 1: предпросмотр. Тело — файл .xlsx (Content-Type xlsx), имя файла — в X-File-Name',
      params: IdParams,
      body: z.any(),
      response: { 201: ImportPreview, ...errors },
    },
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) throw badRequest('BAD_FILE', 'Отправьте файл .xlsx');
    const raw = request.headers['x-file-name'];
    let fileName = 'import.xlsx';
    if (typeof raw === 'string' && raw) {
      try {
        fileName = decodeURIComponent(raw);
      } catch {
        fileName = raw;
      }
    }
    const preview = await excel.previewImport(db, actorOf(request), request.params.id, request.body, fileName);
    return reply.status(201).send(preview);
  });

  app.get('/register-imports/:id', {
    preHandler: edit,
    schema: { tags: ['register-excel'], summary: 'Предпросмотр импорта', params: IdParams, response: { 200: ImportPreview.extend({ registerId: z.string() }), ...errors } },
  }, async (request) => excel.getImport(db, request.params.id));

  app.post('/register-imports/:id/apply', {
    preHandler: edit,
    schema: {
      tags: ['register-excel'], summary: 'Импорт, шаг 2: применить одной транзакцией', params: IdParams,
      response: { 200: z.object({ added: z.number().int(), updated: z.number().int(), skipped: z.number().int() }), ...errors },
    },
  }, async (request) => excel.applyImport(db, actorOf(request), request.params.id));

  app.post('/register-imports/:id/cancel', {
    preHandler: edit,
    schema: { tags: ['register-excel'], summary: 'Отменить импорт', params: IdParams, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await excel.cancelImport(db, actorOf(request), request.params.id);
    return reply.status(204).send(null);
  });
};
