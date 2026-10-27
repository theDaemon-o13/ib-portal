// Вход администраторов (settings.manage, users.manage) только с ADMIN_ALLOWED_IPS (ADR-0015):
// при входе и на каждом запросе; пусто — без ограничения.
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../app.js';
import { createPrisma } from '../../lib/db.js';
import { parseIpList } from '../../lib/ip-list.js';
import { FakeClock, TEST_SECRET, fakeHasher } from '../../test/helpers.js';
import { MemoryAuditWriter } from '../audit/audit.js';
import { MemoryAuthRepository } from './repository.memory.js';

const PASSWORD = 'Admin-Password-2026!';
const NGINX = '172.31.250.6';
const ADMIN_PC = '10.20.30.40';
const OTHER = '10.20.30.99';

let repo: MemoryAuthRepository;
let audit: MemoryAuditWriter;
let app: App;

async function build(adminIps: string) {
  return buildApp({
    db: createPrisma('postgresql://unit:test@127.0.0.1:1/none'),
    repo, audit, hasher: fakeHasher(), sessionSecret: TEST_SECRET, now: new FakeClock().now,
    trustProxy: NGINX,
    adminAllowedIps: parseIpList(adminIps),
  });
}

beforeEach(async () => {
  repo = new MemoryAuthRepository();
  audit = new MemoryAuditWriter();
  repo.addUser({ id: 'a1', login: 'admin', passwordHash: `hash:${PASSWORD}` }, ['ib.work', 'users.manage']);
  repo.addUser({ id: 's1', login: 'settings', passwordHash: `hash:${PASSWORD}` }, ['settings.manage']);
  repo.addUser({ id: 'u1', login: 'ivanov', passwordHash: `hash:${PASSWORD}` }, ['ib.work']);
  app = await build(`${ADMIN_PC}, 10.50.0.0/24`);
});

const viaNginx = (client: string, extra: Record<string, string> = {}) =>
  ({ remoteAddress: NGINX, headers: { 'x-forwarded-for': client, ...extra } });

const login = (name: string, from: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password: PASSWORD }, ...viaNginx(from) });

function cookieOf(res: Awaited<ReturnType<typeof login>>): string {
  const c = res.cookies.find((x) => x.name === 'ib_session');
  if (!c) throw new Error('нет cookie сессии');
  return `ib_session=${c.value}`;
}

describe('ADMIN_ALLOWED_IPS: вход', () => {
  it('администратор с рабочего места и из подсети входит', async () => {
    expect((await login('admin', ADMIN_PC)).statusCode).toBe(200);
    expect((await login('settings', '10.50.0.7')).statusCode).toBe(200);
  });

  it('с чужого адреса — как неверный пароль, причина в журнале, блокировка не растёт', async () => {
    const res = await login('admin', OTHER);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.login_failed', userId: 'a1', diff: { reason: 'admin_ip_denied' }, ip: OTHER });
    expect(repo.users.get('a1')?.failedLoginCount).toBe(0);
    expect(repo.sessions.size).toBe(0);
    expect((await login('settings', OTHER)).statusCode).toBe(401);
  });

  it('обычный пользователь входит откуда угодно', async () => {
    expect((await login('ivanov', OTHER)).statusCode).toBe(200);
  });

  it('пустой список — без ограничения', async () => {
    app = await build('');
    expect((await login('admin', OTHER)).statusCode).toBe(200);
  });
});

describe('ADMIN_ALLOWED_IPS: каждый запрос', () => {
  it('сессия администратора, перенесённая на другой адрес, закрывается насовсем', async () => {
    const cookie = cookieOf(await login('admin', ADMIN_PC));
    const moved = await app.inject({ url: '/api/v1/auth/me', ...viaNginx(OTHER, { cookie }) });
    expect(moved.statusCode).toBe(401);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.admin_ip_denied', ip: OTHER });
    expect((await app.inject({ url: '/api/v1/auth/me', ...viaNginx(ADMIN_PC, { cookie }) })).statusCode).toBe(401);
  });

  it('права администратора, выданные уже вошедшему с чужого адреса, закрывают сессию', async () => {
    const cookie = cookieOf(await login('ivanov', OTHER));
    expect((await app.inject({ url: '/api/v1/auth/me', ...viaNginx(OTHER, { cookie }) })).statusCode).toBe(200);
    repo.permissions.set('u1', ['ib.work', 'settings.manage']);
    expect((await app.inject({ url: '/api/v1/auth/me', ...viaNginx(OTHER, { cookie }) })).statusCode).toBe(401);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.admin_ip_denied', userId: 'u1' });
  });
});
