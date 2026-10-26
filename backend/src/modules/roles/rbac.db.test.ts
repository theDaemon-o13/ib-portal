import { describe, expect, it } from 'vitest';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, permissionsOf, roleId } from '../../test/db.js';
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
      for (const p of ['docs.approve.head', 'docs.approve.legal', 'docs.approve.board'] as const) {
        await expectCode(roles.setRolePermission(tx, await actorFor(tx, me.id), superId, p, true), 'SEPARATION_OF_DUTIES');
      }
    }));

  it('остальные права выдаются и снимаются, пользователь получает сумму прав ролей', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin']);
      const actor = await actorFor(tx, me.id);
      const legal = await roleId(tx, 'legal');
      const someone = await makeUser(tx, ['legal', 'ib_staff']);
      await roles.setRolePermission(tx, actor, legal, 'docs.manage', true);
      const perms = await permissionsOf(tx, someone.id);
      expect(perms).toEqual(expect.arrayContaining(['docs.approve.legal', 'docs.manage', 'ib.work', 'records.edit']));
      const r = await roles.setRolePermission(tx, actor, legal, 'docs.manage', false);
      expect(r.permissions).toEqual(['docs.approve.legal']);
    }));

  it('роль: уникальное имя без учёта регистра, защита от одновременной правки', () =>
    inTx(async (tx) => {
      const me = await makeUser(tx, ['super_admin']);
      const actor = await actorFor(tx, me.id);
      await expectCode(roles.createRole(tx, actor, { name: 'юрист', description: '' }), 'DUPLICATE');
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
