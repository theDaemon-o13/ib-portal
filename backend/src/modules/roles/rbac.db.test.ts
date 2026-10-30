import { describe, expect, it } from 'vitest';
import { seedDocReaders } from '../../../prisma/seed/rbac.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, permissionsOf, roleId, type Tx } from '../../test/db.js';
import * as users from '../users/service.js';
import { usersManageHolders } from './invariant.js';
import * as roles from './service.js';

describe('users.manage: нельзя снять с себя и с последнего пользователя', () => {
  it('матрица: снять users.manage у роли, если это лишит прав последнего — нельзя', () =>
    inTx(async (tx) => {
      // Единственный администратор — через свою роль «Кадры» с users.manage.
      const roleHr = await tx.role.create({ data: { name: 'Кадры', permissions: { create: [{ permissionCode: 'users.manage' }] } } });
      const admin = await makeUser(tx, []);
      await tx.userRole.create({ data: { userId: admin.id, roleId: roleHr.id } });
      expect(await usersManageHolders(tx)).toEqual([admin.id]);

      await expectCode(roles.setRolePermission(tx, await actorFor(tx, admin.id), roleHr.id, 'users.manage', false), 'LAST_USERS_MANAGE');
      // Откат: право осталось.
      expect(await permissionsOf(tx, admin.id)).toContain('users.manage');
    }));

  it('матрица: снять users.manage с роли, через которую оно есть у себя — нельзя, даже если есть другие', () =>
    inTx(async (tx) => {
      const roleHr = await tx.role.create({ data: { name: 'Кадры', permissions: { create: [{ permissionCode: 'users.manage' }] } } });
      const me = await makeUser(tx, []);
      await tx.userRole.create({ data: { userId: me.id, roleId: roleHr.id } });
      await makeUser(tx, ['super_admin']); // другой администратор есть
      await expectCode(roles.setRolePermission(tx, await actorFor(tx, me.id), roleHr.id, 'users.manage', false), 'SELF_USERS_MANAGE');
    }));

  it('матрица: снять users.manage у роли, если у себя право остаётся через другую роль — можно', () =>
    inTx(async (tx) => {
      const roleHr = await tx.role.create({ data: { name: 'Кадры', permissions: { create: [{ permissionCode: 'users.manage' }] } } });
      const me = await makeUser(tx, ['super_admin']);
      await tx.userRole.create({ data: { userId: me.id, roleId: roleHr.id } });
      const r = await roles.setRolePermission(tx, await actorFor(tx, me.id), roleHr.id, 'users.manage', false);
      expect(r.permissions).not.toContain('users.manage');
      expect((await lastAudit(tx)).action).toBe('role.permission.revoked');
    }));

  it('пользователи: снять с себя роль, дающую users.manage, — нельзя', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin', 'ib_staff']);
      await makeUser(tx, ['super_admin']);
      const staff = await roleId(tx, 'ib_staff');
      await expectCode(
        users.updateUser(tx, await actorFor(tx, me.id), me.id, { version: me.version, roleIds: [staff] }),
        'SELF_USERS_MANAGE',
      );
      expect(await permissionsOf(tx, me.id)).toContain('users.manage');
    }));

  it('пользователи: снять роль с другого администратора — можно, если остаётся хотя бы один', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin']);
      const other = await makeUser(tx, ['super_admin']);
      const u = await users.updateUser(tx, await actorFor(tx, me.id), other.id, { version: other.version, roleIds: [] });
      expect(u.roles).toEqual([]);
    }));

  it('отключение: себя — нельзя; другого администратора — можно', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin']);
      const other = await makeUser(tx, ['super_admin']);
      await expectCode(users.setActive(tx, await actorFor(tx, me.id), me.id, me.version, false), 'SELF_DISABLE');
      const u = await users.setActive(tx, await actorFor(tx, me.id), other.id, other.version, false);
      expect(u.isActive).toBe(false);
      expect(await usersManageHolders(tx)).toEqual([me.id]);
    }));

  it('удаление роли: только несистемная и без пользователей', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin']);
      const actor = await actorFor(tx, me.id);
      const superId = await roleId(tx, 'super_admin');
      await expectCode(roles.deleteRole(tx, actor, superId, 1), 'SYSTEM_ROLE');

      const audit = await roles.createRole(tx, actor, { name: 'Аудитор', description: 'только просмотр' });
      const holder = await makeUser(tx, []);
      await tx.userRole.create({ data: { userId: holder.id, roleId: audit.id } });
      await expectCode(roles.deleteRole(tx, actor, audit.id, audit.version), 'ROLE_HAS_USERS');

      await tx.userRole.deleteMany({ where: { roleId: audit.id } });
      await roles.deleteRole(tx, actor, audit.id, audit.version);
      expect(await tx.role.findUnique({ where: { id: audit.id } })).toBeNull();
      const entry = await lastAudit(tx);
      expect(entry.action).toBe('role.deleted');
      expect(entry.diff).toMatchObject({ before: { name: 'Аудитор' } });
    }));
});

