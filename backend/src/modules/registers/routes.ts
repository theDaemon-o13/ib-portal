import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import type { FileStore } from '../../lib/file-store.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { isVulnRegister } from '../vulns/definition.js';
import { TEXT_MAX_MULTILINE } from '../../lib/field-settings.js';
import { PageQuery } from '../../lib/pagination.js';
import { ANALYTICS_ROLES, FIELD_TYPES } from '../../lib/register-values.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAnyPerm, requirePerm } from '../../plugins/rbac.js';
import { RECORD_REASONS } from '../trash/service.js';
import { actorOf } from '../settings/common.js';
import { assetImportAdapter } from '../assets/import.js';
import { registerAnalytics } from './analytics.service.js';
import * as bulk from './bulk.service.js';
import * as compare from './compare.service.js';
import * as decisions from './decisions.service.js';
import * as recordFiles from './record-files.service.js';
import * as excel from './excel.service.js';
import { exportZip } from './export-zip.js';
import * as records from './records.service.js';
import * as structure from './structure.service.js';
import { loadRegister } from './definition.js';
import { parseRecordFilter, RecordFilterQuery, type RecordFilterParams } from './filter.js';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const Direction = z.object({ direction: z.enum(['up', 'down']) });
const FieldType = z.enum(FIELD_TYPES);
const Role = z.enum(ANALYTICS_ROLES);
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const IMPORT_BODY_LIMIT = 25 * 1024 * 1024;

/** Правило срока (ввод): дата + дни по значению списка; замена датой — по желанию при заполненном поле; перенос на рабочий день. */
const CalcRule = z.object({
  fromFieldId: z.string().uuid(),
  byFieldId: z.string().uuid(),
  days: z.record(z.string().uuid(), z.number().int().min(0).max(3650)),
  overrideFieldId: z.string().uuid().nullable(),
  overrideWhenFilledFieldId: z.string().uuid().nullable().optional(),
  shiftToWorkday: z.boolean().optional(),
});
/** Статус основания (сверка с DLP, этап 8б): канал записи и разрешения другого реестра, которые на неё ссылаются. */
const BasisRule = z.object({
  kind: z.literal('link_basis'),
  channelFieldId: z.string().uuid(),
  closedOptionIds: z.array(z.string().uuid()).max(50),
  sourceRegisterId: z.string().uuid(),
  linkFieldId: z.string().uuid(),
  kindFieldId: z.string().uuid().nullable(),
  kindOptionIds: z.array(z.string().uuid()).max(50),
  statusFieldId: z.string().uuid(),
  activeOptionIds: z.array(z.string().uuid()).min(1).max(50),
  untilFieldId: z.string().uuid().nullable(),
  numberFieldId: z.string().uuid().nullable(),
});
const CalcRuleIn = z.union([BasisRule, CalcRule.extend({ kind: z.literal('due_date').optional() })]);
/** Правило в ответе: срок, оценка уязвимости (только у системного поля) или статус основания. */
const CalcRuleOut = z.union([
  z.object({ kind: z.literal('vuln_score'), cvssFieldId: z.string(), exploitFieldId: z.string(), fixFieldId: z.string() }),
  BasisRule,
  CalcRule.extend({ kind: z.literal('due_date').optional(), baseFieldId: z.string().nullable().optional(), addDaysFieldId: z.string().nullable().optional() }),
]);
/** Настройки поля (этап 8б): фиксация при статусах записи и ограничения даты. */
const FieldSettings = z.object({
  lock: z.object({ statusOptionIds: z.array(z.string().uuid()).max(50), mode: z.enum(['locked', 'reason']) }).optional(),
  date: z.object({ notAfterYearEndOfFieldId: z.string().uuid().nullable().optional(), defaultEndOfYear: z.boolean().optional() }).optional(),
  /** Многострочный текст (релиз 1.1.0): лимит 20 000 символов вместо 4000. */
  text: z.object({ multiline: z.boolean().optional() }).optional(),
  /** Подсказка под полем в карточке записи (релиз 1.6.0). */
  hint: z.string().max(1000).optional(),
});
const Option = z.object({
  id: z.string(), label: z.string(), isClosed: z.boolean(), archived: z.boolean(), sortOrder: z.number().int(), version: z.number().int(),
  systemKey: z.string().nullable(),
});
const Field = z.object({
  id: z.string(),
  label: z.string(),
  type: FieldType,
  sortOrder: z.number().int(),
  analyticsRole: z.string().nullable(),
  isTitle: z.boolean(),
  isStatus: z.boolean(),
  /** Ключ импорта Excel без колонки ID (этап 8). */
  isImportKey: z.boolean(),
  calcRule: CalcRuleOut.nullable(),
  archived: z.boolean(),
  version: z.number().int(),
  /** Системное поле: удалить, архивировать и сменить тип нельзя. */
  systemKey: z.string().nullable(),
  /** Поле «Значение справочника»: код справочника; options — его значения (правятся в настройках). */
  catalogCode: z.string().nullable(),
  /** Поле «Связь с записью»: реестр, на записи которого оно ссылается. */
  linkRegisterId: z.string().nullable(),
  settings: FieldSettings,
  options: z.array(Option),
  /** Служебное поле: значение ставит портал, в форме и импорте только для чтения (релиз 1.5.0). */
  managed: z.boolean().optional(),
});
export const RegisterDetail = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  ownerUserId: z.string().nullable(),
  archived: z.boolean(),
  version: z.number().int(),
  /** vulns — системный реестр уязвимостей. */
  systemKey: z.string().nullable(),
  /** Сравнение с реестром: ключ (пусто — по ID) и поля области. */
  compareKeyFieldIds: z.array(z.string()),
  compareScopeFieldIds: z.array(z.string()),
  fields: z.array(Field),
});
const RegisterListItem = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  owner: z.object({ id: z.string(), fullName: z.string() }).nullable(),
  archived: z.boolean(),
  /** Системный реестр: не удаляется (1.6.1) и не архивируется. */
  system: z.boolean(),
  version: z.number().int(),
  fieldCount: z.number().int(),
  recordCount: z.number().int(),
});

