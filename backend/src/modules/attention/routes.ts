// GET /me/attention — индикаторы «ждёт вашего действия» для меню и колокольчика (релиз 1.4.0).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAuth } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { attentionOf } from './service.js';

const Attention = z.object({
  /** Задачи «На проверке», которые проверяете вы. */
  tasks: z.number().int(),
  /** Документы «ждут вас». */
  documents: z.number().int(),
  /** Сумма — число на колокольчике. */
  total: z.number().int(),
});

export const attentionRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  // Любой вошедший (переводчик и «Читатель документов» — без прав, но документы ждут и их); монитору — нет (auth).
  app.get('/me/attention', {
    preHandler: requireAuth(),
    schema: {
      tags: ['me'],
      summary: 'Что ждёт действия пользователя: задачи на его проверке, документы «ждут вас», сумма для колокольчика (опрос фоновым запросом)',
      response: { 200: Attention, 401: ErrorResponse, 403: ErrorResponse },
    },
  }, async (request) => attentionOf(db, { ...actorOf(request), perms: request.user?.permissions ?? new Set<string>() }));
};
