// Пользователи портала (docs/concept.md, раздел 9): создание, роли, отключение, сброс пароля.
// Временный пароль генерируется системой, возвращается администратору один раз и нигде
// не хранится в открытом виде: ни в БД, ни в журнале аудита, ни в логах.
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { seniorIdsOf } from '../../lib/hierarchy.js';
import { toPage } from '../../lib/pagination.js';
import { passwordExpiresAt } from '../../lib/password-policy.js';
import type { PasswordHasher } from '../../lib/passwords.js';
import { generateTemporaryPassword } from '../../lib/temp-password.js';
import { recomputeSearchForUser } from '../registers/definition.js';
import { assertKioskExclusive, assertUsersManageKept, lockRbac } from '../roles/invariant.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';

const include = {
  roles: { include: { role: { select: { id: true, name: true } } } },
  manager: { select: { id: true, login: true, fullName: true, isActive: true } },
  _count: { select: { subordinates: true } },
} as const;
type UserRow = Prisma.UserGetPayload<{ include: typeof include }>;

export const LOGIN_RE = /^[a-z0-9._-]{3,64}$/;

function toDto(u: UserRow, now = new Date()) {
  return {
    id: u.id,
    login: u.login,
    fullName: u.fullName,
    position: u.position,
    department: u.department,
    isActive: u.isActive,
    roles: u.roles.map((r) => r.role).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    manager: u.manager,
    subordinateCount: u._count.subordinates,
    mustChangePassword: u.mustChangePassword,
    passwordExpiresAt: passwordExpiresAt(u.passwordChangedAt).toISOString(),
    locked: u.lockedUntil !== null && u.lockedUntil > now,
    lockedUntil: u.lockedUntil?.toISOString() ?? null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    version: u.version,
  };
}

export type UserDto = ReturnType<typeof toDto>;

async function getUser(db: Db, id: string) {
  const u = await db.user.findUnique({ where: { id }, include });
  if (!u) throw notFound('Пользователь');
  return u;
}

export async function listUsers(db: Db, q: { limit: number; cursor?: string; search?: string }) {
  const search = q.search?.trim();
  const rows = await db.user.findMany({
    where: {
      ...(q.cursor ? { login: { gt: q.cursor } } : {}),
      ...(search
        ? { OR: [{ login: { contains: search, mode: 'insensitive' } }, { fullName: { contains: search, mode: 'insensitive' } }] }
        : {}),
    },
    include,
    orderBy: { login: 'asc' },
    take: q.limit + 1,
  });
  const page = toPage(rows, q.limit, (r) => r.login);
  return { items: page.items.map((u) => toDto(u)), nextCursor: page.nextCursor };
}

/** Для списков выбора ответственного: активные сотрудники ИБ. */
const IB_WORK = { roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } } as const;

/**
 * Активные пользователи для выбора. scope 'ib' — сотрудники ИБ (ответственные, участники меток);
 * 'all' — все активные (владелец системы), с отметкой, есть ли у человека доступ к разделам ИБ.
 */
export async function userOptions(db: Db, scope: 'ib' | 'all' = 'ib') {
  const [users, ib] = await Promise.all([
    db.user.findMany({ where: { isActive: true, ...(scope === 'ib' ? IB_WORK : {}) }, select: { id: true, login: true, fullName: true }, orderBy: { fullName: 'asc' } }),
    scope === 'ib' ? Promise.resolve(null) : db.user.findMany({ where: { isActive: true, ...IB_WORK }, select: { id: true } }),
  ]);
  const ibIds = ib ? new Set(ib.map((u) => u.id)) : null;
  return users.map((u) => ({ ...u, ibWork: ibIds ? ibIds.has(u.id) : true }));
}

async function resolveRoles(db: Db, roleIds: readonly string[]) {
  const ids = [...new Set(roleIds)];
  const roles = await db.role.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  if (roles.length !== ids.length) throw badRequest('UNKNOWN_ROLE', 'Одна из ролей не найдена. Обновите страницу');
  return roles;
}

const roleList = (roles: { name: string }[]) => (roles.length ? roles.map((r) => `«${r.name}»`).join(', ') : 'нет');

async function hasIbWork(db: Db, userId: string): Promise<boolean> {
  return (await db.user.count({ where: { id: userId, ...IB_WORK } })) > 0;
}

const who = (u: { fullName: string; login: string } | null) => (u ? `${u.fullName} (${u.login})` : '—');

/**
 * Руководитель (ADR-0020): активный сотрудник ИБ, не сам пользователь и не его подчинённый (цикл).
 * userId — null при создании пользователя: подчинённых у него ещё нет.
 */
