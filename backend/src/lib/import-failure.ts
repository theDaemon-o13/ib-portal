// Ошибка применения импорта (1.13.9): повтор не поможет, поэтому не «Внутренняя ошибка сервера. Попробуйте ещё раз»,
// а номер запроса для администратора. Транзакция импорта откатилась целиком — в ответе так и сказано.
import type { FastifyRequest } from 'fastify';
import { AppError } from './errors.js';
import { isTxTimeout } from './db.js';

export interface ImportContext {
  /** Что импортировали: «скан», «Excel». */
  kind: string;
  /** Узел или реестр. */
  target: string | null;
  /** Строк в импорте (если известно). */
  rows: number | null;
  /** Шаг, на котором остановилось применение. */
  step: string;
  startedAt: number;
}

export const IMPORT_FAILED_MESSAGE = (requestId: string) => `Импорт не завершён, ничего не записано. Сообщите администратору номер запроса ${requestId}`;

/** Ожидаемые ошибки (409, 400, 403…) — как есть; остальное — строка error в лог и 500 IMPORT_FAILED с номером запроса. */
export function importFailure(request: FastifyRequest, err: unknown, ctx: ImportContext): AppError {
  if (err instanceof AppError) return err;
  request.log.error({
    err, import: ctx.kind, target: ctx.target, rows: ctx.rows, step: ctx.step || 'начало',
    durationMs: Math.round(performance.now() - ctx.startedAt), timeout: isTxTimeout(err), reqId: request.id,
  }, 'импорт не выполнен');
  return new AppError(500, 'IMPORT_FAILED', IMPORT_FAILED_MESSAGE(request.id));
}
