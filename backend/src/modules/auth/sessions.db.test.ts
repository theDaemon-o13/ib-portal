// Сессии 1.10.0 на настоящем PostgreSQL (ADR-0023, «Изменено в 1.10.0»): «Запомнить меня», параметр срока
// в app_settings, срок администратора, «Мои сессии» по public_id, завершение сессий администратором.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { SESSION_SETTINGS_KEY } from '../../lib/session-token.js';
import { actorFor, inTx, makeUser, type Tx } from '../../test/db.js';
import { FakeClock, TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { updatePortalParam } from '../settings/portal-params.js';
import { prismaAuthRepository } from './repository.prisma.js';

const PASSWORD = 'Session-Test-Pass-2026';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function setup(tx: Tx) {
  const hash = await argon2Hasher.hash(PASSWORD);
  const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
  const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
  const clock = new FakeClock();
  const app = await buildApp({
    db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
    sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' }, now: clock.now,
  });
  const login = async (l: string, remember: boolean) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD, remember } });
    expect(res.statusCode, res.body).toBe(200);
    return { res, cookie: `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}` };
  };
  const me = (cookie: string) => app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
  return { staff, admin, clock, app, login, me };
}

describe('сессии 1.10.0', () => {
  it('«Запомнить меня» сохраняется в sessions.remember; в «Моих сессиях» — public_id, а не хэш токена', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const a = await x.login(x.staff.login, true);
      await x.login(x.staff.login, false);
      const rows = await tx.session.findMany({ where: { userId: x.staff.id }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => r.remember).sort()).toEqual([false, true]);
      const list = await x.app.inject({ url: '/api/v1/auth/sessions', headers: { cookie: a.cookie } });
      expect(list.statusCode, list.body).toBe(200);
      const items = list.json().items as { id: string; current: boolean }[];
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.id).sort()).toEqual(rows.map((r) => r.publicId).sort());
      expect(JSON.stringify(list.json())).not.toContain(rows[0]?.id);
      x.clock.advance(60 * DAY);
      expect((await x.me(a.cookie)).statusCode).toBe(200);
    }));

  it('параметр auth.session из «Параметров портала»: maxDays закрывает сессии старше срока, неверное значение не сохраняется', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const s = await x.login(x.staff.login, true);
      const actor = await actorFor(tx, x.admin.id);
      await expect(updatePortalParam(tx, actor, SESSION_SETTINGS_KEY, { value: { maxDays: -1, adminMaxHours: 12 }, version: 0 })).rejects.toMatchObject({ statusCode: 400 });
      await updatePortalParam(tx, actor, SESSION_SETTINGS_KEY, { value: { maxDays: 3, adminMaxHours: 12 }, version: 0 });
      x.clock.advance(3 * DAY);
      expect((await x.me(s.cookie)).statusCode).toBe(401);
      const log = await tx.auditLog.findFirstOrThrow({ where: { action: 'auth.session_expired', userId: x.staff.id } });
      expect(log.diff).toMatchObject({ reason: 'max_age' });
    }));

  it('супер-администратор (users.manage): без «Запомнить меня», 12 часов; администратор завершает сессии сотрудника', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const adm = await x.login(x.admin.login, true);
      expect(adm.res.json().session).toMatchObject({ remember: false, admin: true, adminMaxHours: 12 });
      expect((await tx.session.findFirstOrThrow({ where: { userId: x.admin.id } })).remember).toBe(false);
      const staffA = await x.login(x.staff.login, true);
      const staffB = await x.login(x.staff.login, true);
      const seen = await x.app.inject({ url: `/api/v1/users/${x.staff.id}/sessions`, headers: { cookie: adm.cookie } });
      expect(seen.json().items).toHaveLength(2);
      const all = await x.app.inject({ method: 'POST', url: `/api/v1/users/${x.staff.id}/sessions/revoke-all`, headers: { cookie: adm.cookie } });
      expect(all.json()).toEqual({ revoked: 2 });
      expect((await x.me(staffA.cookie)).statusCode).toBe(401);
      expect((await x.me(staffB.cookie)).statusCode).toBe(401);
      const log = await tx.auditLog.findFirstOrThrow({ where: { action: 'user.sessions_revoked', entityId: x.staff.id } });
      expect(log.userId).toBe(x.admin.id);
      x.clock.advance(12 * HOUR);
      expect((await x.me(adm.cookie)).statusCode).toBe(401);
    }));
});