describe('супер-администратор и разделение полномочий', () => {
  it('settings.manage и users.manage у супер-администратора не снимаются', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin']);
      const superId = await roleId(tx, 'super_admin');
      const actor = await actorFor(tx, me.id);
      await expectCode(roles.setRolePermission(tx, actor, superId, 'settings.manage', false), 'LOCKED_PERMISSION');
      await expectCode(roles.setRolePermission(tx, actor, superId, 'users.manage', false), 'LOCKED_PERMISSION');
    }));

  it('права этапов согласования супер-администратору не выдаются', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin']);
      const superId = await roleId(tx, 'super_admin');
      for (const p of ['docs.approve.head'] as const) {
        await expectCode(roles.setRolePermission(tx, await actorFor(tx, me.id), superId, p, true), 'SEPARATION_OF_DUTIES');
      }
    }));

  it('остальные права выдаются и снимаются, пользователь получает сумму прав ролей', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin']);
      const actor = await actorFor(tx, me.id);
      const reader = await roleId(tx, 'doc_reader');
      const someone = await makeUser(tx, ['doc_reader', 'ib_staff']);
      await roles.setRolePermission(tx, actor, reader, 'docs.manage', true);
      const perms = await permissionsOf(tx, someone.id);
      expect(perms).toEqual(expect.arrayContaining(['docs.manage', 'ib.work', 'records.edit']));
      const r = await roles.setRolePermission(tx, actor, reader, 'docs.manage', false);
      expect(r.permissions).toEqual([]);
    }));

  it('роль: уникальное имя без учёта регистра, защита от одновременной правки', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin']);
      const actor = await actorFor(tx, me.id);
      await expectCode(roles.createRole(tx, actor, { name: 'читатель документов', description: '' }), 'DUPLICATE');
      const r = await roles.createRole(tx, actor, { name: 'Аудитор', description: '' });
      const renamed = await roles.updateRole(tx, actor, r.id, { version: r.version, name: 'Внутренний аудит' });
      expect(renamed.version).toBe(r.version + 1);
      await expectCode(roles.updateRole(tx, actor, r.id, { version: r.version, name: 'Снова' }), 'VERSION_CONFLICT');
    }));
});

describe('создание пользователя под ролью приложения', () => {
  it('создаёт пользователя с ролями от имени администратора', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin']);
      const res = await users.createUser(tx, await actorFor(tx, me.id), argon2Hasher, {
        login: 'New.User', fullName: 'Новый Пользователь', position: 'Специалист', department: 'Отдел ИБ',
        roleIds: [await roleId(tx, 'ib_staff')],
      });
      expect(res.user).toMatchObject({ login: 'new.user', mustChangePassword: true, roles: [{ name: 'Сотрудник ИБ' }] });
    }));
});

