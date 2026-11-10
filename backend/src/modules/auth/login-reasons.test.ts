// Причины отказа во входе (1.13.7): пользователю — один и тот же ответ, причина — в журнале и строкой warn в логе.
// Пароль и его производные (хеш) в лог не попадают ни при какой причине; неизвестный логин в логе — в маске.
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../app.js';
import { createPrisma } from '../../lib/db.js';
import { parseIpList } from '../../lib/ip-list.js';
import { LOG_REDACT } from '../../lib/log-redact.js';
import { FakeClock, TEST_PORTAL_URL, TEST_SECRET, fakeHasher } from '../../test/helpers.js';
import { MemoryAuditWriter } from '../audit/audit.js';
import { loginFailureSummary, maskLogin } from './reasons.js';
import { MemoryAuthRepository } from './repository.memory.js';

const PASSWORD = 'Wall-Monitor-2026!';
const WRONG = 'Wrong-Secret-2026#';
const NGINX = '172.31.250.6';
const WALL = '10.20.30.40';
const OTHER = '10.20.30.99';
const ADMIN_PC = '10.9.9.9';

let repo: MemoryAuthRepository;
let audit: MemoryAuditWriter;
let lines: string[];
let app: App;

beforeEach(async () => {
  repo = new MemoryAuthRepository();
  audit = new MemoryAuditWriter();
  lines = [];
  repo.addUser({ id: 'k1', login: 'wall', passwordHash: `hash:${PASSWORD}` }, ['monitor.kiosk']);
  repo.addUser({ id: 'u1', login: 'ivanov', passwordHash: `hash:${PASSWORD}` }, ['ib.work']);
  repo.addUser({ id: 'u2', login: 'petrova', passwordHash: `hash:${PASSWORD}`, isActive: false }, ['ib.work']);
  repo.addUser({ id: 'a1', login: 'admin', passwordHash: `hash:${PASSWORD}` }, ['users.manage']);
  app = await buildApp({
    db: createPrisma('postgresql://unit:test@127.0.0.1:1/none'),
    repo, audit, hasher: fakeHasher(), sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, now: new FakeClock().now,
    trustProxy: NGINX,
    kioskAllowedIps: parseIpList(WALL),
    adminAllowedIps: parseIpList(ADMIN_PC),
    // Настоящий pino с теми же настройками вырезания, что на сервере; строки — в массив.
    logger: { level: 'info', redact: LOG_REDACT, stream: { write: (s: string) => { lines.push(s); } } },
  });
});

const tryLogin = (login: string, password: string, client: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password }, remoteAddress: NGINX, headers: { 'x-forwarded-for': client } });

const warns = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === 'auth.login_rejected');
const lastFailure = () => audit.entries.filter((e) => e.action === 'auth.login_failed').at(-1);
const UNIFORM = { error: { code: 'INVALID_CREDENTIALS', message: 'Неверный логин или пароль' } };

