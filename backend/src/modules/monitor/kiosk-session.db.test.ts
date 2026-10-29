// Настенный монитор по настоящему маршруту (релиз 1.2.0, ADR-0023): фоновый опрос не продлевает сессии людей,
// но киоск не завершается по бездействию — после 31 минуты без действий слайды приходят; чужой адрес — нет.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { parseIpList } from '../../lib/ip-list.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { SESSION_IDLE_MS } from '../../lib/session-token.js';
import { actorFor, inTx, makeUser, type Tx } from '../../test/db.js';
import { FakeClock, TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { setRolePermission } from '../roles/service.js';
import { updateUser } from '../users/service.js';

const PASSWORD = 'Kiosk-Test-Pass-2026';
const NGINX = '172.31.250.6';
const WALL = '10.20.30.40';

describe('сессия настенного монитора', () => {
  it('после 31 минуты одного фонового опроса /monitor отвечает слайдами; у сотрудника ИБ так же — 401', () =>
    inTx(async (tx) => {
      const hash = await argon2Hasher.hash(PASSWORD);
      const wall = await makeUser(tx, ['kiosk'], { passwordHash: hash });
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const clock = new FakeClock();
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' }, now: clock.now,
        trustProxy: NGINX, kioskAllowedIps: parseIpList(WALL),
      });
      const via = (extra: Record<string, string> = {}) => ({ remoteAddress: NGINX, headers: { 'x-forwarded-for': WALL, ...extra } });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD }, ...via() });
        expect(res.statusCode).toBe(200);
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const K = await login(wall.login);
      const S = await login(staff.login);
      for (let i = 0; i < 31; i++) {
        clock.advance(60_000);
        expect((await app.inject({ url: '/api/v1/monitor', ...via({ cookie: K, 'x-background': '1' }) })).statusCode).toBe(200);
      }
      const slides = await app.inject({ url: '/api/v1/monitor', ...via({ cookie: K, 'x-background': '1' }) });
      expect(slides.statusCode).toBe(200);
      expect(Array.isArray(slides.json().slides)).toBe(true);
      expect(SESSION_IDLE_MS).toBeLessThan(31 * 60_000);
      expect((await app.inject({ url: '/api/v1/monitor', ...via({ cookie: S, 'x-background': '1' }) })).statusCode).toBe(401);
    }));
});

describe('сессии монитора закрываются при снятии роли или права (7 суток только у монитора)', () => {
  async function wallWithSession(tx: Tx) {
    const wall = await makeUser(tx, ['kiosk']);
    const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
    const now = new Date();
    await tx.session.create({ data: { id: `s-${wall.id}`, userId: wall.id, expiresAt: new Date(now.getTime() + 7 * 86_400_000) } });
    const open = () => tx.session.count({ where: { userId: wall.id, revokedAt: null } });
    return { wall, admin, open };
  }

  it('сняли роль «Настенный монитор» у пользователя — его сессии закрыты; правка без смены ролей — нет', () =>
    inTx(async (tx) => {
      const x = await wallWithSession(tx);
      const u = await updateUser(tx, x.admin, x.wall.id, { version: x.wall.version, fullName: 'Монитор в холле' });
      expect(await x.open()).toBe(1);
      await updateUser(tx, x.admin, x.wall.id, { version: u.version, roleIds: [] });
      expect(await x.open()).toBe(0);
    }));

  it('сняли право «Настенный монитор» с роли — сессии её пользователей закрыты, в журнале — число', () =>
    inTx(async (tx) => {
      const x = await wallWithSession(tx);
      const role = await tx.role.create({ data: { code: `kiosk_${x.wall.id.slice(0, 8)}`, name: `Монитор ${x.wall.id.slice(0, 8)}`, permissions: { create: [{ permissionCode: 'monitor.kiosk' }] } } });
      await tx.userRole.deleteMany({ where: { userId: x.wall.id } });
      await tx.userRole.create({ data: { userId: x.wall.id, roleId: role.id } });
      await setRolePermission(tx, x.admin, role.id, 'monitor.kiosk', false);
      expect(await x.open()).toBe(0);
      const log = await tx.auditLog.findFirstOrThrow({ where: { action: 'role.permission.revoked', entityId: role.id } });
      expect((log.diff as { summary: string }).summary).toMatch(/закрыто сессий монитора: 1/);
    }));
});
