// Роли и матрица «право × роль» (CLAUDE.md, раздел 5).
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { APPROVAL_PERMISSIONS, KIOSK_PERMISSION, SUPER_ADMIN_LOCKED, isPermissionCode, type PermissionCode } from '../../lib/permissions.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';
import { assertKioskExclusive, assertUsersManageKept, lockRbac, revokeKioskSessions } from './invariant.js';

export async function listPermissions(db: Db) {
  return db.permission.findMany({ orderBy: { sortOrder: 'asc' }, select: { code: true, name: true, description: true } });
}

const roleInclude = {
  permissions: { select: { permissionCode: true } },
  users: { select: { user: { select: { isActive: true } } } },
} as const;

function toDto(r: {
  id: string; code: string | null; name: string; description: string; isSystem: boolean; version: number;
  permissions: { permissionCode: string }[]; users: { user: { isActive: boolean } }[];
}) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    version: r.version,
    permissions: r.permissions.map((p) => p.permissionCode).filter(isPermissionCode),
    /** Права, которые у этой роли снять нельзя. */
    lockedPermissions: r.code === 'super_admin' ? [...SUPER_ADMIN_LOCKED] : [],
    /** Права, которые этой роли выдать нельзя (разделение полномочий). */
    forbiddenPermissions: r.code === 'super_admin' ? [...APPROVAL_PERMISSIONS] : [],
    activeUserCount: r.users.filter((u) => u.user.isActive).length,
    userCount: r.users.length,
  };
}

export type RoleDto = ReturnType<typeof toDto>;

export async function listRoles(db: Db): Promise<RoleDto[]> {
  const rows = await db.role.findMany({ include: roleInclude, orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }] });
  return rows.map(toDto);
}

async function getRole(db: Db, id: string) {
  const r = await db.role.findUnique({ where: { id }, include: roleInclude });
  if (!r) throw notFound('Роль');
  return r;
}

async function assertNameFree(db: Db, name: string, exceptId?: string) {
  const clash = await db.role.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (clash) throw conflict('DUPLICATE', `Роль «${name}» уже есть`);
}

export async function createRole(db: Db, actor: Actor, input: { name: string; description: string }) {
  const name = trimmed(input.name);
  if (!name) throw badRequest('EMPTY_NAME', 'Укажите название роли');
  return withTx(db, async (tx) => {
    await assertNameFree(tx, name);
    const r = await tx.role.create({ data: { name, description: trimmed(input.description) } });
    await auditSettings(tx, actor, {
      action: 'role.created',
      entity: 'role',
      entityId: r.id,
      summary: `Роли: создана «${name}»`,
      after: { name, description: r.description },
    });
    return toDto(await getRole(tx, r.id));
  });
}

export async function updateRole(db: Db, actor: Actor, id: string, input: { version: number; name?: string; description?: string }) {
  return withTx(db, async (tx) => {
    const r = await getRole(tx, id);
    const name = input.name !== undefined ? trimmed(input.name) : r.name;
    const description = input.description !== undefined ? trimmed(input.description) : r.description;
    if (!name) throw badRequest('EMPTY_NAME', 'Укажите название роли');
    if (name === r.name && description === r.description) {
      if (input.version !== r.version) throw versionConflict();
      return toDto(r);
    }
    if (name !== r.name) await assertNameFree(tx, name, id);
    const res = await tx.role.updateMany({ where: { id, version: input.version }, data: { name, description, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.role.findUnique({ where: { id } }), 'Роль');
    await auditSettings(tx, actor, {
      action: 'role.updated',
      entity: 'role',
      entityId: id,
      summary: name !== r.name ? `Роли: «${r.name}» переименована в «${name}»` : `Роли: изменено описание «${name}»`,
      before: { name: r.name, description: r.description },
      after: { name, description },
    });
    return toDto(await getRole(tx, id));
  });
}

/**
 * Удаление роли — физическое: роль не бизнес-сущность из раздела 3.4. Только несистемная роль
 * без пользователей; полный снимок роли сохраняется в журнале аудита.
 */
export async function deleteRole(db: Db, actor: Actor, id: string, version: number) {
  await withTx(db, async (tx) => {
    await lockRbac(tx);
    const r = await getRole(tx, id);
    if (r.isSystem) throw conflict('SYSTEM_ROLE', 'Системную роль удалить нельзя');
    if (r.users.length > 0) throw conflict('ROLE_HAS_USERS', `У роли есть пользователи (${r.users.length}). Сначала снимите её с них`);
    if (r.version !== version) throw versionConflict();
    await tx.rolePermission.deleteMany({ where: { roleId: id } });
    await tx.role.delete({ where: { id } });
    await assertUsersManageKept(tx, actor.id);
    await auditSettings(tx, actor, {
      action: 'role.deleted',
      entity: 'role',
      entityId: id,
      summary: `Роли: удалена «${r.name}»`,
      before: { name: r.name, description: r.description, permissions: r.permissions.map((p) => p.permissionCode) },
    });
  });
}

export async function setRolePermission(db: Db, actor: Actor, roleId: string, code: string, granted: boolean) {
  if (!isPermissionCode(code)) throw notFound('Право');
  const perm: PermissionCode = code;
  return withTx(db, async (tx) => {
    await lockRbac(tx);
    const r = await getRole(tx, roleId);
    const has = r.permissions.some((p) => p.permissionCode === perm);
    if (has === granted) return toDto(r);
    if (r.code === 'super_admin' && !granted && SUPER_ADMIN_LOCKED.includes(perm)) {
      throw conflict('LOCKED_PERMISSION', 'У роли «Супер-администратор» это право не снимается');
    }
    if (r.code === 'super_admin' && granted && APPROVAL_PERMISSIONS.includes(perm)) {
      throw conflict(
        'SEPARATION_OF_DUTIES',
        'Права этапов согласования не выдаются роли «Супер-администратор»: он не согласует за других',
      );
    }
    if (granted) await tx.rolePermission.create({ data: { roleId, permissionCode: perm } });
    else await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId, permissionCode: perm } } });
    await tx.role.update({ where: { id: roleId }, data: { version: { increment: 1 } } });
    if (!granted) await assertUsersManageKept(tx, actor.id);
    if (granted) await assertKioskExclusive(tx);
    // Сняли право «Настенный монитор» с роли — 7-суточные сессии её пользователей закрываются (ADR-0012).
    let closed = 0;
    if (!granted && perm === KIOSK_PERMISSION) {
      const holders = await tx.userRole.findMany({ where: { roleId }, select: { userId: true } });
      closed = await revokeKioskSessions(tx, holders.map((h) => h.userId));
    }
    const permName = (await tx.permission.findUnique({ where: { code: perm } }))?.name ?? perm;
    await auditSettings(tx, actor, {
      action: granted ? 'role.permission.granted' : 'role.permission.revoked',
      entity: 'role',
      entityId: roleId,
      summary: `Роль «${r.name}»: ${granted ? 'выдано' : 'снято'} право «${permName}»${closed ? `, закрыто сессий монитора: ${closed}` : ''}`,
      after: { permission: perm, granted, ...(closed ? { sessionsClosed: closed } : {}) },
    });
    return toDto(await getRole(tx, roleId));
  });
}
