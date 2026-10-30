// Самооценка (этап Д5): подпись «Спроектировано» — правит только settings.manage (с записью в журнал),
// держатель assessment.manage только читает. HTTP — тем же приложением, что в бою; БД — транзакция с откатом.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { expectCode, inTx, makeUser, actorFor } from '../../test/db.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { getSignature, setSignature, SIGNATURE_DEFAULT } from './presentation.js';

const PASSWORD = 'Present-Test-Pass-2026';

describe('самооценка: подпись презентации (Д5)', () => {
  it('PUT — только settings.manage, с журналом; держатель «Самооценки» читает, но не меняет', () =>
    inTx(async (tx) => {
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL,
      });
      const hash = await argon2Hasher.hash(PASSWORD);
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const owner = await makeUser(tx, ['assessment'], { passwordHash: hash, fullName: 'Владелец самооценки' });
      const staff = await makeUser(tx, ['ib_staff', 'ib_head'], { passwordHash: hash });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        expect(res.statusCode).toBe(200);
        return { cookie: `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`, origin: TEST_PORTAL_URL };
      };
      const [A, O, S] = [await login(admin.login), await login(owner.login), await login(staff.login)];
      const { version } = await getSignature(tx);

      for (const h of [O, S]) {
        expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/presentation', headers: h, payload: { signature: 'Чужая подпись', version } })).statusCode).toBe(403);
        expect((await app.inject({ url: '/api/v1/settings/presentation', headers: h })).statusCode).toBe(403);
      }
      // Чтение для презентации — только держателю «Самооценки».
      expect((await app.inject({ url: '/api/v1/assessments/presentation-settings', headers: A })).statusCode).toBe(403);
      const before = await app.inject({ url: '/api/v1/assessments/presentation-settings', headers: O });
      expect(before.json()).toEqual({ signature: SIGNATURE_DEFAULT });

      const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/presentation', headers: A, payload: { signature: '  Отдел ИБ   ЗАО «Хумо» ', version } });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ signature: 'Отдел ИБ ЗАО «Хумо»', version: version + 1 });
      expect((await app.inject({ url: '/api/v1/assessments/presentation-settings', headers: O })).json()).toEqual({ signature: 'Отдел ИБ ЗАО «Хумо»' });
      const log = await tx.auditLog.findMany({ where: { action: 'settings.presentation.updated', userId: admin.id } });
      expect(log).toHaveLength(1);
      expect(log[0]?.diff).toMatchObject({ before: { signature: SIGNATURE_DEFAULT }, after: { signature: 'Отдел ИБ ЗАО «Хумо»' } });

      // Устаревшая версия — 409; пусто — 400.
      expect((await app.inject({ method: 'PUT', url: '/api/v1/settings/presentation', headers: A, payload: { signature: 'Ещё', version } })).statusCode).toBe(409);
      await expectCode(setSignature(tx, await actorFor(tx, admin.id), { signature: '   ', version: version + 1 }), 'EMPTY_SIGNATURE');
    }));
});
