import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { MAX_FILE_BYTES } from '../../lib/file-type.js';
import type { FileStore } from '../../lib/file-store.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAnyPerm, requireAuth } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as svc from './service.js';

const tags = ['files'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 413: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });

export const FileOut = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  uploadedAt: z.string(),
  uploadedBy: z.object({ id: z.string(), fullName: z.string() }),
  deleted: z.boolean(),
});

// Загружают сотрудники ИБ (доказательства, решения) и участники документооборота (файлы версии, подписанный PDF).
// Читать файл может любой вошедший (и «Читатель документов» без прав, 1.2.0) — дальше решают ссылки на файл (сервис).
const uploaders = requireAnyPerm(['ib.work', 'docs.manage', 'docs.approve.head']);
const readers = requireAuth();

/** Имя для Content-Disposition: ASCII-запасное и полное в UTF-8 (RFC 6266 / 5987). */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export const fileRoutes: FastifyPluginAsyncZod<{ db: Db; store: FileStore }> = async (app, { db, store }) => {
  app.post('/files', {
    preHandler: uploaders,
    bodyLimit: MAX_FILE_BYTES,
    schema: {
      tags,
      summary: 'Загрузить файл: тело — содержимое (application/octet-stream), имя — заголовок X-File-Name (percent-encoded). '
        + 'До 25 МБ; pdf, png, jpg, txt, csv, xlsx, docx — тип проверяется по содержимому. Непривязанный файл через сутки помечается удалённым',
      headers: z.object({ 'x-file-name': z.string().min(1).max(1000) }).passthrough(),
      response: { 201: FileOut, ...errors },
    },
  }, async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body)) throw badRequest('BAD_BODY', 'Файл передаётся телом запроса (application/octet-stream)');
    let name: string;
    try {
      name = decodeURIComponent(request.headers['x-file-name'] as string);
    } catch {
      throw badRequest('BAD_FILE_NAME', 'Имя файла передано неверно');
    }
    return reply.status(201).send(await svc.uploadFile(db, store, actorOf(request), name, body));
  });

  app.get('/files/:id', {
    preHandler: readers,
    schema: {
      tags, summary: 'Метаданные файла и к чему он привязан (только если файл вам виден)', params: IdParams,
      response: {
        200: FileOut.extend({
          refs: z.array(z.object({ kind: z.enum(['evidence', 'decision', 'document_pdf', 'document_file', 'record', 'compare']), id: z.string(), label: z.string() })),
          /** Текст PDF для поиска (этап 8б); null — не PDF. */
          text: z.object({ status: z.enum(['pending', 'text', 'no_text', 'failed']), pages: z.number().int().nullable() }).nullable(),
        }),
        ...errors,
      },
    },
  }, async (request) => svc.getFileMeta(db, actorOf(request), request.params.id));

  app.get('/files/:id/content', {
    preHandler: readers,
    schema: { tags, summary: 'Содержимое файла: всегда attachment, nosniff, sandbox. Предпросмотр frontend строит из blob', params: IdParams },
  }, async (request, reply) => {
    const { file, stream } = await svc.openFile(db, store, actorOf(request), request.params.id);
    return reply
      .header('Content-Type', file.mime)
      .header('Content-Length', String(file.size))
      .header('Content-Disposition', disposition(file.name))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Cache-Control', 'private, no-store')
      .header('X-File-Sha256', file.sha256)
      .send(stream);
  });
};