describe('отказ во входе: одинаковый ответ, причина — в журнале и в логе (1.13.7)', () => {
  it.each([
    ['unknown_user', 'nobody', PASSWORD, OTHER, 'no… (6 симв.)'],
    ['wrong_password', 'ivanov', WRONG, OTHER, 'ivanov'],
    ['inactive', 'petrova', PASSWORD, OTHER, 'petrova'],
    ['kiosk_ip_denied', 'wall', PASSWORD, OTHER, 'wall'],
    ['admin_ip_denied', 'admin', PASSWORD, OTHER, 'admin'],
  ])('%s: 401 «Неверный логин или пароль», reason в журнале, строка warn с IP', async (reason, login, password, client, logged) => {
    const res = await tryLogin(login, password, client);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(UNIFORM);
    expect(lastFailure()).toMatchObject({ diff: { login, reason }, ip: client });
    const w = warns();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 40, msg: 'вход отклонён', reason, login: logged, ip: client });
  });

  it('тот же монитор с разрешённого адреса входит; строки warn нет', async () => {
    expect((await tryLogin('wall', PASSWORD, WALL)).statusCode).toBe(200);
    expect(warns()).toEqual([]);
  });

  it('wrong_password: номер попытки в журнале и в логе; после 5-й — 423 и locked, тоже строкой warn', async () => {
    for (let i = 1; i <= 5; i += 1) await tryLogin('ivanov', WRONG, OTHER);
    expect(warns().map((w) => [w.reason, w.attempt])).toEqual([1, 2, 3, 4, 5].map((n) => ['wrong_password', n]));
    const locked = await tryLogin('ivanov', PASSWORD, OTHER);
    expect(locked.statusCode).toBe(423);
    expect(lastFailure()).toMatchObject({ diff: { reason: 'locked' } });
    expect(warns().at(-1)).toMatchObject({ reason: 'locked', login: 'ivanov', ip: OTHER });
  });

  it('пароль в поле логина: в логе только маска — первые 2 символа и длина', async () => {
    await tryLogin(PASSWORD, 'whatever-123', OTHER);
    const w = warns()[0];
    expect(w).toMatchObject({ reason: 'unknown_user', login: `wa… (${PASSWORD.length} симв.)` });
    expect(lines.join('\n').toLowerCase()).not.toContain(PASSWORD.toLowerCase());
  });

  it('ни при одной причине пароль, введённый пароль и хеш не попадают в лог', async () => {
    await tryLogin('nobody', PASSWORD, OTHER);
    await tryLogin('ivanov', WRONG, OTHER);
    await tryLogin('petrova', PASSWORD, OTHER);
    await tryLogin('wall', PASSWORD, OTHER);
    await tryLogin('admin', PASSWORD, OTHER);
    for (let i = 0; i < 5; i += 1) await tryLogin('ivanov', WRONG, OTHER);
    await tryLogin('ivanov', PASSWORD, OTHER);
    await tryLogin('wall', PASSWORD, WALL);
    const all = lines.join('\n');
    expect(warns().length).toBeGreaterThanOrEqual(10);
    for (const secret of [PASSWORD, WRONG, `hash:${PASSWORD}`, 'passwordHash', '"password"']) expect(all).not.toContain(secret);
  });
});

describe('подписи причин (1.13.7)', () => {
  it('маска логина: первые 2 символа и длина; короткий — только длина', () => {
    expect(maskLogin('ivanov')).toBe('iv… (6 симв.)');
    expect(maskLogin('ab')).toBe('… (2 симв.)');
    expect(maskLogin('Пароль-2026')).toBe('Па… (11 симв.)');
  });

  it('подпись «Журнала» из diff: логин полностью, у unknown_user — в маске; неизвестная причина — нет подписи', () => {
    expect(loginFailureSummary({ login: 'wall', reason: 'kiosk_ip_denied' }))
      .toBe('Неудачный вход «wall»: адрес не разрешён для настенного монитора (MONITOR_ALLOWED_IPS)');
    expect(loginFailureSummary({ login: 'ivanov', reason: 'wrong_password', attempt: 2 })).toBe('Неудачный вход «ivanov»: неверный пароль (попытка 2)');
    expect(loginFailureSummary({ login: 'Secret-Pass-1', reason: 'unknown_user' })).toBe('Неудачный вход «Se… (13 симв.)»: логин не найден');
    expect(loginFailureSummary({ login: 'petrova', reason: 'inactive' })).toBe('Неудачный вход «petrova»: учётная запись отключена');
    expect(loginFailureSummary({ login: 'ivanov', reason: 'locked' })).toBe('Неудачный вход «ivanov»: вход заблокирован после неудачных попыток');
    expect(loginFailureSummary({ login: 'admin', reason: 'admin_ip_denied' })).toBe('Неудачный вход «admin»: адрес не разрешён для администратора (ADMIN_ALLOWED_IPS)');
    expect(loginFailureSummary({ login: 'x', reason: 'something_else' })).toBeNull();
  });
});
