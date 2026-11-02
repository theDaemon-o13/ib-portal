// Раздел «Уязвимости» (релиз 1.5.0, ADR-0029, ADR-0030): группы, узлы, сканы, сроки.
// Просмотр — ib.work; структура (группы, типы) — registers.manage; записи, импорт, передача ИКТ — records.edit.
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import type { FileStore } from '../../lib/file-store.js';
import { badRequest } from '../../lib/errors.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { runAutomations } from '../automations/service.js';
import { IMPORT_BODY_LIMIT, RegisterRecord } from '../registers/routes.js';
import { actorOf } from '../settings/common.js';
import * as extensions from './extensions.service.js';
import * as groups from './groups.service.js';
import * as profiles from './profiles.js';
import * as scanImport from './scan-import.service.js';
import * as scans from './scans.service.js';
import * as section from './section.service.js';
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
const ProfileType = z.object({ id: z.string(), label: z.string() });
const ScanIssue = z.object({ sheet: z.string().optional(), row: z.number().int(), field: z.string().nullable(), message: z.string() });
const ScanSummary = z.object({
  node: z.object({ id: z.string().nullable(), label: z.string() }),
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
  profile: z.object({ detected: ProfileType.nullable(), nodeType: ProfileType.nullable(), mismatch: z.boolean() }).nullable(),
});
const NodeScanPreview = z.object({ id: z.string(), status: z.string(), expiresAt: z.string(), summary: ScanSummary });

const Handover = z.object({ date: z.string(), to: z.string(), fileId: z.string().nullable(), by: z.string(), at: z.string() });
const ScanBrief = z.object({
  id: z.string(), nodeId: z.string(), scanDate: z.string(), fileName: z.string(), fileId: z.string().nullable(), coverageTitle: z.string(),
  hostsCount: z.number().int(), findingsCount: z.number().int(),
  counts: z.object({ new: z.number().int(), reopened: z.number().int(), changed: z.number().int(), unchanged: z.number().int(), gone: z.number().int() }).nullable(),
  critCounts: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int() })),
  legacy: z.boolean(), createdBy: z.string(), createdAt: z.string(), handover: Handover.nullable(),
});
const ScanDetail = ScanBrief.extend({
  node: z.object({ id: z.string(), label: z.string() }),
  previousScan: z.object({ id: z.string(), scanDate: z.string(), fileName: z.string() }).nullable(),
  legacyArchived: z.boolean(),
  hosts: z.array(z.object({ name: z.string(), ip: z.string(), os: z.string(), status: z.enum(['new', 'same', 'gone']) })),
  findings: z.array(z.record(z.string(), z.unknown())),
  comparison: z.object({
    groups: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
    archived: z.array(z.record(z.string(), z.unknown())),
    inFileDuplicates: z.number().int(), errorRows: z.number().int(),
    errors: z.array(z.record(z.string(), z.unknown())), notes: z.array(z.record(z.string(), z.unknown())),
    profileMismatch: z.object({ fileProfile: ProfileType.nullable(), nodeType: ProfileType.nullable(), confirmedBy: z.string(), confirmedAt: z.string() }).nullable(),
  }).nullable(),
});
const NodeStats = z.object({
  nodeId: z.string(), open: z.number().int(), overdue: z.number().int(), critical: z.number().int(), notHandedOver: z.number().int(),
  fixed: z.number().int(), total: z.number().int(),
  lastScan: z.object({ id: z.string(), scanDate: z.string(), handedOver: z.boolean() }).nullable(),
  scans: z.array(z.object({ id: z.string(), scanDate: z.string(), fileName: z.string(), handedOver: z.boolean() })),
  scanAgeDays: z.number().int().nullable(),
  scanStale: z.boolean(),
});
const ExtensionPlan = z.object({
  nodeId: z.string().uuid().nullable().optional(),
  groupId: z.string().uuid().nullable().optional(),
  daysByLevel: z.record(z.string().max(40), z.number().int().min(0).max(365)),
  onlyOverdue: z.boolean().optional(),
  dueUntil: IsoDate.nullable().optional(),
});
const Extension = z.object({
  id: z.string(), scope: z.string(), nodeId: z.string().nullable(), groupId: z.string().nullable(),
  days: z.array(z.object({ level: z.string(), days: z.number().int() })),
  onlyOverdue: z.boolean(), dueUntil: z.string().nullable(), basisNumber: z.string(), basisDate: z.string(),
  basisFile: z.object({ id: z.string(), name: z.string() }), comment: z.string(), recordsCount: z.number().int(),
  createdBy: z.string(), createdAt: z.string(), cancelledAt: z.string().nullable(), cancelledBy: z.string().nullable(),
});
const STATES = ['overdue', 'not_handed', 'in_work', 'fixed', 'accepted'] as const;
const NodeRecords = z.object({
  items: z.array(RegisterRecord.extend({ vuln: z.object({ state: z.enum(STATES), reopened: z.boolean(), cycle: z.number().int() }) })),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
  stateCounts: z.object({ overdue: z.number().int(), not_handed: z.number().int(), in_work: z.number().int(), fixed: z.number().int(), accepted: z.number().int() }),
});

