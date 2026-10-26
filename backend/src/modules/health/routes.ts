import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const Health = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'down']),
});

/** GET /api/health: без авторизации и без данных. */
export const healthRoutes: FastifyPluginAsyncZod<{ ping: () => Promise<boolean> }> = async (app, { ping }) => {
  app.get('/health', {
    config: { public: true },
    schema: {
      tags: ['health'],
      summary: 'Состояние backend и БД',
      response: { 200: Health, 503: Health },
    },
  }, async (_request, reply) => {
    const dbOk = await ping();
    return reply.status(dbOk ? 200 : 503).send({ status: dbOk ? 'ok' : 'degraded', db: dbOk ? 'ok' : 'down' });
  });
};
