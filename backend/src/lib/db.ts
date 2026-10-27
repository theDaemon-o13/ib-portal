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

/**
 * Выполнить fn в транзакции. Если db уже транзакция (вложенный вызов, тесты) — внутри неё
 * через SAVEPOINT: при ошибке откатывается только эта часть, внешняя транзакция остаётся рабочей.
 */
export async function withTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  // У транзакции нет $connect (в Prisma 7 $transaction из её типа больше не убран, по нему не отличить).
  if ('$connect' in db) return (db as PrismaClient).$transaction(fn, { timeout: 15_000 });
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
