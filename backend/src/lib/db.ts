import { Prisma, PrismaClient } from '@prisma/client';

export function createPrisma(databaseUrl?: string): PrismaClient {
  return new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : undefined);
}

/** Клиент или открытая транзакция: сервисы работают с обоими. */
export type Db = PrismaClient | Prisma.TransactionClient;

let savepointSeq = 0;

/**
 * Выполнить fn в транзакции. Если db уже транзакция (вложенный вызов, тесты) — внутри неё
 * через SAVEPOINT: при ошибке откатывается только эта часть, внешняя транзакция остаётся рабочей.
 */
export async function withTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ('$transaction' in db) return db.$transaction(fn, { timeout: 15_000 });
  const sp = `sp_${++savepointSeq}`;
  await db.$executeRawUnsafe(`SAVEPOINT ${sp}`);
  try {
    const result = await fn(db);
    await db.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    await db.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
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
