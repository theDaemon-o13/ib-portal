import { describe, expect, it } from 'vitest';
import { checkPasswordStrength } from '../../lib/password-policy.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, roleId, type Tx } from '../../test/db.js';
import * as users from './service.js';

async function setup(tx: Tx) {
  const admin = await makeUser(tx, ['super_admin']);
  return { admin, actor: await actorFor(tx, admin.id) };
}

describe('создание пользователя', () => {
  it('временный пароль: по политике, хранится только хэш argon2id, в журнал не попадает', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      const { user, temporaryPassword } = await users.createUser(tx, actor, argon2Hasher, {
        login: 'k.ivanova', fullName: 'К. Иванова', position: 'Специалист', department: 'Отдел ИБ',
        roleIds: [await roleId(tx, 'ib_staff')],
      });
      expect(checkPasswordStrength(temporaryPassword, user.login)).toEqual([]);
      expect(user.mustChangePassword).toBe(true);

      const row = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.passwordHash).not.toContain(temporaryPassword);
      expect(await argon2Hasher.verify(row.passwordHash, temporaryPassword)).toBe(true);

      const entry = await lastAudit(tx);
      expect(entry.action).toBe('user.created');
      expect(JSON.stringify(entry.diff)).not.toContain(temporaryPassword);
      expect(entry.diff).toMatchObject({ summary: expect.stringContaining('К. Иванова (k.ivanova)'), actorRoles: ['Супер-администратор'] });
    }));

  it('логин уникален и проверяется по формату', () =>
    inTx(async (tx) => {
      const { admin, actor } = await setup(tx);
      const base = { fullName: 'Х', position: '', department: '', roleIds: [] };
      await expectCode(users.createUser(tx, actor, argon2Hasher, { ...base, login: admin.login.toUpperCase() }), 'DUPLICATE');
      await expectCode(users.createUser(tx, actor, argon2Hasher, { ...base, login: 'Иван' }), 'BAD_LOGIN');
      await expectCode(users.createUser(tx, actor, argon2Hasher, { ...base, login: 'ok.login', roleIds: ['00000000-0000-0000-0000-000000000000'] }), 'UNKNOWN_ROLE');
    }));

  it('одновременное создание с тем же логином: второму — 409 DUPLICATE от уникального индекса, а не 500', () =>
    inTx(async (tx) => {
      const { admin, actor } = await setup(tx);
      // Гонка: ранняя проверка «логин свободен» прошла, а строку с этим логином уже вставил конкурент.
      // Подменяем только эту проверку — вставка упирается в настоящий индекс users_login_key.
      const userRepo = new Proxy(tx.user, {
        get: (target, key) => (key === 'findUnique' ? async () => null : Reflect.get(target, key)),
      });
      const racy = new Proxy(tx, { get: (target, key) => (key === 'user' ? userRepo : Reflect.get(target, key)) });
      const base = { fullName: 'Х', position: '', department: '', roleIds: [] };
      await expectCode(users.createUser(racy, actor, argon2Hasher, { ...base, login: admin.login }), 'DUPLICATE');
      // Ошибка откатилась к точке сохранения: транзакция жива, второго пользователя с этим логином нет.
      expect(await tx.user.count({ where: { login: admin.login } })).toBe(1);
    }));
});

describe('сброс пароля, разблокировка, отключение', () => {
  it('сброс: новый временный пароль, смена при входе, блокировка снята, сессии закрыты, прежний пароль в истории', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      const oldHash = await argon2Hasher.hash('Old-Password-2026');
      const u = await makeUser(tx, ['ib_staff'], {
        passwordHash: oldHash, failedLoginCount: 5, lockedUntil: new Date(Date.now() + 600_000),
      });
      await tx.session.create({ data: { id: 'a'.repeat(64), userId: u.id, expiresAt: new Date(Date.now() + 3_600_000) } });

      const { user, temporaryPassword } = await users.resetPassword(tx, actor, argon2Hasher, u.id, u.version);
      expect(user).toMatchObject({ mustChangePassword: true, locked: false });
      const row = await tx.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(await argon2Hasher.verify(row.passwordHash, temporaryPassword)).toBe(true);
      expect(row.failedLoginCount).toBe(0);
      expect((await tx.session.findUniqueOrThrow({ where: { id: 'a'.repeat(64) } })).revokedAt).not.toBeNull();
      expect((await tx.passwordHistory.findFirstOrThrow({ where: { userId: u.id } })).passwordHash).toBe(oldHash);
      expect(JSON.stringify((await lastAudit(tx)).diff)).not.toContain(temporaryPassword);
    }));

  it('свой пароль сбросом не меняется; отключённому сначала нужно включить учётную запись', () =>
    inTx(async (tx) => {
      const { admin, actor } = await setup(tx);
      await expectCode(users.resetPassword(tx, actor, argon2Hasher, admin.id, admin.version), 'SELF_RESET');
      const off = await makeUser(tx, ['ib_staff'], { isActive: false });
      await expectCode(users.resetPassword(tx, actor, argon2Hasher, off.id, off.version), 'INACTIVE');
    }));

  it('разблокировка снимает блокировку без смены пароля', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      const u = await makeUser(tx, ['ib_staff'], { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 600_000) });
      const res = await users.unlock(tx, actor, u.id, u.version);
      expect(res.locked).toBe(false);
      expect((await tx.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBe('not-a-real-hash');
    }));

  it('отключение закрывает сессии; включение возвращает доступ', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      const u = await makeUser(tx, ['ib_staff']);
      await tx.session.create({ data: { id: 'b'.repeat(64), userId: u.id, expiresAt: new Date(Date.now() + 3_600_000) } });
      const off = await users.setActive(tx, actor, u.id, u.version, false);
      expect(off.isActive).toBe(false);
      expect((await tx.session.findUniqueOrThrow({ where: { id: 'b'.repeat(64) } })).revokedAt).not.toBeNull();
      const on = await users.setActive(tx, actor, u.id, off.version, true);
      expect(on.isActive).toBe(true);
      expect((await lastAudit(tx)).action).toBe('user.enabled');
    }));

  it('правка с устаревшей версией — 409', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      const u = await makeUser(tx, ['ib_staff']);
      await users.updateUser(tx, actor, u.id, { version: u.version, position: 'Ведущий специалист' });
      await expectCode(users.updateUser(tx, actor, u.id, { version: u.version, position: 'Другое' }), 'VERSION_CONFLICT');
    }));
});

describe('список пользователей', () => {
  it('пагинация по логину и поиск', () =>
    inTx(async (tx) => {
      await setup(tx);
      for (let i = 0; i < 5; i++) await makeUser(tx, ['ib_staff']);
      const total = await tx.user.count();
      const first = await users.listUsers(tx, { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBe(first.items[1]?.login);
      const all = [...first.items];
      for (let cursor = first.nextCursor; cursor; ) {
        const page = await users.listUsers(tx, { limit: 2, cursor });
        all.push(...page.items);
        cursor = page.nextCursor;
      }
      expect(all).toHaveLength(total);
      expect(new Set(all.map((u) => u.id)).size).toBe(total);
      const found = await users.listUsers(tx, { limit: 50, search: all[3]?.fullName });
      expect(found.items.map((u) => u.id)).toContain(all[3]?.id);
    }));
});