/** Причина удаления записей (1.6.1): из списка, «Другое» — с текстом; «Ложное срабатывание» — только у уязвимостей. */
const RecordReason = z.object({ reasonCode: z.enum(RECORD_REASONS), reason: z.string().max(4000).nullish() });

/**
 * Записи уязвимостей удаляет только «Удаление данных» (data.delete): удаление открытой записи снимает её с просрочек
 * и эскалаций п. 7.4. Записи остальных реестров — records.delete, как раньше.
 */
const recordDelete = requireAnyPerm(['records.delete', 'data.delete']);
function assertCanDeleteRecords(request: FastifyRequest, reg: { systemKey: string | null }) {
  const need = isVulnRegister(reg) ? 'data.delete' : 'records.delete';
  if (!request.user?.permissions.has(need)) throw forbidden();
}
const Decision = z.object({
  optionId: z.string(), label: z.string(), documentTitle: z.string(), documentNumber: z.string(), documentDate: z.string(),
  hasFile: z.boolean(), fileId: z.string(), reviewDue: z.string().nullable(), decidedAt: z.string(), decidedBy: z.string(),
});
const FileOut = z.object({
  id: z.string(), name: z.string(), mime: z.string(), size: z.number().int(), sha256: z.string(), uploadedAt: z.string(),
  uploadedBy: z.object({ id: z.string(), fullName: z.string() }), deleted: z.boolean(),
});
const LinkRef = z.object({ id: z.string(), registerId: z.string(), number: z.number().int(), title: z.string(), deleted: z.boolean() });
export const RegisterRecord = z.object({
  id: z.string(),
  number: z.number().int(),
  /** Связь с записью — массив id записей. */
  values: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])),
  display: z.record(z.string(), z.string()),
  calc: z.record(z.string(), z.union([z.string(), z.number()]).nullable()),
  decisions: z.record(z.string(), Decision.nullable()),
  closed: z.boolean(),
  archived: z.boolean(),
  manualFieldIds: z.array(z.string()),
  deadline: z.object({
    date: z.string().nullable(),
    daysLeft: z.number().int().nullable(),
    state: z.enum(['overdue', 'soon', 'ok', 'closed', 'none']),
  }).nullable(),
  /** Открытые задачи по записи из событий автоматизаций. */
  openTasks: z.number().int(),
  /** Поле «Файл»: действующие файлы (sha256, дата загрузки). */
  files: z.record(z.string(), z.array(z.object({
    linkId: z.string(), file: FileOut, addedAt: z.string(), addedBy: z.object({ id: z.string(), fullName: z.string() }),
  }))),
  /** Поле «Связь с записью»: связанные записи. */
  links: z.record(z.string(), z.array(LinkRef)),
  /** Статус основания по каналу: ok, none, expired, closed; разрешение и текст. */
  basis: z.record(z.string(), z.object({
    state: z.enum(['ok', 'none', 'expired', 'closed']),
    permission: z.object({ id: z.string(), number: z.number().int(), docNumber: z.string(), until: z.string().nullable() }).nullable(),
    text: z.string(),
  })),
  /** Поля, которые фиксирует текущий статус: locked — не меняются, reason — только с причиной. */
  locked: z.record(z.string(), z.enum(['locked', 'reason'])),
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
  /** Причина изменения поля «с причиной» при фиксирующем статусе. */
  reason: z.string().nullable(),
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
  /** id — по колонке ID; key — по полю-ключу импорта (этап 8). */
  matchBy: z.enum(['id', 'key']),
  keyField: z.object({ id: z.string(), label: z.string() }).nullable(),
  /** Сопоставление каждой строки файла: ID или ключ из файла, номер записи, что будет сделано. */
  matches: z.array(z.object({ row: z.number().int(), key: z.string(), number: z.number().int().nullable(), action: z.enum(['add', 'update', 'unchanged', 'error']) })),
  /** Импорт по ключу: действующие записи, которых нет в файле, — кандидаты на «Выведено» (портал их не меняет). */
  missing: z.array(z.object({ id: z.string(), number: z.number().int(), key: z.string(), title: z.string() })),
  missingTotal: z.number().int(),
  /** Адаптер импорта (1.6.0): сведения об источнике — тип отчёта KSC, итог сводки, дубли. */
  source: z.record(z.string(), z.unknown()).optional(),
  /** Блоки адаптера: что будет создано (optional — можно снять при применении), дубли в источнике. */
  blocks: z.array(z.object({
    code: z.string(), title: z.string(), hint: z.string().nullable(), items: z.array(z.string()), total: z.number().int(), optional: z.boolean(),
  })).optional(),
});
export const ImportPreview = z.object({ id: z.string(), status: z.string(), expiresAt: z.string(), summary: ImportSummary });
const Label = z.string().trim().min(1).max(200);
const DateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const view = requirePerm('ib.work');
const manage = requirePerm('registers.manage');
const edit = requirePerm('records.edit');

