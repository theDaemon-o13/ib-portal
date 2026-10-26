// Правило RBAC (CLAUDE.md, раздел 5): нельзя снять users.manage с себя
// и с последнего активного пользователя, у которого оно есть.
// Проверяется после изменения внутри той же транзакции: при нарушении изменение откатывается.
// Одно правило на все пути: снятие права у роли, снятие роли у пользователя,
// отключение пользователя, удаление роли.
import type { Db } from '../../lib/db.js';
import { conflict } from '../../lib/errors.js';

/** Последовательная обработка изменений прав: две параллельные правки не обойдут проверку. */
export async function lockRbac(tx: Db): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('ibportal.rbac'))::text`;
}

export async function usersManageHolders(tx: Db): Promise<string[]> {
  const rows = await tx.user.findMany({
    where: {
      isActive: true,
      roles: { some: { role: { permissions: { some: { permissionCode: 'users.manage' } } } } },
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function assertUsersManageKept(tx: Db, actorId: string): Promise<void> {
  const holders = await usersManageHolders(tx);
  if (holders.length === 0) {
    throw conflict(
      'LAST_USERS_MANAGE',
      'Нельзя оставить портал без пользователя, который управляет пользователями и ролями',
    );
  }
  if (!holders.includes(actorId)) {
    throw conflict('SELF_USERS_MANAGE', 'Нельзя снять с себя право управлять пользователями и ролями');
  }
}
