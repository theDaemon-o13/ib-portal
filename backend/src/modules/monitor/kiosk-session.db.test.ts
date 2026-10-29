// Настенный монитор по настоящему маршруту (релиз 1.2.0, ADR-0023): фоновый опрос не продлевает сессии людей,
// но киоск не завершается по бездействию — после 31 минуты без действий слайды приходят; чужой адрес — нет.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { parseIpList } from '../../lib/ip-list.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { SESSION_IDLE_MS } from '../../lib/session-token.js';
import { inTx, makeUser } from '../../test/db.js';
import { FakeClock, TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';

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
