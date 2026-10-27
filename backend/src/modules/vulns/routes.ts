import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { runAutomations } from '../automations/service.js';
import { IMPORT_BODY_LIMIT } from '../registers/routes.js';
import { actorOf } from '../settings/common.js';
import * as scan from './scan-import.service.js';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

const Host = z.object({ name: z.string(), ip: z.string(), os: z.string() });
const ScanSummary = z.object({
  fileName: z.string(),
  sheet: z.string(),
  department: z.string(),
  reportDate: z.string().nullable(),
  rows: z.number().int(),
  created: z.number().int(),
  merged: z.number().int(),
  mergedChanged: z.number().int(),
  inFileDuplicates: z.number().int(),
  errorRows: z.number().int(),
  hostsCount: z.number().int(),
  hosts: z.array(Host),
  critCounts: z.array(z.object({ key: z.enum(['critical', 'high', 'medium', 'low']), label: z.string(), count: z.number().int() })),
  newOptions: z.array(z.object({ field: z.string(), values: z.array(z.string()) })),
  duplicates: z.array(z.object({
    row: z.number().int(), cve: z.string(), pkg: z.string(), recordId: z.string(), number: z.number().int(),
    hitsBefore: z.number().nullable(), hitsAfter: z.number().nullable(),
  })),
  items: z.array(z.object({
    row: z.number().int(), cve: z.string(), pkg: z.string(), cvss: z.number().nullable(), score: z.number().nullable(), crit: z.string(),
  })),
  errors: z.array(z.object({ row: z.number().int(), field: z.string().nullable(), message: z.string() })),
  warnings: z.array(z.string()),
});
const ScanPreview = z.object({ id: z.string(), status: z.string(), expiresAt: z.string(), summary: ScanSummary });
const ScanReport = z.object({
  id: z.string(), label: z.string(), fileName: z.string(), department: z.string(), reportDate: z.string(), notifiedDate: z.string(),
  rowsTotal: z.number().int(), createdCount: z.number().int(), mergedCount: z.number().int(), hostsCount: z.number().int(),
  createdBy: z.string(), createdAt: z.string(), archived: z.boolean(), hosts: z.array(Host),
});

const view = requirePerm('ib.work');
const edit = requirePerm('records.edit');

export const vulnRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.post('/registers/:id/scan-imports', {
    preHandler: edit,
    bodyLimit: IMPORT_BODY_LIMIT,
    schema: {
      tags: ['vulns'],
      summary: 'Отчёт сканера, шаг 1: предпросмотр (новые, дубли «CVE + пакет», хосты). Тело — файл .xlsx, имя — в X-File-Name',
      params: IdParams, body: z.any(), response: { 201: ScanPreview, ...errors },
    },
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) throw badRequest('BAD_FILE', 'Отправьте файл .xlsx');
    const raw = request.headers['x-file-name'];
    let fileName = 'scan.xlsx';
    if (typeof raw === 'string' && raw) {
      try {
        fileName = decodeURIComponent(raw);
      } catch {
        fileName = raw;
      }
    }
    return reply.status(201).send(await scan.previewScan(db, actorOf(request), request.params.id, request.body, fileName));
  });

  app.get('/scan-imports/:id', {
    preHandler: edit,
    schema: { tags: ['vulns'], summary: 'Предпросмотр отчёта сканера', params: IdParams, response: { 200: ScanPreview.extend({ registerId: z.string() }), ...errors } },
  }, async (request) => scan.getScanImport(db, request.params.id));

  app.post('/scan-imports/:id/apply', {
    preHandler: edit,
    schema: {
      tags: ['vulns'],
      summary: 'Отчёт сканера, шаг 2: применить одной транзакцией. Дата отчёта обязательна, если её нет в имени файла',
      params: IdParams,
      body: z.object({ reportDate: IsoDate.nullable().optional(), notifiedDate: IsoDate.nullable().optional() }),
      response: {
        200: z.object({
          reportId: z.string(), label: z.string(), created: z.number().int(), merged: z.number().int(), updated: z.number().int(), skipped: z.number().int(),
        }),
        ...errors,
      },
    },
  }, async (request) => {
    const result = await scan.applyScan(db, actorOf(request), request.params.id, request.body);
    // Новые записи сразу проверяются правилами (например, уже просроченные) — не ждать часового прогона.
    const imp = await scan.getScanImport(db, request.params.id);
    try {
      await runAutomations(db, { registerId: imp.registerId });
    } catch (err) {
      request.log.error({ err }, 'автоматизации после импорта отчёта не выполнены');
    }
    return result;
  });

  app.get('/registers/:id/scan-reports', {
    preHandler: view,
    schema: {
      tags: ['vulns'], summary: 'Загруженные отчёты сканера с хостами', params: IdParams,
      querystring: z.object({ includeArchived: z.enum(['true', 'false']).optional() }),
      response: { 200: z.object({ items: z.array(ScanReport) }), ...errors },
    },
  }, async (request) => ({ items: await scan.listScanReports(db, request.params.id, { includeArchived: request.query.includeArchived === 'true' }) }));

  for (const [path, archived, summary] of [['archive', true, 'Отчёт сканера в архив'], ['restore', false, 'Вернуть отчёт из архива']] as const) {
    app.post(`/scan-reports/:id/${path}`, {
      preHandler: edit,
      schema: { tags: ['vulns'], summary, params: IdParams, response: { 204: z.null(), ...errors } },
    }, async (request, reply) => {
      await scan.setScanReportArchived(db, actorOf(request), request.params.id, archived);
      return reply.status(204).send(null);
    });
  }
};
