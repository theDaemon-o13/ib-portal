// Журнал изменений настроек строится из audit_log (CLAUDE.md, раздел 3.5): кто, когда,
// с какими ролями и что поменял. Отдельной таблицы нет, записи не перезаписываются.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { PageQuery, pageSchema, toPage } from '../../lib/pagination.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { SETTINGS_ACTION_PREFIXES } from './common.js';

export const JournalEntry = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.object({ login: z.string(), fullName: z.string() }).nullable(),
  actorRoles: z.array(z.string()),
  action: z.string(),
  entity: z.string().nullable(),
  summary: z.string(),
});

/** Записи без готовой фразы (сделаны до этапа 2): понятная подпись вместо кода действия. */
function fallbackSummary(action: string, diff: Record<string, unknown>): string {
  const who = typeof diff.login === 'string' ? ` ${String(diff.fullName ?? '')} (${diff.login})`.replace('  ', ' ') : '';
  if (action === 'user.created') return `Пользователи: создан${who}${diff.via === 'create-admin' ? ' командой create-admin' : ''}`;
  return `Изменение настроек: ${action}`;
}

export async function listJournal(db: Db, q: { limit: number; cursor?: string }) {
  const before = q.cursor && /^\d+$/.test(q.cursor) ? BigInt(q.cursor) : undefined;
  const rows = await db.auditLog.findMany({
    where: {
      OR: SETTINGS_ACTION_PREFIXES.map((p) => ({ action: { startsWith: p } })),
      ...(before ? { id: { lt: before } } : {}),
    },
    include: { user: { select: { login: true, fullName: true } } },
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  });
  const page = toPage(rows, q.limit, (r) => r.id.toString());
  return {
    items: page.items.map((r) => {
      const diff = (r.diff ?? {}) as Record<string, unknown> & { summary?: unknown; actorRoles?: unknown };
      return {
        id: r.id.toString(),
        at: r.at.toISOString(),
        actor: r.user,
        actorRoles: Array.isArray(diff.actorRoles) ? diff.actorRoles.map(String) : [],
        action: r.action,
        entity: r.entity,
        summary: typeof diff.summary === 'string' ? diff.summary : fallbackSummary(r.action, diff),
      };
    }),
    nextCursor: page.nextCursor,
  };
}

export const journalRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/settings/journal', {
    preHandler: requirePerm('ib.work'),
    schema: {
      tags: ['settings'],
      summary: 'Журнал изменений настроек',
      querystring: PageQuery,
      response: { 200: pageSchema(JournalEntry), 401: ErrorResponse, 403: ErrorResponse },
    },
  }, async (request) => listJournal(db, request.query));
};