type Detail = z.infer<typeof RegisterDetail>;
type Rec = z.infer<typeof RegisterRecord>;
const asDetail = (r: unknown) => r as Detail;
const asRecord = (r: unknown) => r as Rec;

export const registerRoutes: FastifyPluginAsyncZod<{ db: Db; store: FileStore }> = async (app, { db, store }) => {
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
      tags: ['registers'], summary: 'Переименовать реестр, описание, владелец, настройки сравнения', params: IdParams,
      body: Version.extend({
        name: Label.optional(), description: z.string().trim().max(500).optional(), ownerUserId: z.string().uuid().nullable().optional(),
        compareKeyFieldIds: z.array(z.string().uuid()).max(3).optional(),
        compareScopeFieldIds: z.array(z.string().uuid()).max(5).optional(),
      }),
      response: { 200: RegisterDetail, ...errors },
    },
  }, async (request) => asDetail(await structure.updateRegister(db, actorOf(request), request.params.id, request.body)));

  for (const [path, archived, summary] of [['archive', true, 'В архив'], ['restore', false, 'Вернуть из архива']] as const) {
    app.post(`/registers/:id/${path}`, {
      preHandler: manage,
      schema: { tags: ['registers'], summary, params: IdParams, body: Version, response: { 200: RegisterDetail, ...errors } },
    }, async (request) => asDetail(await structure.setRegisterArchived(db, actorOf(request), request.params.id, request.body.version, archived)));
  }

  // ------------------------------------------------------------ удаление реестра (1.6.1, ADR-0033)
  const dataDelete = requirePerm('data.delete');
  app.post('/registers/:id/delete/preview', {
    preHandler: dataDelete,
    schema: {
      tags: ['registers'], summary: 'Удалить реестр: что скроется; системный или со ссылками из полей-связей — blocked', params: IdParams,
      response: {
        200: z.object({
          name: z.string(), system: z.boolean(),
          linkedBy: z.array(z.object({ registerId: z.string(), register: z.string(), field: z.string() })),
          counts: z.object({ records: z.number().int(), automations: z.number().int() }),
          blocked: z.boolean(),
        }),
        ...errors,
      },
    },
  }, async (request) => structure.previewRegisterDelete(db, request.params.id));

  app.post('/registers/:id/delete', {
    preHandler: dataDelete,
    schema: {
      tags: ['registers'], summary: 'Удалить реестр (мягко, в корзину): причина и ввод названия', params: IdParams,
      body: z.object({ reason: z.string().max(4000), confirmName: z.string().max(400) }),
      response: { 200: z.object({ deletionId: z.string(), counts: z.object({ records: z.number().int(), automations: z.number().int() }) }), ...errors },
    },
  }, async (request) => structure.deleteRegister(db, actorOf(request), request.params.id, request.body));

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
        calcRule: CalcRuleIn.optional(),
        /** Только для типа «Значение справочника» (catalog): код справочника, например systems. */
        catalogCode: z.string().max(64).optional(),
        /** Только для типа «Связь с записью» (link): реестр, на записи которого ссылается поле. */
        linkRegisterId: z.string().uuid().optional(),
        settings: FieldSettings.optional(),
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
        isImportKey: z.boolean().optional(),
        calcRule: CalcRuleIn.optional(),
        /** Фиксация при статусах и ограничения даты; null — снять. */
        settings: FieldSettings.nullable().optional(),
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
        ...RecordFilterQuery.shape,
        q: z.string().max(200).optional(),
        /** number, deadline (контроль сроков: просрочено → скоро → в срок → закрыто) или id поля. */
        sort: z.string().max(64).optional(),
        dir: z.enum(['asc', 'desc']).optional(),
        includeArchived: z.enum(['true', 'false']).optional(),
        /** only — только архивные записи (кнопка «Архив», релиз 1.1.0). */
        archived: z.enum(['only']).optional(),
        withTasks: z.enum(['true', 'false']).optional(),
      }),
      response: { 200: z.object({ items: z.array(RegisterRecord), nextCursor: z.string().nullable(), total: z.number().int() }), ...errors },
    },
  }, async (request) => {
    const { state, deadline, f, date, from, to, archived, ...rest } = request.query;
    const filter = parseRecordFilter(await loadRegister(db, request.params.id), { state, deadline, f, date, from, to });
    const page = await records.listRecords(db, request.params.id, {
      ...rest, includeArchived: rest.includeArchived === 'true', archivedOnly: archived === 'only', withTasks: rest.withTasks === 'true', filter,
    });
    return { ...page, items: page.items.map(asRecord) };
  });

  app.get('/register-records/:id', {
    preHandler: view,
    schema: { tags: ['register-records'], summary: 'Запись', params: IdParams, response: { 200: RegisterRecord, ...errors } },
  }, async (request) => asRecord(await records.getRecord(db, request.params.id)));

  // История — по праву «История в карточках» (релиз 1.2.0, ADR-0021).
  app.get('/register-records/:id/history', {
    preHandler: requirePerm('history.view'),
    schema: { tags: ['register-records'], summary: 'История изменений записи', params: IdParams, response: { 200: z.object({ items: z.array(HistoryEntry) }), ...errors } },
  }, async (request) => ({ items: await records.recordHistory(db, request.params.id) }));

  // Длина — до лимита многострочного поля; лимит конкретного поля проверяет normalizeInput.
  const Values = z.record(z.string().uuid(), z.union([z.string().max(TEXT_MAX_MULTILINE), z.number(), z.array(z.string().uuid()).max(200), z.null()]));

  app.post('/registers/:id/records', {
    preHandler: edit,
    schema: { tags: ['register-records'], summary: 'Создать запись', params: IdParams, body: z.object({ values: Values }), response: { 201: RegisterRecord, ...errors } },
  }, async (request, reply) => {
    // Записи уязвимостей появляются из сканов и переносом из «Без группы» (ADR-0029): без узла запись потеряется.
    if (isVulnRegister(await loadRegister(db, request.params.id))) throw conflict('VULN_CREATE_IN_NODE', 'Записи реестра уязвимостей появляются из сканов: загрузите скан в разделе «Уязвимости»');
    return reply.status(201).send(asRecord(await records.createRecord(db, actorOf(request), request.params.id, request.body)));
  });

  app.patch('/register-records/:id', {
    preHandler: edit,
    schema: {
      tags: ['register-records'],
      summary: 'Изменить запись (только переданные поля; null — очистить). Зафиксированное статусом поле — 422; поле «с причиной» — с reason',
      params: IdParams,
      body: Version.extend({ values: Values, reason: z.string().max(records.REASON_MAX).nullable().optional() }), response: { 200: RegisterRecord, ...errors },
    },
  }, async (request) => asRecord(await records.updateRecord(db, actorOf(request), request.params.id, request.body)));

  app.post('/register-records/:id/files', {
    preHandler: edit,
    schema: {
      tags: ['register-records'],
      summary: 'Приложить файлы к полю «Файл» (сначала POST /files). Зафиксированное поле с файлом — 422',
      params: IdParams,
      body: Version.extend({ fieldId: z.string().uuid(), fileIds: z.array(z.string().uuid()).min(1).max(recordFiles.FILES_PER_FIELD_MAX) }),
      response: { 200: RegisterRecord, ...errors },
    },
  }, async (request) => asRecord(await recordFiles.attachFiles(db, actorOf(request), request.params.id, request.body)));

  app.post('/register-records/:id/files/:linkId/remove', {
    preHandler: edit,
    schema: {
      tags: ['register-records'], summary: 'Отвязать файл (мягко, с записью в историю). Зафиксированное поле — 422',
      params: IdParams.extend({ linkId: z.string().uuid() }), body: Version, response: { 200: RegisterRecord, ...errors },
    },
  }, async (request) => asRecord(await recordFiles.detachFile(db, actorOf(request), request.params.id, request.params.linkId, request.body.version)));

  app.get('/register-records/:id/backlinks', {
    preHandler: view,
    schema: {
      tags: ['register-records'], summary: 'Обратные связи: записи других реестров, которые ссылаются на эту', params: IdParams,
      response: {
        200: z.object({
          items: z.array(z.object({
            registerId: z.string(), registerName: z.string(), fieldId: z.string(), fieldLabel: z.string(),
            items: z.array(z.object({
              id: z.string(), number: z.number().int(), title: z.string(), status: z.string(), closed: z.boolean(), archived: z.boolean(),
              deadline: z.object({ date: z.string().nullable(), daysLeft: z.number().int().nullable(), state: z.enum(['overdue', 'soon', 'ok', 'closed', 'none']) }).nullable(),
            })),
          })),
        }),
        ...errors,
      },
    },
  }, async (request) => ({ items: await records.recordBacklinks(db, request.params.id) }));

  app.post('/register-records/:id/auto/:fieldId', {
    preHandler: edit,
    schema: {
      tags: ['register-records'], summary: 'Считать поле автоматически (снять ручную правку критичности)',
      params: IdParams.extend({ fieldId: z.string().uuid() }), body: Version, response: { 200: RegisterRecord, ...errors },
    },
  }, async (request) => asRecord(await records.resetToAuto(db, actorOf(request), request.params.id, request.params.fieldId, request.body.version)));

  for (const [path, archived, summary] of [['archive', true, 'В архив'], ['restore', false, 'Вернуть из архива']] as const) {
    app.post(`/register-records/:id/${path}`, {
      preHandler: edit,
      schema: { tags: ['register-records'], summary, params: IdParams, body: Version, response: { 200: RegisterRecord, ...errors } },
    }, async (request) => asRecord(await records.setRecordArchived(db, actorOf(request), request.params.id, request.body.version, archived)));
  }

  app.post('/register-records/:id/decisions', {
    preHandler: edit,
    schema: {
      tags: ['register-records'],
      summary: 'Внести решение другого отдела: только с файлом документа-основания (POST /files), номером и датой документа',
      params: IdParams,
      body: z.object({
        recordVersion: z.number().int().positive(),
        fieldId: z.string().uuid(),
        optionId: z.string().uuid(),
        documentTitle: z.string().max(decisions.DOC_TITLE_MAX),
        documentNumber: z.string().max(decisions.DOC_NUMBER_MAX),
        documentDate: DateIso,
        fileId: z.string().uuid(),
        reviewDue: DateIso.nullable().optional(),
        externalRef: z.string().max(decisions.REF_MAX).nullable().optional(),
      }),
      response: { 200: RegisterRecord, ...errors },
    },
  }, async (request) => asRecord(await decisions.addDecision(db, actorOf(request), request.params.id, request.body)));

  app.get('/register-records/:id/decisions', {
    preHandler: view,
    schema: {
      tags: ['register-records'], summary: 'История решений другого отдела по записи (только пополняется)',
      params: IdParams, querystring: z.object({ fieldId: z.string().uuid().optional() }),
      response: {
        200: z.object({
          items: z.array(z.object({
            id: z.string(), fieldId: z.string(), optionId: z.string(), label: z.string(),
            documentTitle: z.string(), documentNumber: z.string(), documentDate: z.string(), reviewDue: z.string().nullable(),
            decidedAt: z.string(), decidedBy: z.string(),
            file: z.object({ id: z.string(), name: z.string(), mime: z.string(), sha256: z.string(), size: z.number().int() }),
            evidence: z.object({ id: z.string(), number: z.number().int() }).nullable(),
          })),
        }),
        ...errors,
      },
    },
  }, async (request) => ({ items: await decisions.listDecisions(db, request.params.id, request.query.fieldId) }));

  app.post('/register-records/:id/delete', {
    preHandler: recordDelete,
    schema: {
      tags: ['register-records'], summary: 'Удалить запись (мягко, в корзину, с причиной). Уязвимости — право data.delete', params: IdParams,
      body: Version.merge(RecordReason), response: { 204: z.null(), ...errors },
    },
  }, async (request, reply) => {
    assertCanDeleteRecords(request, await records.registerOfRecord(db, request.params.id));
    const { version, ...reason } = request.body;
    await records.deleteRecord(db, actorOf(request), request.params.id, version, reason);
    return reply.status(204).send(null);
  });

  // ------------------------------------------------------------ массовые действия (релиз 1.1.0, ADR-0016)
  // Два шага: preview → apply с числами предпросмотра в expected (разошлись — 409 BULK_CHANGED).
  // Право — на маршруте: архив и возврат — records.edit, удаление — records.delete.
  const BulkSelection = z.union([
    z.object({ ids: z.array(z.string().uuid()).min(1).max(bulk.BULK_MAX_IDS) }),
    z.object({
      /** Те же условия, что у списка записей: «выбрать все N по фильтру». */
      filter: RecordFilterQuery.extend({
        q: z.string().max(200).optional(),
        includeArchived: z.boolean().optional(),
        archived: z.enum(['only']).optional(),
        withTasks: z.boolean().optional(),
      }),
      excludeIds: z.array(z.string().uuid()).max(bulk.BULK_MAX_IDS).optional(),
    }),
  ]);
  const Expected = z.object({ total: z.number().int(), willDelete: z.number().int(), willArchive: z.number().int(), willRestore: z.number().int() });
  const Reasons = z.object({ locked: z.number().int(), decisions: z.number().int(), evidence: z.number().int(), tasks: z.number().int(), links: z.number().int() });
  const BulkPreview = Expected.extend({ alreadyInState: z.number().int(), byReason: Reasons });
  const BulkResult = z.object({ deleted: z.number().int(), archived: z.number().int(), restored: z.number().int(), skipped: z.number().int(), byReason: Reasons });

  const toSelection = async (registerId: string, sel: z.infer<typeof BulkSelection>): Promise<bulk.BulkSelection> => {
    if ('ids' in sel) return { ids: sel.ids };
    const { q, includeArchived, archived, withTasks, ...params } = sel.filter;
    const filter = parseRecordFilter(await loadRegister(db, registerId), params as RecordFilterParams);
    return { query: { q, includeArchived, archivedOnly: archived === 'only', withTasks, filter }, excludeIds: sel.excludeIds };
  };

  app.post('/registers/:id/records/bulk-archive/preview', {
    preHandler: edit,
    schema: {
      tags: ['register-records'], summary: 'Массово в архив или из архива: предпросмотр', params: IdParams,
      body: z.object({ action: z.enum(['archive', 'restore']), selection: BulkSelection }),
      response: { 200: BulkPreview, ...errors },
    },
  }, async (request) => bulk.previewBulk(db, request.params.id, request.body.action, await toSelection(request.params.id, request.body.selection)));

  app.post('/registers/:id/records/bulk-archive/apply', {
    preHandler: edit,
    schema: {
      tags: ['register-records'], summary: 'Массово в архив или из архива: применить (пакетами, с журналом)', params: IdParams,
      body: z.object({ action: z.enum(['archive', 'restore']), selection: BulkSelection, expected: Expected }),
      response: { 200: BulkResult, ...errors },
    },
  }, async (request) => bulk.applyBulk(db, actorOf(request), request.params.id, request.body.action,
    await toSelection(request.params.id, request.body.selection), request.body.expected,
    request.body.action === 'archive' ? 'массовая отправка в архив' : 'массовый возврат из архива'));

  app.post('/registers/:id/records/bulk-delete/preview', {
    preHandler: recordDelete,
    schema: {
      tags: ['register-records'], summary: 'Удалить выбранные: предпросмотр (записи с зависимостями уйдут в архив)', params: IdParams,
      body: z.object({ selection: BulkSelection }),
      response: { 200: BulkPreview, ...errors },
    },
  }, async (request) => {
    assertCanDeleteRecords(request, await loadRegister(db, request.params.id));
    return bulk.previewBulk(db, request.params.id, 'delete', await toSelection(request.params.id, request.body.selection));
  });

  app.post('/registers/:id/records/bulk-delete/apply', {
    preHandler: recordDelete,
    schema: {
      tags: ['register-records'], summary: 'Удалить выбранные: применить (мягко, в корзину одним событием, с одной причиной)', params: IdParams,
      body: z.object({ selection: BulkSelection, expected: Expected }).merge(RecordReason),
      response: { 200: BulkResult, ...errors },
    },
  }, async (request) => {
    assertCanDeleteRecords(request, await loadRegister(db, request.params.id));
    const { selection, expected, ...reason } = request.body;
    return bulk.applyBulk(db, actorOf(request), request.params.id, 'delete', await toSelection(request.params.id, selection), expected, 'массовое удаление', reason);
  });

  app.post('/registers/:id/records/delete-all/preview', {
    preHandler: recordDelete,
    schema: {
      tags: ['register-records'], summary: 'Удалить все записи реестра (включая архивные): предпросмотр', params: IdParams,
      response: { 200: BulkPreview, ...errors },
    },
  }, async (request) => {
    assertCanDeleteRecords(request, await loadRegister(db, request.params.id));
    return bulk.previewBulk(db, request.params.id, 'delete', { all: true });
  });

  app.post('/registers/:id/records/delete-all/apply', {
    preHandler: recordDelete,
    schema: {
      tags: ['register-records'], summary: 'Удалить все записи реестра: применить; confirmName — название реестра, причина', params: IdParams,
      body: z.object({ confirmName: z.string().max(300), expected: Expected }).merge(RecordReason),
      response: { 200: BulkResult, ...errors },
    },
  }, async (request) => {
    assertCanDeleteRecords(request, await loadRegister(db, request.params.id));
    const { confirmName, expected, ...reason } = request.body;
    return bulk.deleteAllRecords(db, actorOf(request), request.params.id, confirmName, expected, reason);
  });

  // ------------------------------------------------------------ сравнение с реестром (релиз 1.1.0, ADR-0017)
  const ScopeOut = z.union([
    z.object({ all: z.literal(true), label: z.string() }),
    z.object({
      label: z.string(),
      conditions: z.array(z.object({ fieldId: z.string(), label: z.string(), values: z.array(z.object({ id: z.string(), label: z.string() })) })),
    }),
  ]);
  const CompareResult = z.object({
    importId: z.string(),
    file: z.object({ id: z.string(), name: z.string(), sha256: z.string() }),
    key: z.array(z.object({ id: z.string(), label: z.string() })),
    scope: ScopeOut,
    missing: z.array(z.object({ id: z.string(), number: z.number().int(), title: z.string(), key: z.string(), statusId: z.string().nullable() })),
    noKey: z.number().int(), outOfScopeRows: z.number().int(), badKeyRows: z.number().int(),
    status: z.object({ fieldId: z.string(), options: z.array(z.object({ id: z.string(), label: z.string(), isClosed: z.boolean() })) }).nullable(),
  });
  const Condition = z.object({ fieldId: z.string().uuid(), values: z.array(z.string().uuid()).min(1).max(200) });
  /** Весь реестр, условия по полям (все выполняются — этап Б.2) или одно условие (вид задачи 4). */
  const ScopeIn = z.union([
    z.object({ all: z.literal(true) }),
    z.object({ conditions: z.array(Condition).min(1).max(5) }),
    Condition,
  ]);
  const StatusChanges = z.array(z.object({ recordId: z.string().uuid(), optionId: z.string().uuid() })).min(1).max(bulk.BULK_MAX_IDS);
  const StatusPreview = z.object({
    total: z.number().int(), willChange: z.number().int(),
    skipped: z.array(z.object({ number: z.number().int().nullable(), reason: z.string() })),
  });
  const scopeOf = (q: { scope?: string; scopeField?: string; scopeValues?: string; conditions?: string }): compare.CompareScope => {
    if (q.scope === 'all') return { all: true };
    if (q.conditions) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(q.conditions);
      } catch {
        throw badRequest('BAD_SCOPE', 'Область сравнения задана неверно');
      }
      const r = z.array(Condition).min(1).max(5).safeParse(parsed);
      if (!r.success) throw badRequest('BAD_SCOPE', 'Область сравнения задана неверно');
      return { conditions: r.data };
    }
    const values = (q.scopeValues ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (!q.scopeField || !values.length) throw badRequest('BAD_SCOPE', 'Выберите область сравнения: значения поля или «Весь реестр»');
    return { fieldId: q.scopeField, values };
  };
  const sameRegister = async (registerId: string, importId: string) => {
    const imp = await db.registerImport.findUnique({ where: { id: importId }, select: { registerId: true } });
    if (!imp || imp.registerId !== registerId) throw badRequest('BAD_IMPORT', 'Импорт относится к другому реестру');
  };

  app.post('/register-imports/:id/compare', {
    preHandler: edit,
    bodyLimit: IMPORT_BODY_LIMIT,
    schema: {
      tags: ['register-excel'],
      summary: 'Сравнение с реестром: открытые записи области, которых нет в файле (тот же файл, что в предпросмотре импорта). Записи не меняются',
      params: IdParams,
      querystring: z.object({
        scope: z.enum(['all']).optional(), scopeField: z.string().uuid().optional(), scopeValues: z.string().max(8000).optional(),
        /** Условия области JSON: [{ fieldId, values }] — все выполняются (этап Б.2). */
        conditions: z.string().max(20000).optional(),
      }),
      body: z.any(),
      response: { 200: CompareResult, ...errors },
    },
  }, async (request) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw badRequest('BAD_FILE', 'Отправьте файл .xlsx');
    return compare.compareWithRegister(db, store, actorOf(request), request.params.id, request.body, scopeOf(request.query));
  });

  app.post('/registers/:id/records/compare-status/preview', {
    preHandler: edit,
    schema: {
      tags: ['register-records'], summary: 'Статус записям, которых нет в файле: предпросмотр', params: IdParams,
      body: z.object({ importId: z.string().uuid(), scope: ScopeIn, changes: StatusChanges, reason: z.string().max(1000).nullable().optional() }),
      response: { 200: StatusPreview, ...errors },
    },
  }, async (request) => {
    await sameRegister(request.params.id, request.body.importId);
    return compare.previewCompareStatus(db, store, request.body.importId, request.body.scope, request.body.changes, request.body.reason ?? null);
  });

  app.post('/registers/:id/records/compare-status/apply', {
    preHandler: edit,
    schema: {
      tags: ['register-records'], summary: 'Статус записям, которых нет в файле: применить (пакетами, с журналом и ссылкой на файл)', params: IdParams,
      body: z.object({
        importId: z.string().uuid(), scope: ScopeIn, changes: StatusChanges, reason: z.string().max(1000).nullable().optional(),
        expected: z.object({ willChange: z.number().int() }),
      }),
      response: { 200: z.object({ changed: z.number().int(), skipped: z.number().int() }), ...errors },
    },
  }, async (request) => {
    await sameRegister(request.params.id, request.body.importId);
    const b = request.body;
    return compare.applyCompareStatus(db, store, actorOf(request), b.importId, b.scope, b.changes, {
      expected: b.expected, reason: b.reason ?? null,
    });
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

  app.get('/registers/:id/export.zip', {
    preHandler: view,
    schema: {
      tags: ['register-excel'],
      summary: 'Выгрузка для проверки: записи за период по полю-дате (с архивными) в Excel и файлы полей «Файл» одним zip',
      params: IdParams,
      querystring: z.object({
        dateFieldId: z.string().uuid(),
        from: DateIso.optional(),
        to: DateIso.optional(),
        nameFieldId: z.string().uuid().optional(),
        linkFieldId: z.string().uuid().optional(),
      }),
    },
  }, async (request, reply) => {
    const { fileName, archive } = await exportZip(db, store, actorOf(request), request.params.id, request.query);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header('Cache-Control', 'no-store')
      .send(archive);
  });

  app.post('/registers/:id/imports', {
    preHandler: edit,
    bodyLimit: IMPORT_BODY_LIMIT,
    schema: {
      tags: ['register-excel'],
      summary: 'Импорт, шаг 1: предпросмотр. Тело — файл .xlsx (Content-Type xlsx), имя файла — в X-File-Name. '
        + 'adapter — разбор чужого файла (1.6.0): services — реестр сервисов в «Компоненты», ksc — отчёт Kaspersky Security Center в «Хосты»',
      params: IdParams,
      querystring: z.object({ adapter: z.enum(['services', 'ksc']).optional() }),
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
    const adapter = request.query.adapter ? await assetImportAdapter(db, request.params.id, request.query.adapter, request.body) : undefined;
    const preview = await excel.previewImport(db, actorOf(request), request.params.id, request.body, fileName, adapter);
    return reply.status(201).send(preview);
  });

  app.get('/register-imports/:id', {
    preHandler: edit,
    schema: { tags: ['register-excel'], summary: 'Предпросмотр импорта', params: IdParams, response: { 200: ImportPreview.extend({ registerId: z.string() }), ...errors } },
  }, async (request) => excel.getImport(db, request.params.id));

  app.post('/register-imports/:id/apply', {
    preHandler: edit,
    schema: {
      tags: ['register-excel'], summary: 'Импорт, шаг 2: применить одной транзакцией. skip — снятые блоки адаптера (не создавать)', params: IdParams,
      body: z.object({ skip: z.array(z.string().max(50)).max(10).optional() }).nullish(),
      response: { 200: z.object({ added: z.number().int(), updated: z.number().int(), skipped: z.number().int() }), ...errors },
    },
  }, async (request) => excel.applyImport(db, actorOf(request), request.params.id, { skip: request.body?.skip }));

  app.post('/register-imports/:id/cancel', {
    preHandler: edit,
    schema: { tags: ['register-excel'], summary: 'Отменить импорт', params: IdParams, response: { 204: z.null(), ...errors } },
  }, async (request, reply) => {
    await excel.cancelImport(db, actorOf(request), request.params.id);
    return reply.status(204).send(null);
  });
};