const view = requirePerm('ib.work');
const structure = requirePerm('registers.manage');
const edit = requirePerm('records.edit');
const deadlines = requirePerm('vulns.deadlines');

export const vulnSectionRoutes: FastifyPluginAsyncZod<{ db: Db; store: FileStore }> = async (app, { db, store }) => {
  /** Срок изменился: просрочка и напоминания видны сразу, не ждать часового прогона. Сбой правил не отменяет действие. */
  const afterDeadlineChange = async (registerId: string, request: FastifyRequest) => {
    try {
      await runAutomations(db, { registerId, trigger: 'import', actorId: request.user?.id ?? null });
    } catch (err) {
      request.log.error({ err }, 'автоматизации после изменения срока не выполнены');
    }
  };

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

  app.patch('/vulns/nodes/:id/type', {
    preHandler: structure,
    schema: {
      tags: ['vulns'], summary: '«Сменить тип узла»: только на тип, которого нет в группе. Реестр, сканы и продления остаются у узла',
      params: IdParams, body: z.object({ systemTypeId: z.string().uuid(), fromTypeId: z.string().uuid() }), response: { 200: VulnGroup, ...errors },
    },
  }, async (request) => groups.changeNodeType(db, actorOf(request), request.params.id, request.body));

  app.get('/vulns/nodes/:id/history', {
    preHandler: requirePerm('history.view'),
    schema: {
      tags: ['vulns'], summary: 'История узла: смена типа', params: IdParams,
      response: { 200: z.object({ items: z.array(z.object({ id: z.string(), at: z.string(), actor: z.string(), summary: z.string() })) }), ...errors },
    },
  }, async (request) => ({ items: await groups.nodeHistory(db, request.params.id) }));

  app.post('/vulns/groups/:id/scan-imports', {
    preHandler: [edit, structure],
    bodyLimit: IMPORT_BODY_LIMIT,
    schema: {
      tags: ['vulns'],
      summary: 'Импорт с группы в тип, которого в группе нет, шаг 1: сравнение с пустым реестром. Узел не создаётся, пока импорт не применён',
      params: IdParams, querystring: z.object({ systemTypeId: z.string().uuid() }), body: z.any(), response: { 201: NodeScanPreview, ...errors },
    },
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw badRequest('BAD_FILE', 'Отправьте файл .xlsx');
    const fileName = fileNameOf(request.headers['x-file-name'], 'scan.xlsx');
    return reply.status(201).send(await scanImport.previewNewNodeScan(db, store, actorOf(request), request.params.id, request.query.systemTypeId, request.body, fileName));
  });

  app.get('/vulns/groups/:id/scan-target', {
    preHandler: edit,
    schema: {
      tags: ['vulns'], summary: 'Импорт скана с группы: профиль по имени файла и его узел в группе. Не нашли или неоднозначно — detected: null',
      params: IdParams, querystring: z.object({ fileName: z.string().min(1).max(400) }),
      response: { 200: z.object({ detected: ProfileType.nullable(), nodeId: z.string().nullable() }), ...errors },
    },
  }, async (request) => profiles.groupScanTarget(db, request.params.id, request.query.fileName));

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
        profileConfirmed: z.boolean().optional(),
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
    const result = await scanImport.applyNodeScan(db, actorOf(request), request.params.id, { ...request.body, canAddNode: request.user?.permissions.has('registers.manage') ?? false });
    // Изменившаяся Критичность может сразу дать просрочку — не ждать часового прогона.
    const imp = await scanImport.getNodeScanImport(db, request.params.id);
    try {
      await runAutomations(db, { registerId: imp.registerId, trigger: 'import', actorId: request.user?.id ?? null });
    } catch (err) {
      request.log.error({ err }, 'автоматизации после импорта скана не выполнены');
    }
    return result;
  });

  app.get('/vulns/overview', {
    preHandler: view,
    schema: {
      tags: ['vulns'], summary: 'Счётчики раздела: по узлам (открыто, просрочено, критических, не передано ИКТ), сканы узлов, сканы, ждущие передачи',
      response: {
        200: z.object({
          registerId: z.string(),
          nodes: z.array(NodeStats),
          scanMaxAgeDays: z.number().int(),
          staleNodes: z.array(z.object({ nodeId: z.string(), label: z.string(), lastScanDate: z.string().nullable(), ageDays: z.number().int().nullable() })),
          awaiting: z.array(z.object({ id: z.string(), nodeId: z.string(), nodeLabel: z.string(), scanDate: z.string(), fileName: z.string(), createdAt: z.string() })),
        }),
        ...errors,
      },
    },
  }, async () => section.overview(db));

  app.get('/vulns/nodes/:id/records', {
    preHandler: view,
    schema: {
      tags: ['vulns'],
      summary: 'Реестр узла: поиск, Критичность, статус (просрочена, не передано ИКТ, в работе, устранена, риск принят; open — все открытые). Сортировка: просроченные, не переданные, в работе, закрытые, внутри — Критичность и Оценка',
      params: IdParams,
      querystring: z.object({
        search: z.string().max(200).optional(), crit: z.string().uuid().optional(),
        state: z.enum([...STATES, 'open', 'all']).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().regex(/^\d+$/).optional(),
      }),
      response: { 200: NodeRecords, ...errors },
    },
  }, async (request) => (await section.nodeRecords(db, request.params.id, request.query)) as z.infer<typeof NodeRecords>);

  app.get('/vulns/records/:id', {
    preHandler: view,
    schema: {
      tags: ['vulns'], summary: 'Карточка записи: узел, база срока, продления, итог, в каких сканах встречалась',
      params: IdParams,
      response: { 200: section.RecordInfo, ...errors },
    },
  }, async (request) => section.recordInfo(db, request.params.id));

  app.get('/vulns/nodes/:id/scans', {
    preHandler: view,
    schema: { tags: ['vulns'], summary: 'Итоги сканирования узла: новые сверху', params: IdParams, response: { 200: z.object({ items: z.array(ScanBrief) }), ...errors } },
  }, async (request) => ({ items: await scans.listScans(db, request.params.id) }));

  app.get('/vulns/scans/:id', {
    preHandler: view,
    schema: { tags: ['vulns'], summary: 'Скан: факты, передача ИКТ, сравнение, снимок находок, охват', params: IdParams, response: { 200: ScanDetail, ...errors } },
  }, async (request) => scans.getScan(db, request.params.id));

  app.post('/vulns/scans/:id/handover', {
    preHandler: edit,
    schema: {
      tags: ['vulns'],
      summary: 'Передача ИКТ — один раз: дата от даты скана до сегодня, кому (по умолчанию «ОИКТ»), файл по желанию. От неё начинается срок записей скана',
      params: IdParams,
      body: z.object({ date: IsoDate, to: z.string().max(400).nullable().optional(), fileId: z.string().uuid().nullable().optional() }),
      response: { 200: z.object({ started: z.number().int(), keptLegacy: z.number().int() }), ...errors },
    },
  }, async (request) => {
    const { registerId, ...result } = await scans.handOverScan(db, actorOf(request), request.params.id, request.body);
    await afterDeadlineChange(registerId, request);
    return result;
  });

  app.get('/vulns/extensions', {
    preHandler: view,
    schema: {
      tags: ['vulns'], summary: 'Продления сроков узла (его и всей группы) или группы (её и её узлов)',
      querystring: z.object({ nodeId: z.string().uuid().optional(), groupId: z.string().uuid().optional() }),
      response: { 200: z.object({ items: z.array(Extension) }), ...errors },
    },
  }, async (request) => ({ items: await extensions.listExtensions(db, request.query) }));

  app.get('/vulns/extensions/:id', {
    preHandler: view,
    schema: {
      tags: ['vulns'], summary: 'Продление: кому, сколько, было → стало', params: IdParams,
      response: {
        200: Extension.extend({
          items: z.array(z.object({ recordId: z.string(), number: z.number().int(), pkg: z.string(), cve: z.string(), days: z.number().int(), dueBefore: z.string(), dueAfter: z.string() })),
        }),
        ...errors,
      },
    },
  }, async (request) => extensions.getExtension(db, request.params.id));

  app.post('/vulns/extensions/preview', {
    preHandler: deadlines,
    schema: {
      tags: ['vulns'], summary: '«Обновить сроки», предпросмотр: кандидаты области, не участвующие, уровни, «было → станет». Ничего не меняет',
      body: ExtensionPlan,
      response: {
        200: z.object({
          scopeLabel: z.string(),
          levels: z.array(z.object({ id: z.string(), label: z.string(), count: z.number().int() })),
          items: z.array(z.object({ recordId: z.string(), number: z.number().int(), pkg: z.string(), cve: z.string(), level: z.string(), crit: z.string(), days: z.number().int(), dueBefore: z.string(), dueAfter: z.string() })),
          withDecision: z.number().int(), notHandedOver: z.number().int(), filteredOut: z.number().int(), noChange: z.number().int(),
        }),
        ...errors,
      },
    },
  }, async (request) => extensions.previewExtension(db, request.body));

  app.post('/vulns/extensions', {
    preHandler: deadlines,
    schema: {
      tags: ['vulns'], summary: '«Обновить сроки», применить: обоснование ОИКТ обязательно, expected — число записей предпросмотра (иначе 409 BULK_CHANGED)',
      body: ExtensionPlan.extend({
        basisNumber: z.string().max(400), basisDate: IsoDate, basisFileId: z.string().uuid(), comment: z.string().max(4000).nullable().optional(), expected: z.number().int(),
      }),
      response: { 201: z.object({ id: z.string(), records: z.number().int() }), ...errors },
    },
  }, async (request, reply) => {
    const { registerId, ...result } = await extensions.applyExtension(db, actorOf(request), request.body);
    await afterDeadlineChange(registerId, request);
    return reply.status(201).send(result);
  });

  app.post('/vulns/extensions/:id/cancel', {
    preHandler: deadlines,
    schema: {
      tags: ['vulns'], summary: 'Отменить продление целиком: сроки возвращаются у записей в том же цикле, событие остаётся с отметкой',
      params: IdParams, response: { 200: z.object({ returned: z.number().int(), total: z.number().int() }), ...errors },
    },
  }, async (request) => {
    const { registerId, ...result } = await extensions.cancelExtension(db, actorOf(request), request.params.id);
    await afterDeadlineChange(registerId, request);
    return result;
  });
};