/** Роль до 1.2.0 (на новой установке её нет): создаётся в транзакции теста, если её нет в тестовой базе. */
async function retiredRole(tx: Tx, code: 'legal' | 'board', name: string) {
  const r = await tx.role.findUnique({ where: { code } });
  if (r) return r;
  const role = await tx.role.create({ data: { code, name, isSystem: true } });
  await tx.permission.upsert({ where: { code: `docs.approve.${code}` }, create: { code: `docs.approve.${code}`, name: `Этап ${name}` }, update: {} });
  await tx.rolePermission.create({ data: { roleId: role.id, permissionCode: `docs.approve.${code}` } });
  return role;
}

describe('«Юрист» и «Правление» → «Читатель документов» (релиз 1.2.0, ADR-0024)', () => {
  it('пользователи переходят в «Читатель документов», прежняя роль снимается, всё — в журнале; повтор ничего не меняет', () =>
    inTx(async (tx) => {
      const legal = await retiredRole(tx, 'legal', 'Юрист');
      const board = await retiredRole(tx, 'board', 'Правление');
      const lawyer = await makeUser(tx, ['doc_reader'], { fullName: 'Юрист Банка' });
      await tx.userRole.deleteMany({ where: { userId: lawyer.id } });
      await tx.userRole.create({ data: { userId: lawyer.id, roleId: legal.id } });
      const member = await makeUser(tx, ['ib_staff'], { fullName: 'Член Правления' });
      await tx.userRole.create({ data: { userId: member.id, roleId: board.id } });

      await seedDocReaders(tx);
      const rolesOf = async (id: string) => (await tx.userRole.findMany({ where: { userId: id }, include: { role: true } })).map((r) => r.role.code).sort();
      expect(await rolesOf(lawyer.id)).toEqual(['doc_reader']);
      expect(await rolesOf(member.id)).toEqual(['doc_reader', 'ib_staff']);
      expect(await tx.userRole.count({ where: { roleId: { in: [legal.id, board.id] } } })).toBe(0);
      expect((await tx.user.findUniqueOrThrow({ where: { id: lawyer.id } })).isActive).toBe(true);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: 'user.updated', entityId: lawyer.id }, orderBy: { at: 'desc' } });
      expect(audit.userId).toBeNull();
      expect((audit.diff as { summary: string }).summary).toMatch(/«Юрист» → «Читатель документов»/);

      // Снятое администратором позже не возвращается: шаг смотрит только на тех, кто сейчас в выведенных ролях.
      await tx.userRole.deleteMany({ where: { userId: member.id, role: { code: 'doc_reader' } } });
      const n = await tx.auditLog.count({ where: { action: 'user.updated', entityId: { in: [lawyer.id, member.id] } } });
      await seedDocReaders(tx);
      expect(await rolesOf(member.id)).toEqual(['ib_staff']);
      expect(await tx.auditLog.count({ where: { action: 'user.updated', entityId: { in: [lawyer.id, member.id] } } })).toBe(n);
    }));

  it('выведенных ролей нет в списке, назначить их нельзя; кодов прав юриста и правления нет в матрице', () =>
    inTx(async (tx) => {
      const legal = await retiredRole(tx, 'legal', 'Юрист');
      const me = await makeUser(tx, ['super_admin']);
      const actor = await actorFor(tx, me.id);
      const list = await roles.listRoles(tx);
      expect(list.some((r) => r.code === 'legal' || r.code === 'board')).toBe(false);
      expect(list.find((r) => r.code === 'doc_reader')).toMatchObject({ name: 'Читатель документов', isSystem: true, permissions: [] });
      expect((await roles.listPermissions(tx)).some((p) => p.code.startsWith('docs.approve.') && p.code !== 'docs.approve.head')).toBe(false);
      await expectCode(users.createUser(tx, actor, argon2Hasher, { login: 'x.legal', fullName: 'Икс', position: '', department: '', roleIds: [legal.id] }), 'RETIRED_ROLE');
      await expectCode(roles.setRolePermission(tx, actor, legal.id, 'docs.manage', true), 'NOT_FOUND');
    }));
});
