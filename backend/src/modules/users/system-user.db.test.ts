// Служебная учётная запись «Портал» (1.14.0, ADR-0053): создаёт seed, отключена, без ролей; в списке пользователей её
// нет; правка, включение, сброс пароля, разблокировка, отметка «Начальник ИБ» — 409 SYSTEM_USER; войти нельзя.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { SYSTEM_USER_LOGIN } from '../../lib/system-user.js';
import { actorFor, expectCode, inTx, makeUser } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as users from './service.js';

describe('служебная учётная запись «Портал» (1.14.0)', () => {
  it('есть после seed; не в списке; изменить нельзя; войти нельзя', () =>
    inTx(async (tx) => {
      const sys = await tx.user.findUniqueOrThrow({ where: { login: SYSTEM_USER_LOGIN }, include: { roles: true } });
      expect(sys).toMatchObject({ fullName: 'Портал', isActive: false, roles: [] });
      expect(await tx.seedMarker.findUnique({ where: { key: 'system.portal_user.v1_14_0' } })).toBeTruthy();

      const admin = await makeUser(tx, ['super_admin']);
      const actor = await actorFor(tx, admin.id);
      const list = await users.listUsers(tx, { limit: 500 });
      expect(list.items.some((u) => u.login === SYSTEM_USER_LOGIN)).toBe(false);
      expect((await users.listUsers(tx, { limit: 500, search: 'portal' })).items.some((u) => u.login === SYSTEM_USER_LOGIN)).toBe(false);

      await expectCode(users.updateUser(tx, actor, sys.id, { version: sys.version, fullName: 'Другое' }), 'SYSTEM_USER');
      await expectCode(users.setActive(tx, actor, sys.id, sys.version, true), 'SYSTEM_USER');
      await expectCode(users.resetPassword(tx, actor, argon2Hasher, sys.id, sys.version), 'SYSTEM_USER');
      await expectCode(users.unlock(tx, actor, sys.id, sys.version), 'SYSTEM_USER');
      await expectCode(users.setIbHead(tx, actor, sys.id, { version: sys.version, value: true }), 'SYSTEM_USER');
      expect(await tx.user.findUniqueOrThrow({ where: { id: sys.id } })).toMatchObject({ isActive: false, fullName: 'Портал', version: sys.version });

      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL });
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: SYSTEM_USER_LOGIN, password: 'Any-Password-2026-X' } });
      expect(res.statusCode).toBe(401);
    }));
});
