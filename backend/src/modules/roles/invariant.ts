// Правило RBAC (CLAUDE.md, раздел 5): нельзя снять users.manage с себя
// и с последнего активного пользователя, у которого оно есть.
// Проверяется после изменения внутри той же транзакции: при нарушении изменение откатывается.
// Одно правило на все пути: снятие права у роли, снятие роли у пользователя,
// отключение пользователя, удаление роли.
import type { Db } from '../../lib/db.js';
import { conflict } from '../../lib/errors.js';
import { KIOSK_PERMISSION } from '../../lib/permissions.js';

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

/**
 * Право «Настенный монитор» исключительное (ADR-0012): роль с ним не содержит других прав,
 * пользователь с такой ролью не получает других ролей. Проверяется после изменения, в той же транзакции.
 */
export async function assertKioskExclusive(tx: Db): Promise<void> {
  const mixedRoles = await tx.$queryRaw<{ name: string }[]>`
    SELECT r.name FROM roles r JOIN role_permissions p ON p.role_id = r.id
    GROUP BY r.id, r.name HAVING bool_or(p.permission_code = 'monitor.kiosk') AND count(*) > 1`;
  if (mixedRoles.length) {
    throw conflict(
      'KIOSK_EXCLUSIVE',
      `Право «Настенный монитор» не сочетается с другими правами (роль «${mixedRoles[0]?.name}»). Заведите для монитора отдельную роль`,
    );
  }
  const mixedUsers = await tx.$queryRaw<{ full_name: string }[]>`
    SELECT u.full_name FROM users u JOIN user_roles ur ON ur.user_id = u.id
    GROUP BY u.id, u.full_name
    HAVING count(*) > 1 AND bool_or(EXISTS (
      SELECT 1 FROM role_permissions p WHERE p.role_id = ur.role_id AND p.permission_code = 'monitor.kiosk'))`;
  if (mixedUsers.length) {
    throw conflict(
      'KIOSK_EXCLUSIVE',
      `Учётная запись настенного монитора не получает других ролей (${mixedUsers[0]?.full_name}). Для работы в портале заведите отдельного пользователя`,
    );
  }
}

/** Есть ли у пользователя право настенного монитора (сумма прав его ролей). */
export async function hasKioskRole(db: Db, userId: string): Promise<boolean> {
  return (await db.rolePermission.count({ where: { permissionCode: KIOSK_PERMISSION, role: { users: { some: { userId } } } } })) > 0;
}

/**
 * Сессии монитора живут 7 суток (ADR-0012): сняли роль или право «Настенный монитор» — открытые сессии этих
 * пользователей закрываются сразу, а не по общему пределу. Возвращает число закрытых сессий.
 */
export async function revokeKioskSessions(db: Db, userIds: readonly string[]): Promise<number> {
  if (!userIds.length) return 0;
  const res = await db.session.updateMany({ where: { userId: { in: [...userIds] }, revokedAt: null }, data: { revokedAt: new Date() } });
  return res.count;
}