async function checkManager(db: Db, userId: string | null, managerId: string) {
  if (managerId === userId) throw conflict('MANAGER_SELF', 'Пользователь не может быть руководителем самому себе');
  const m = await db.user.findUnique({ where: { id: managerId }, select: { id: true, login: true, fullName: true, isActive: true } });
  if (!m) throw badRequest('UNKNOWN_MANAGER', 'Руководитель не найден. Обновите страницу');
  if (!m.isActive) throw conflict('MANAGER_INACTIVE', `${who(m)} отключён и не может быть руководителем`);
  if (!(await hasIbWork(db, managerId))) {
    throw conflict('MANAGER_NOT_IB', `${who(m)} без доступа к разделам ИБ и не может быть руководителем`);
  }
  if (userId && (await seniorIdsOf(db, managerId)).includes(userId)) {
    throw conflict('MANAGER_CYCLE', `Нельзя: ${who(m)} уже подчинён этому пользователю`);
  }
  return m;
}

export async function createUser(
  db: Db,
  actor: Actor,
  hasher: PasswordHasher,
  input: { login: string; fullName: string; position: string; department: string; roleIds: string[]; managerId?: string | null },
) {
  const login = input.login.trim().toLowerCase();
  if (!LOGIN_RE.test(login)) {
    throw badRequest('BAD_LOGIN', 'Логин: 3–64 символа, латиница, цифры, точка, дефис, подчёркивание');
  }
  const fullName = trimmed(input.fullName);
  if (!fullName) throw badRequest('EMPTY_NAME', 'Укажите ФИО');
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hasher.hash(temporaryPassword);

  const user = await withTx(db, async (tx) => {
    if (await tx.user.findUnique({ where: { login } })) throw conflict('DUPLICATE', `Логин ${login} уже занят`);
    const roles = await resolveRoles(tx, input.roleIds);
    const manager = input.managerId ? await checkManager(tx, null, input.managerId) : null;
    const created = await tx.user.create({
      data: {
        login,
        fullName,
        position: trimmed(input.position),
        department: trimmed(input.department),
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        roles: { create: roles.map((r) => ({ roleId: r.id, assignedBy: actor.id })) },
        ...(manager ? { manager: { connect: { id: manager.id } } } : {}),
      },
    });
    await assertKioskExclusive(tx);
    if (manager && !(await hasIbWork(tx, created.id))) {
      throw conflict('SUBORDINATE_NOT_IB', 'Руководителя можно указать только сотруднику с доступом к разделам ИБ');
    }
    await auditSettings(tx, actor, {
      action: 'user.created',
      entity: 'user',
      entityId: created.id,
      summary: `Пользователи: создан ${fullName} (${login}), роли: ${roleList(roles)}${manager ? `, руководитель ${who(manager)}` : ''}`,
      after: {
        login, fullName, position: created.position, department: created.department, roles: roles.map((r) => r.name),
        manager: manager ? who(manager) : null,
      },
    });
    return getUser(tx, created.id);
  });
  return { user: toDto(user), temporaryPassword };
}

