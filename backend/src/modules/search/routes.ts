import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAnyPerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { Q_MAX, Q_MIN, search, SEARCH_KINDS } from './service.js';

const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse };
const Hit = z.object({
  kind: z.enum(SEARCH_KINDS), id: z.string(), title: z.string(), context: z.string(),
  /** Фрагмент с совпадениями в [[ ]]. */
  snippet: z.string(), link: z.string(), archived: z.boolean(),
});
const Section = z.object({ items: z.array(Hit), total: z.number().int(), nextCursor: z.string().nullable() });

/** Кто может искать: те же, кто видит файлы (ib.work или права документов). Состав результатов — по правам. */
const searchers = requireAnyPerm(['ib.work', 'docs.manage', 'docs.approve.head', 'docs.approve.legal', 'docs.approve.board']);

export const searchRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/search', {
    preHandler: searchers,
    schema: {
      tags: ['search'],
      summary: 'Глобальный поиск: записи реестров, доказательства, файлы (имя и текст PDF). Без kind — первая страница каждого раздела',
      querystring: z.object({
        q: z.string().trim().min(Q_MIN).max(Q_MAX),
        kind: z.enum(SEARCH_KINDS).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(10),
        cursor: z.string().max(20).optional(),
      }),
      response: {
        200: z.object({
          q: z.string(), records: Section, files: Section, evidence: Section,
          noTextFiles: z.number().int(), pendingFiles: z.number().int(),
        }),
        ...errors,
      },
    },
  }, async (request) => search(db, actorOf(request).id, request.query));
};
