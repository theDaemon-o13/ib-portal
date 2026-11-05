// Учётная запись настенного монитора (ADR-0012): вход и каждый запрос только с MONITOR_ALLOWED_IPS; срок сессии —
// общие правила 1.10.0 (7 суток убраны, ADR-0023); X-Forwarded-For принимается только от TRUSTED_PROXY_IPS.
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../app.js';
import { createPrisma } from '../../lib/db.js';
import { parseIpList } from '../../lib/ip-list.js';
import { FakeClock, TEST_PORTAL_URL, TEST_SECRET, fakeHasher } from '../../test/helpers.js';
import { MemoryAuditWriter } from '../audit/audit.js';
import { MemoryAuthRepository } from './repository.memory.js';

const PASSWORD = 'Wall-Monitor-2026!';
const NGINX = '172.31.250.6';
const WALL = '10.20.30.40';
const OTHER = '10.20.30.99';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let repo: MemoryAuthRepository;
let audit: MemoryAuditWriter;
let clock: FakeClock;
let app: App;

beforeEach(async () => {
  repo = new MemoryAuthRepository();
  audit = new MemoryAuditWriter();
  clock = new FakeClock();
  repo.addUser({ id: 'k1', login: 'wall', passwordHash: `hash:${PASSWORD}` }, ['monitor.kiosk']);
  repo.addUser({ id: 'u1', login: 'ivanov', passwordHash: `hash:${PASSWORD}` }, ['ib.work']);
  app = await buildApp({
    db: createPrisma('postgresql://unit:test@127.0.0.1:1/none'),
    repo, audit, hasher: fakeHasher(), sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, now: clock.now,
    trustProxy: NGINX,
    kioskAllowedIps: parseIpList(`${WALL}, 10.50.0.0/24`),
  });
});

/** Запрос «через nginx»: сокет — адрес nginx, nginx передаёт адрес клиента в X-Forwarded-For. */
function viaNginx(client: string, extra: Record<string, string> = {}) {
  return { remoteAddress: NGINX, headers: { 'x-forwarded-for': client, ...extra } };
}

async function login(loginName: string, from: { remoteAddress: string; headers: Record<string, string> }) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: loginName, password: PASSWORD }, ...from });
}

function cookieOf(res: Awaited<ReturnType<typeof login>>): string {
  const c = res.cookies.find((x) => x.name === 'ib_session');
  if (!c) throw new Error('нет cookie сессии');
  return `ib_session=${c.value}`;
}

describe('вход настенного монитора', () => {
  it('с разрешённого адреса — вход, в /me признак kiosk', async () => {
    const res = await login('wall', viaNginx(WALL));
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ login: 'wall', permissions: ['monitor.kiosk'], kiosk: true });
    const sub = await login('wall', viaNginx('10.50.0.17'));
    expect(sub.statusCode).toBe(200);
  });

  it('с чужого адреса — как неверный пароль, в журнале причина, блокировка не растёт', async () => {
    const res = await login('wall', viaNginx(OTHER));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.login_failed', userId: 'k1', diff: { reason: 'kiosk_ip_denied' }, ip: OTHER });
    expect(repo.users.get('k1')?.failedLoginCount).toBe(0);
    expect(repo.sessions.size).toBe(0);
  });

  it('пустой MONITOR_ALLOWED_IPS — вход киоска запрещён отовсюду', async () => {
    app = await buildApp({
      db: createPrisma('postgresql://unit:test@127.0.0.1:1/none'),
      repo, audit, hasher: fakeHasher(), sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, now: clock.now, trustProxy: NGINX, kioskAllowedIps: parseIpList(''),
    });
    expect((await login('wall', viaNginx(WALL))).statusCode).toBe(401);
    // Обычный пользователь входит как раньше.
    expect((await login('ivanov', viaNginx(OTHER))).statusCode).toBe(200);
  });

  it('подделанный X-Forwarded-For не помогает', async () => {
    // Клиент напрямую (не через nginx) с заголовком разрешённого адреса: заголовку не верим.
    const direct = await login('wall', { remoteAddress: OTHER, headers: { 'x-forwarded-for': WALL } });
    expect(direct.statusCode).toBe(401);
    // Через nginx, который дописывает адрес к присланному заголовку: берётся адрес, добавленный nginx.
    const appended = await login('wall', { remoteAddress: NGINX, headers: { 'x-forwarded-for': `${WALL}, ${OTHER}` } });
    expect(appended.statusCode).toBe(401);
    expect(audit.entries.filter((e) => e.diff && (e.diff as { reason?: string }).reason === 'kiosk_ip_denied').map((e) => e.ip)).toEqual([OTHER, OTHER]);
  });
});