export async function updateUser(
  db: Db,
  actor: Actor,
  id: string,
  input: { version: number; fullName?: string; position?: string; department?: string; roleIds?: string[]; managerId?: string | null },
) {
  return withTx(db, async (tx) => {
    await lockRbac(tx);
    const u = await getUser(tx, id);
    if (u.version !== input.version) throw versionConflict();
    const data: Prisma.UserUpdateInput = {};
    const changes: string[] = [];
    for (const key of ['fullName', 'position', 'department'] as const) {
      const v = input[key];
      if (v !== undefined && trimmed(v) !== u[key]) {
        if (key === 'fullName' && !trimmed(v)) throw badRequest('EMPTY_NAME', 'Укажите ФИО');
        data[key] = trimmed(v);
        changes.push({ fullName: 'ФИО', position: 'должность', department: 'подразделение' }[key]);
      }
    }
    const beforeRoles = u.roles.map((r) => r.role);
    let afterRoles = beforeRoles;
    if (input.roleIds !== undefined) {
      const next = await resolveRoles(tx, input.roleIds);
      const nextIds = new Set(next.map((r) => r.id));
      const prevIds = new Set(beforeRoles.map((r) => r.id));
      const removed = beforeRoles.filter((r) => !nextIds.has(r.id));
      const added = next.filter((r) => !prevIds.has(r.id));
      if (removed.length) await tx.userRole.deleteMany({ where: { userId: id, roleId: { in: removed.map((r) => r.id) } } });
      if (added.length) await tx.userRole.createMany({ data: added.map((r) => ({ userId: id, roleId: r.id, assignedBy: actor.id })) });
      if (removed.length || added.length) {
        afterRoles = next;
        changes.push(`роли ${roleList(beforeRoles)} → ${roleList(next)}`);
      }
    }
    // Руководитель и подчинённые — только сотрудники ИБ: без ib.work руководитель снимается, подчинённые мешают.
    const ibWork = await hasIbWork(tx, id);
    let nextManager: { id: string; login: string; fullName: string } | null = u.manager;
    if (input.managerId !== undefined && input.managerId !== u.managerId) {
      nextManager = input.managerId ? await checkManager(tx, id, input.managerId) : null;
      if (nextManager && !ibWork) {
        throw conflict('SUBORDINATE_NOT_IB', 'Руководителя можно указать только сотруднику с доступом к разделам ИБ');
      }
    } else if (!ibWork && u.managerId) {
      nextManager = null;
    }
    if (!ibWork && u._count.subordinates > 0) {
      throw conflict(
        'HAS_SUBORDINATES',
        `Без доступа к разделам ИБ ${u.fullName} не может руководить: сначала назначьте подчинённым (${u._count.subordinates}) другого руководителя`,
      );
    }
    const managerChanged = (nextManager?.id ?? null) !== u.managerId;
    if (managerChanged) changes.push(`руководитель ${who(u.manager)} → ${who(nextManager)}`);
    if (changes.length === 0) return toDto(u);
    const res = await tx.user.updateMany({
      where: { id, version: input.version },
      data: { ...(data as object), ...(managerChanged ? { managerId: nextManager?.id ?? null } : {}), version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.user.findUnique({ where: { id } }), 'Пользователь');
    // ФИО участвует в поиске по реестрам (поле «сотрудник»).
    if (data.fullName !== undefined) await recomputeSearchForUser(tx, id);
    // Снятие роли не должно лишить себя или всех пользователей права users.manage.
    await assertUsersManageKept(tx, actor.id);
    await assertKioskExclusive(tx);
    await auditSettings(tx, actor, {
      action: 'user.updated',
      entity: 'user',
      entityId: id,
      summary: `Пользователи: ${u.fullName} (${u.login}) — ${changes.join(', ')}`,
      before: {
        fullName: u.fullName, position: u.position, department: u.department, roles: beforeRoles.map((r) => r.name),
        ...(managerChanged ? { manager: u.manager ? who(u.manager) : null } : {}),
      },
      after: {
        ...(data as Record<string, unknown>), roles: afterRoles.map((r) => r.name),
        ...(managerChanged ? { manager: nextManager ? who(nextManager) : null } : {}),
      },
    });
    return toDto(await getUser(tx, id));
  });
}

export async function setActive(db: Db, actor: Actor, id: string, version: number, active: boolean) {
  return withTx(db, async (tx) => {
    await lockRbac(tx);
    if (id === actor.id && !active) throw conflict('SELF_DISABLE', 'Нельзя отключить собственную учётную запись');
    const u = await getUser(tx, id);
    if (u.isActive === active) {
      if (u.version !== version) throw versionConflict();
      return toDto(u);
    }
    const res = await tx.user.updateMany({ where: { id, version }, data: { isActive: active, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.user.findUnique({ where: { id } }), 'Пользователь');
    if (!active) {
      await assertUsersManageKept(tx, actor.id);
      // Отключённый пользователь сразу теряет доступ.
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await auditSettings(tx, actor, {
      action: active ? 'user.enabled' : 'user.disabled',
      entity: 'user',
      entityId: id,
      summary: `Пользователи: ${active ? 'включён' : 'отключён'} ${u.fullName} (${u.login})`,
    });
    return toDto(await getUser(tx, id));
  });
}

export async function resetPassword(db: Db, actor: Actor, hasher: PasswordHasher, id: string, version: number) {
  if (id === actor.id) {
    throw conflict('SELF_RESET', 'Свой пароль меняйте через «Смену пароля», а не сбросом');
  }
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hasher.hash(temporaryPassword);
  const user = await withTx(db, async (tx) => {
    const u = await getUser(tx, id);
    if (!u.isActive) throw conflict('INACTIVE', 'Пользователь отключён. Сначала включите его');
    const now = new Date();
    const res = await tx.user.updateMany({
      where: { id, version },
      data: {
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: now,
        failedLoginCount: 0,
        lockedUntil: null,
        version: { increment: 1 },
      },
    });
    await ensureVersioned(res.count, () => tx.user.findUnique({ where: { id } }), 'Пользователь');
    // Прежний пароль уходит в историю: пользователь не сможет вернуться к нему при смене.
    await tx.passwordHistory.create({ data: { userId: id, passwordHash: u.passwordHash, createdAt: now } });
    await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
    await auditSettings(tx, actor, {
      action: 'user.password_reset',
      entity: 'user',
      entityId: id,
      summary: `Пользователи: сброшен пароль ${u.fullName} (${u.login}), при входе потребуется смена`,
    });
    return getUser(tx, id);
  });
  return { user: toDto(user), temporaryPassword };
}

export async function unlock(db: Db, actor: Actor, id: string, version: number) {
  return withTx(db, async (tx) => {
    const u = await getUser(tx, id);
    const res = await tx.user.updateMany({
      where: { id, version },
      data: { failedLoginCount: 0, lockedUntil: null, version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.user.findUnique({ where: { id } }), 'Пользователь');
    await auditSettings(tx, actor, {
      action: 'user.unlocked',
      entity: 'user',
      entityId: id,
      summary: `Пользователи: снята блокировка входа ${u.fullName} (${u.login})`,
    });
    return toDto(await getUser(tx, id));
  });
}
