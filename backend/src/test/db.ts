// Помощники для тестов с настоящей БД. Подключение — под ролью приложения (ibportal_app),
// как у работающего backend: тесты заодно проверяют, что прав хватает и лишних нет.
import type { Prisma } from '../generated/prisma/client.js';
import { afterAll } from 'vitest';
import { testDbConfig } from '../../scripts/test-db.js';
import { createPrisma } from '../lib/db.js';
import type { PermissionCode } from '../lib/permissions.js';
import type { Actor } from '../modules/settings/common.js';

export const prisma = createPrisma(testDbConfig().appUrl);
afterAll(() => prisma.$disconnect());

export type Tx = Prisma.TransactionClient;

class Rollback extends Error {}

/** Тест в транзакции, которая всегда откатывается: база остаётся чистой для следующего теста. */
export async function inTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

let seq = 0;

export async function roleId(tx: Tx, code: string): Promise<string> {
  return (await tx.role.findUniqueOrThrow({ where: { code } })).id;
}

/** Пользователь с системными ролями по коду. Хэш пароля — заглушка, вход здесь не нужен. */
export async function makeUser(tx: Tx, roleCodes: string[], extra: Partial<Prisma.UserCreateInput> = {}) {
  const login = `t${++seq}.${Date.now().toString(36)}`;
  const roles = await Promise.all(roleCodes.map((c) => roleId(tx, c)));
  return tx.user.create({
    data: {
      login,
      fullName: `Тест ${seq}`,
      passwordHash: 'not-a-real-hash',
      mustChangePassword: false,
      roles: { create: roles.map((r) => ({ roleId: r })) },
      ...extra,
    },
  });
}

/** Пользователь как в сессии: роли и сумма прав (права нужны процессу задач, ADR-0022). */
export async function actorFor(tx: Tx, userId: string): Promise<Actor & { perms: ReadonlySet<string> }> {
  const roles = await tx.userRole.findMany({ where: { userId }, include: { role: true } });
  return { id: userId, roleNames: roles.map((r) => r.role.name), ip: '127.0.0.1', perms: new Set(await permissionsOf(tx, userId)) };
}

export async function permissionsOf(tx: Tx, userId: string): Promise<PermissionCode[]> {
  const rows = await tx.rolePermission.findMany({
    where: { role: { users: { some: { userId } } } },
    select: { permissionCode: true },
    distinct: ['permissionCode'],
  });
  return rows.map((r) => r.permissionCode as PermissionCode);
}

export async function lastAudit(tx: Tx) {
  return tx.auditLog.findFirstOrThrow({ orderBy: { id: 'desc' } });
}

/** Ожидать AppError с кодом. */
export async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    const got = (err as { code?: string }).code;
    if (got !== code) throw new Error(`ожидался код ${code}, получено ${got ?? String(err)}`);
    return;
  }
  throw new Error(`ожидалась ошибка ${code}, но операция выполнилась`);
}

/** Значение должно быть: иначе тест падает с понятным сообщением (вместо `!`). */
export function must<T>(v: T | null | undefined, what = 'значение'): T {
  if (v === null || v === undefined) throw new Error(`нет: ${what}`);
  return v;
}

/** Строка files без содержимого на диске: для тестов сервисов, которым нужен только id файла. */
export async function makeFileRow(tx: Tx, uploadedBy: string, opts: { name?: string; mime?: string; uploadedAt?: Date } = {}) {
  const { randomBytes, randomUUID } = await import('node:crypto');
  return tx.file.create({
    data: {
      storageKey: `2026/10/${randomUUID()}`,
      originalName: opts.name ?? 'Итог.pdf',
      mime: opts.mime ?? 'application/pdf',
      size: 1024n,
      sha256: randomBytes(32).toString('hex'),
      uploadedBy,
      ...(opts.uploadedAt ? { uploadedAt: opts.uploadedAt } : {}),
    },
  });
}
