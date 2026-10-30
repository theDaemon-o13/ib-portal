import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import type { FileStore } from '../../lib/file-store.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { importKeyField, loadRegister } from '../registers/definition.js';
import * as excel from '../registers/excel.service.js';
import { IMPORT_BODY_LIMIT, ImportPreview } from '../registers/routes.js';
import { actorOf } from '../settings/common.js';
import { isVulnRegister } from './definition.js';
import { detectFormat } from './import-detect.js';
import { fileNameOf } from './section.routes.js';
import * as scan from './scan-import.service.js';
import { vulnSectionRoutes } from './section.routes.js';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });

const Host = z.object({ name: z.string(), ip: z.string(), os: z.string() });
const ScanReport = z.object({
  id: z.string(), label: z.string(), fileName: z.string(), department: z.string(), reportDate: z.string(), notifiedDate: z.string(),
  rowsTotal: z.number().int(), createdCount: z.number().int(), mergedCount: z.number().int(), hostsCount: z.number().int(),
  createdBy: z.string(), createdAt: z.string(), archived: z.boolean(), hosts: z.array(Host),
});

const view = requirePerm('ib.work');

const edit = requirePerm('records.edit');

export const vulnRoutes: FastifyPluginAsyncZod<{ db: Db; store: FileStore }> = async (app, { db, store }) => {
  await app.register(vulnSectionRoutes, { db, store });

  app.post('/registers/:id/file-imports', {
    preHandler: edit,
    bodyLimit: IMPORT_BODY_LIMIT,
    schema: {
      tags: ['vulns'],
      summary: 'Импорт из Excel одной кнопкой: тип файла определяется сам: выгрузка реестра (колонка ID, лист «_поля») — предпросмотр; отчёт сканера (колонки «Пакет» и «CVE») — в реестре уязвимостей 409, его загружают в узел',
      params: IdParams, body: z.any(),
      response: {
        201: z.object({ format: z.literal('records'), records: ImportPreview }),
        ...errors,
      },
    },
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw badRequest('BAD_FILE', 'Отправьте файл .xlsx');
    const fileName = fileNameOf(request.headers['x-file-name'], 'import.xlsx');
    const reg = await loadRegister(db, request.params.id);
    const format = detectFormat(await excel.readWorkbook(request.body), importKeyField(reg)?.label);
    if (format === 'scan') {
      if (!isVulnRegister(reg)) {
        throw badRequest('NOT_VULN_REGISTER', 'Файл распознан как отчёт сканера — его загружают в «Реестр уязвимостей»');
      }
      // Отчёт сканера загружается только в узел (ADR-0029).
      throw conflict('VULN_IMPORT_IN_NODE', 'Отчёт сканера загружают в разделе «Уязвимости», из узла');
    }
    return reply.status(201).send({ format, records: await excel.previewImport(db, actorOf(request), request.params.id, request.body, fileName) });
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
