// Раздел «Уязвимости» (релиз 1.5.0, ADR-0029, ADR-0030): группы, узлы, сканы, сроки.
// Просмотр — ib.work; структура (группы, типы) — registers.manage; записи, импорт, передача ИКТ — records.edit.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import type { FileStore } from '../../lib/file-store.js';
import { badRequest } from '../../lib/errors.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { runAutomations } from '../automations/service.js';
import { IMPORT_BODY_LIMIT } from '../registers/routes.js';
import { actorOf } from '../settings/common.js';
import * as groups from './groups.service.js';
import * as scanImport from './scan-import.service.js';
import { SCAN_MAX_ROWS } from './scan-parser.js';
import * as transfer from './transfer.service.js';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

export function fileNameOf(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const Node = z.object({
  id: z.string(),
  groupId: z.string(),
  systemType: z.object({ id: z.string(), label: z.string(), archived: z.boolean() }).nullable(),
  label: z.string(),
  legacy: z.boolean(),
});
export const VulnGroup = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['service', 'department', 'temporary']),
  kindLabel: z.string(),
  system: z.boolean(),
  version: z.number().int(),
  nodes: z.array(Node),
});

const ScanItem = z.object({
  key: z.string(), sheet: z.string(), row: z.number().int(), recordId: z.string().nullable(), number: z.number().int().nullable(),
  pkg: z.string(), cve: z.string(), cvss: z.number().nullable(), score: z.number().nullable(), crit: z.string(),
  changes: z.array(z.object({ fieldId: z.string(), label: z.string(), from: z.string(), to: z.string() })),
  dueBefore: z.string().nullable(), dueAfter: z.string().nullable(), becomesOverdue: z.boolean(), closedStatus: z.string().nullable(),
});
const ScanIssue = z.object({ sheet: z.string().optional(), row: z.number().int(), field: z.string().nullable(), message: z.string() });
const ScanSummary = z.object({
  node: z.object({ id: z.string(), label: z.string() }),
  fileName: z.string(),
  sheets: z.array(z.object({ name: z.string(), rows: z.number().int() })),
  scanDate: z.string().nullable(),
  coverageTitle: z.string(),
  hostsCount: z.number().int(),
  hosts: z.array(z.object({ name: z.string(), ip: z.string(), os: z.string() })),
  rows: z.number().int(),
  inFileDuplicates: z.number().int(),
  errorRows: z.number().int(),
  errors: z.array(ScanIssue),
  notes: z.array(ScanIssue),
  warnings: z.array(z.string()),
  previousScan: z.object({ id: z.string(), scanDate: z.string(), fileName: z.string(), handedOver: z.boolean() }).nullable(),
  coverage: z.object({ newHosts: z.array(z.string()), goneHosts: z.array(z.string()) }),
  counts: z.object({ new: z.number().int(), reopened: z.number().int(), changed: z.number().int(), unchanged: z.number().int(), gone: z.number().int() }),
  critCounts: z.array(z.object({ key: z.enum(['critical', 'high', 'medium', 'low']), label: z.string(), count: z.number().int() })),
  newOptions: z.array(z.object({ field: z.string(), values: z.array(z.string()) })),
  groups: z.object({
    new: z.array(ScanItem), reopened: z.array(ScanItem), changed: z.array(ScanItem), unchanged: z.array(ScanItem),
    gone: z.array(z.object({ key: z.string(), recordId: z.string(), number: z.number().int(), pkg: z.string(), cve: z.string(), crit: z.string(), status: z.string(), due: z.string().nullable() })),
  }),
  archived: z.array(z.object({ number: z.number().int(), pkg: z.string(), cve: z.string() })),
  systemId: z.string().nullable(),
});
const NodeScanPreview = z.object({ id: z.string(), status: z.string(), expiresAt: z.string(), summary: ScanSummary });

const view = requirePerm('ib.work');
const structure = requirePerm('registers.manage');
const edit = requirePerm('records.edit');