describe('сессия настенного монитора', () => {
  it('общие правила 1.10.0: без отдельных 7 суток — сессия жива и через 10 суток; срок задаёт maxDays', async () => {
    const cookie = cookieOf(await login('wall', viaNginx(WALL)));
    clock.advance(10 * DAY);
    expect((await app.inject({ url: '/api/v1/auth/me', ...viaNginx(WALL, { cookie }) })).statusCode).toBe(200);
    repo.sessionSettings = { maxDays: 10, adminMaxHours: 12 };
    const late = await app.inject({ url: '/api/v1/auth/me', ...viaNginx(WALL, { cookie }) });
    expect(late.statusCode).toBe(401);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.session_expired', diff: { reason: 'max_age' } });
  });

  it('фоновый опрос слайдов часами — сессия жива; остатка до завершения в заголовке нет', async () => {
    const cookie = cookieOf(await login('wall', viaNginx(WALL)));
    for (let i = 0; i < 4; i++) {
      clock.advance(40 * MINUTE);
      const r = await app.inject({ url: '/api/v1/auth/me', ...viaNginx(WALL, { cookie, 'x-background': '1' }) });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-session-idle-ms']).toBeUndefined();
    }
  });

  it('у обычного пользователя нет общего срока 12 часов и завершения по бездействию', async () => {
    const cookie = cookieOf(await login('ivanov', viaNginx(OTHER)));
    clock.advance(13 * 60 * MINUTE);
    expect((await app.inject({ url: '/api/v1/auth/me', ...viaNginx(OTHER, { cookie }) })).statusCode).toBe(200);
  });

  it('смена пароля монитора закрывает его остальные сессии', async () => {
    const wallScreen = cookieOf(await login('wall', viaNginx(WALL)));
    const second = cookieOf(await login('wall', viaNginx(WALL)));
    const changed = await app.inject({
      method: 'POST', url: '/api/v1/auth/change-password', ...viaNginx(WALL, { cookie: second }),
      payload: { currentPassword: PASSWORD, newPassword: 'Screen-Kiosk-Pass-77' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await app.inject({ url: '/api/v1/auth/me', ...viaNginx(WALL, { cookie: wallScreen }) })).statusCode).toBe(401);
  });

  it('сессия, перенесённая на другой адрес, закрывается и пишется в журнал', async () => {
    const cookie = cookieOf(await login('wall', viaNginx(WALL)));
    const moved = await app.inject({ url: '/api/v1/auth/me', ...viaNginx(OTHER, { cookie }) });
    expect(moved.statusCode).toBe(401);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.kiosk_ip_denied', ip: OTHER });
    // Закрыта насовсем: с разрешённого адреса эта cookie тоже больше не действует.
    expect((await app.inject({ url: '/api/v1/auth/me', ...viaNginx(WALL, { cookie }) })).statusCode).toBe(401);
  });

  it('другие разделы API киоску закрыты, выход доступен', async () => {
    const cookie = cookieOf(await login('wall', viaNginx(WALL)));
    const docs = await app.inject({ url: '/api/v1/documents', ...viaNginx(WALL, { cookie }) });
    expect(docs.statusCode).toBe(403);
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', ...viaNginx(WALL, { cookie }) });
    expect(out.statusCode).toBe(204);
  });
});
