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
    // Триггер фиксации полей (этап 8б) сработал раньше проверки сервиса — гонка двух запросов.
    const locked = /(register_records|register_record_files): ([^"\n]*(зафиксирован|не удаляется|фиксирующ)[^"\n]*)/.exec(err.message ?? '');
    if (locked) {
      return reply.status(422).send({ error: { code: 'FIELD_LOCKED', message: `${locked[2]}. Обновите запись` } });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) {
      request.log.error({ err }, 'необработанная ошибка');
      return reply.status(500).send({
        error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера. Попробуйте ещё раз' },
      });
    }
    // Тело больше лимита маршрута: загрузка файла или импорт Excel (25 МБ).
    if (status === 413) {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'Файл больше 25 МБ' } });
    }
    return reply.status(status).send({
      error: { code: err.code ?? 'BAD_REQUEST', message: 'Некорректный запрос' },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Не найдено' } }),
  );
}
