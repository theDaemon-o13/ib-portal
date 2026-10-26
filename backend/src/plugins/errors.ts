import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Единый формат ошибок: { error: { code, message } }, текст на русском. */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    if ('validation' in err && err.validation) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Проверьте заполнение полей' },
      });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) {
      request.log.error({ err }, 'необработанная ошибка');
      return reply.status(500).send({
        error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера. Попробуйте ещё раз' },
      });
    }
    return reply.status(status).send({
      error: { code: err.code ?? 'BAD_REQUEST', message: 'Некорректный запрос' },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Не найдено' } }),
  );
}