export const vulnSectionRoutes: FastifyPluginAsyncZod<{ db: Db; store: FileStore }> = async (app, { db, store }) => {
  app.get('/vulns/groups', {
    preHandler: view,
    schema: { tags: ['vulns'], summary: 'Группы и узлы раздела «Уязвимости»: обычные по названию, «Без группы» — последней', response: { 200: z.object({ items: z.array(VulnGroup) }), ...errors } },
  }, async () => ({ items: await groups.listGroups(db) }));

  app.post('/vulns/groups', {
    preHandler: structure,
    schema: {
      tags: ['vulns'], summary: 'Создать группу: название (уникально без регистра), вид, хотя бы один тип систем',
      body: z.object({ name: z.string().max(400), kind: z.enum(groups.GROUP_KINDS), systemTypeIds: z.array(z.string().uuid()).min(1).max(50) }),
      response: { 201: VulnGroup, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await groups.createGroup(db, actorOf(request), request.body)));

  app.patch('/vulns/groups/:id', {
    preHandler: structure,
    schema: {
      tags: ['vulns'], summary: 'Переименовать группу (уникальность без регистра, журнал). «Без группы» не переименовывается',
      params: IdParams, body: z.object({ name: z.string().max(400), version: z.number().int() }), response: { 200: VulnGroup, ...errors },
    },
  }, async (request) => groups.renameGroup(db, actorOf(request), request.params.id, request.body));

  app.post('/vulns/groups/:id/nodes', {
    preHandler: structure,
    schema: {
      tags: ['vulns'], summary: '«Добавить тип»: новые узлы группы',
      params: IdParams, body: z.object({ systemTypeIds: z.array(z.string().uuid()).min(1).max(50) }), response: { 200: VulnGroup, ...errors },
    },
  }, async (request) => groups.addNodes(db, actorOf(request), request.params.id, request.body.systemTypeIds));

  app.post('/vulns/records/transfer', {
    preHandler: edit,
    schema: {
      tags: ['vulns'],
      summary: '«Перенести» и «Перенести выбранные» из «Без группы» в узел: ключ «Пакет + Идентификатор», который в узле уже есть, — отказ по строке',
      body: z.object({ recordIds: z.array(z.string().uuid()).min(1).max(transfer.TRANSFER_MAX), nodeId: z.string().uuid() }),
      response: {
        200: z.object({
          moved: z.array(z.object({ id: z.string(), number: z.number().int() })),
          rejected: z.array(z.object({ id: z.string(), number: z.number().int().nullable(), title: z.string(), reason: z.string() })),
        }),
        ...errors,
      },
    },
  }, async (request) => transfer.transferRecords(db, actorOf(request), request.body));

  app.post('/vulns/nodes/:id/scan-imports', {
    preHandler: edit,
    bodyLimit: IMPORT_BODY_LIMIT,
    schema: {
      tags: ['vulns'],
      summary: 'Импорт скана в узел, шаг 1: предпросмотр сравнения с реестром узла (пять групп, охват). Записи не меняются. Тело — файл .xlsx, имя — в X-File-Name',
      params: IdParams, body: z.any(), response: { 201: NodeScanPreview, ...errors },
    },
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw badRequest('BAD_FILE', 'Отправьте файл .xlsx');
    const fileName = fileNameOf(request.headers['x-file-name'], 'scan.xlsx');
    return reply.status(201).send(await scanImport.previewNodeScan(db, store, actorOf(request), request.params.id, request.body, fileName));
  });

  app.get('/vulns/scan-imports/:id', {
    preHandler: edit,
    schema: { tags: ['vulns'], summary: 'Предпросмотр импорта скана', params: IdParams, response: { 200: NodeScanPreview.extend({ registerId: z.string() }), ...errors } },
  }, async (request) => scanImport.getNodeScanImport(db, request.params.id));

  app.post('/vulns/scan-imports/:id/apply', {
    preHandler: edit,
    schema: {
      tags: ['vulns'],
      summary: 'Импорт скана, шаг 2: выбранное — одной транзакцией. Если записи узла или поля изменились после предпросмотра — ничего (409 IMPORT_STALE)',
      params: IdParams,
      body: z.object({
        scanDate: IsoDate.nullable().optional(),
        systemId: z.string().uuid().nullable().optional(),
        selected: z.object({
          new: z.array(z.string()).max(SCAN_MAX_ROWS).optional(), reopened: z.array(z.string()).max(SCAN_MAX_ROWS).optional(),
          changed: z.array(z.string()).max(SCAN_MAX_ROWS).optional(), gone: z.array(z.string()).max(SCAN_MAX_ROWS).optional(),
        }).optional(),
      }),
      response: {
        200: z.object({
          scanId: z.string(), created: z.number().int(), reopened: z.number().int(), changed: z.number().int(),
          unchanged: z.number().int(), gone: z.number().int(), skipped: z.number().int(),
        }),
        ...errors,
      },
    },
  }, async (request) => {
    const result = await scanImport.applyNodeScan(db, actorOf(request), request.params.id, request.body);
    // Изменившаяся Критичность может сразу дать просрочку — не ждать часового прогона.
    const imp = await scanImport.getNodeScanImport(db, request.params.id);
    try {
      await runAutomations(db, { registerId: imp.registerId, trigger: 'import', actorId: request.user?.id ?? null });
    } catch (err) {
      request.log.error({ err }, 'автоматизации после импорта скана не выполнены');
    }
    return result;
  });
};
