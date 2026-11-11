import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

/**
 * Клиент Prisma 7 через драйвер-адаптер pg (ADR-0014). Адрес — аргумент или DATABASE_URL.
 * Таймаут подключения 5 с — как было по умолчанию в Prisma 6 (у pg по умолчанию ожидание без предела).
 */
export function createPrisma(databaseUrl = process.env.DATABASE_URL): PrismaClient {
  if (!databaseUrl) throw new Error('DATABASE_URL не задан');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 }) });
}

/** Клиент или открытая транзакция: сервисы работают с обоими. */
export type Db = PrismaClient | Prisma.TransactionClient;

let savepointSeq = 0;

export interface TxLimits {
  /** Предел транзакции, мс. */
  timeout: number;
  /** Ожидание свободного соединения, мс. */
  maxWait?: number;
}

/** Обычная транзакция: 15 с. */
export const DEFAULT_TX: TxLimits = { timeout: 15_000 };

/**
 * Массовые операции (1.13.9): импорт скана, передача ИКТ, продления, перенос, импорт Excel, прогон автоматизаций.
 * Это запас, а не решение: они пишут пачками, число запросов растёт с числом пачек, и 10 000 записей укладываются
 * в десятки секунд. Предел равен proxy_read_timeout nginx (120 с): дольше браузер ответа всё равно не дождётся.
 */
export const BULK_TX: TxLimits = { timeout: 120_000, maxWait: 10_000 };

/**
 * Выполнить fn в транзакции. Если db уже транзакция (вложенный вызов, тесты) — внутри неё
 * через SAVEPOINT: при ошибке откатывается только эта часть, внешняя транзакция остаётся рабочей
 * (пределы времени тогда — у внешней транзакции).
 */
export async function withTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>, limits: TxLimits = DEFAULT_TX): Promise<T> {
  // У транзакции нет $connect (в Prisma 7 $transaction из её типа больше не убран, по нему не отличить).
  if ('$connect' in db) return (db as PrismaClient).$transaction(fn, limits);
  const tx = db as Prisma.TransactionClient;
  const sp = `sp_${++savepointSeq}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
  try {
    const result = await fn(tx);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
    throw err;
  }
}

/** Нарушение уникальности (P2002 или 23505 из сырого SQL / частичного индекса). */
export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return true;
    if (err.code === 'P2010' && String(err.meta?.code) === '23505') return true;
  }
  return err instanceof Error && /23505|unique constraint/i.test(err.message);
}

/** Таймаут или закрытая транзакция Prisma (P2028): транзакция откатилась целиком. */
export function isTxTimeout(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2028';
}
