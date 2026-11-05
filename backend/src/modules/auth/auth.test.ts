import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../app.js';
import { createPrisma } from '../../lib/db.js';
import { LOCK_DURATION_MS } from '../../lib/lockout.js';
import { REMEMBER_COOKIE_MAX_AGE_S, SESSION_TOUCH_INTERVAL_MS } from '../../lib/session-token.js';
import { FakeClock, TEST_PORTAL_URL, TEST_SECRET, fakeHasher } from '../../test/helpers.js';
import { MemoryAuditWriter } from '../audit/audit.js';
import { MemoryAuthRepository } from './repository.memory.js';

const PASSWORD = 'Initial-Pass-2026';

let repo: MemoryAuthRepository;
let audit: MemoryAuditWriter;
let hasher: ReturnType<typeof fakeHasher>;
let clock: FakeClock;
let app: App;

beforeEach(async () => {
  repo = new MemoryAuthRepository();
  audit = new MemoryAuditWriter();
  hasher = fakeHasher();
  clock = new FakeClock();
  repo.addUser({ id: 'u1', login: 'ivanov', fullName: 'И. Иванов', passwordHash: `hash:${PASSWORD}` }, ['ib.work']);
  // Маршруты настроек здесь не вызываются: клиент без подключения к базе.
  app = await buildApp({ db: createPrisma('postgresql://unit:test@127.0.0.1:1/none'), repo, audit, hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, now: clock.now });
});

async function login(loginName: string, password: string, remember?: boolean) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: loginName, password, ...(remember === undefined ? {} : { remember }) } });
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const me = (cookie: string, extra: Record<string, string> = {}) => app.inject({ url: '/api/v1/auth/me', headers: { cookie, ...extra } });

function sessionCookie(res: Awaited<ReturnType<typeof login>>): string {
  const c = res.cookies.find((x) => x.name === 'ib_session');
  if (!c) throw new Error('нет cookie сессии');
  return `ib_session=${c.value}`;
}

describe('вход и сессия', () => {
  it('успешный вход ставит безопасную cookie и пишет аудит', async () => {
    const res = await login('Ivanov ', PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ login: 'ivanov', permissions: ['ib.work'], mustChangePassword: false });

    const c = res.cookies.find((x) => x.name === 'ib_session');
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(audit.actions()).toEqual(['auth.login']);

    // В БД лежит хэш токена, а не сам токен.
    const [stored] = [...repo.sessions.keys()];
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(c?.value).not.toContain(stored);
  });

  it('/me без cookie — 401, с cookie — пользователь', async () => {
    expect((await app.inject({ url: '/api/v1/auth/me' })).statusCode).toBe(401);
    const cookie = sessionCookie(await login('ivanov', PASSWORD));
    const me = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.login).toBe('ivanov');
  });

  it('неизвестный логин — тот же ответ, что и неверный пароль', async () => {
    const typedPassword = 'Typed-Secret-9431';
    const unknown = await login('nobody', typedPassword);
    const wrong = await login('ivanov', typedPassword);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
    expect(audit.entries[0]).toMatchObject({ action: 'auth.login_failed', userId: null, diff: { reason: 'unknown_user' } });
    // Введённый пароль в журнал аудита не попадает.
    expect(JSON.stringify(audit.entries)).not.toContain(typedPassword);
  });

  it('5 неудачных попыток блокируют вход на 15 минут, пароль при этом не проверяется', async () => {
    for (let i = 1; i <= 4; i++) expect((await login('ivanov', 'bad')).statusCode).toBe(401);
    const fifth = await login('ivanov', 'bad');
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json().error.code).toBe('ACCOUNT_LOCKED');
    expect(audit.actions()).toContain('auth.locked');

    const verifyBefore = hasher.verifyCalls;
    const correctWhileLocked = await login('ivanov', PASSWORD);
    expect(correctWhileLocked.statusCode).toBe(423);
    expect(hasher.verifyCalls).toBe(verifyBefore);

    clock.advance(LOCK_DURATION_MS);
    expect((await login('ivanov', PASSWORD)).statusCode).toBe(200);
    expect(repo.users.get('u1')?.failedLoginCount).toBe(0);
  });

  it('«Запомнить меня»: постоянная cookie, сессия жива через 30 дней без активности и после перезапуска браузера', async () => {
    const res = await login('ivanov', PASSWORD, true);
    expect(res.json().session).toEqual({ remember: true, admin: false, adminMaxHours: null, expiresAt: null });
    const c = res.cookies.find((x) => x.name === 'ib_session');
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', maxAge: REMEMBER_COOKIE_MAX_AGE_S });
    const cookie = sessionCookie(res);
    clock.advance(30 * DAY);
    // «Перезапуск браузера»: тот же токен из постоянной cookie, нового входа нет.
    expect((await me(cookie)).statusCode).toBe(200);
    clock.advance(200 * DAY);
    expect((await me(cookie)).statusCode).toBe(200);
    expect(audit.actions()).not.toContain('auth.session_expired');
  });

  it('без галочки — cookie до закрытия браузера, по бездействию сессия не завершается', async () => {
    const res = await login('ivanov', PASSWORD, false);
    const c = res.cookies.find((x) => x.name === 'ib_session');
    expect(c?.maxAge).toBeUndefined();
    expect(c?.expires).toBeUndefined();
    const cookie = sessionCookie(res);
    clock.advance(3 * HOUR);
    expect((await me(cookie)).statusCode).toBe(200);
    clock.advance(40 * DAY);
    expect((await me(cookie)).statusCode).toBe(200);
    // Заголовка с остатком до завершения по бездействию больше нет.
    expect((await me(cookie)).headers['x-session-idle-ms']).toBeUndefined();
  });

  it('параметр maxDays > 0 закрывает сессию старше N дней — и открытую до изменения параметра', async () => {
    const before = sessionCookie(await login('ivanov', PASSWORD, true));
    clock.advance(5 * DAY);
    repo.sessionSettings = { maxDays: 7, adminMaxHours: 12 };
    const after = sessionCookie(await login('ivanov', PASSWORD, true));
    clock.advance(2 * DAY - 1000);
    expect((await me(before)).statusCode).toBe(200);
    clock.advance(1000);
    expect((await me(before)).statusCode).toBe(401);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.session_expired', diff: { reason: 'max_age' } });
    expect((await me(after)).statusCode).toBe(200);
    clock.advance(5 * DAY);
    expect((await me(after)).statusCode).toBe(401);
  });

  it('администратор (users.manage): галочка не действует, сессия — 12 часов от входа, параметр меняет срок', async () => {
    repo.addUser({ id: 'a1', login: 'admin', passwordHash: `hash:${PASSWORD}` }, ['users.manage', 'settings.manage']);
    const res = await login('admin', PASSWORD, true);
    expect(res.json().session).toMatchObject({ remember: false, admin: true, adminMaxHours: 12 });
    expect(res.cookies.find((x) => x.name === 'ib_session')?.maxAge).toBeUndefined();
    expect([...repo.sessions.values()].at(-1)?.remember).toBe(false);
    const cookie = sessionCookie(res);
    clock.advance(12 * HOUR - 1000);
    expect((await me(cookie)).statusCode).toBe(200);
    clock.advance(1000);
    expect((await me(cookie)).statusCode).toBe(401);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.session_expired', diff: { reason: 'admin_max_age' } });

    repo.sessionSettings = { maxDays: 0, adminMaxHours: 2 };
    const short = sessionCookie(await login('admin', PASSWORD, true));
    clock.advance(2 * HOUR);
    expect((await me(short)).statusCode).toBe(401);
  });

  it('служебная роль «Администратор портала» — тоже 12 часов без «Запомнить меня»', async () => {
    repo.addUser({ id: 'p1', login: 'portal.admin', passwordHash: `hash:${PASSWORD}` }, ['settings.manage', 'users.manage']);
    repo.roleCodes.set('p1', ['portal_admin']);
    const res = await login('portal.admin', PASSWORD, true);
    expect(res.json().session).toMatchObject({ remember: false, admin: true });
    const cookie = sessionCookie(res);
    clock.advance(12 * HOUR);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('право администратора выдано посреди сессии — срок 12 часов от входа действует сразу', async () => {
    const cookie = sessionCookie(await login('ivanov', PASSWORD, true));
    clock.advance(13 * HOUR);
    expect((await me(cookie)).statusCode).toBe(200);
    repo.permissions.set('u1', ['ib.work', 'users.manage']);
    expect((await me(cookie)).statusCode).toBe(401);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.session_expired', diff: { reason: 'admin_max_age' } });
  });

  it('сессия до 1.10.0 (expires_at = вход + 12 часов) закрывается по своему сроку', async () => {
    const cookie = sessionCookie(await login('ivanov', PASSWORD, true));
    const s = [...repo.sessions.values()].at(-1);
    if (!s) throw new Error('нет сессии');
    s.expiresAt = new Date(s.createdAt.getTime() + 12 * HOUR);
    clock.advance(12 * HOUR);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('последняя активность — не чаще раза в 5 минут; фоновые запросы её не трогают; постоянная cookie продлевается', async () => {
    const cookie = sessionCookie(await login('ivanov', PASSWORD, true));
    const s = [...repo.sessions.values()].at(-1);
    const started = s?.lastSeenAt.getTime();
    clock.advance(SESSION_TOUCH_INTERVAL_MS - 1000);
    const early = await me(cookie);
    expect(s?.lastSeenAt.getTime()).toBe(started);
    expect(early.cookies.find((x) => x.name === 'ib_session')).toBeUndefined();
    clock.advance(1000);
    const bg = await me(cookie, { 'x-background': '1' });
    expect(s?.lastSeenAt.getTime()).toBe(started);
    expect(bg.cookies.find((x) => x.name === 'ib_session')).toBeUndefined();
    const active = await me(cookie);
    expect(s?.lastSeenAt.getTime()).toBe(clock.now().getTime());
    expect(active.cookies.find((x) => x.name === 'ib_session')).toMatchObject({ maxAge: REMEMBER_COOKIE_MAX_AGE_S });
  });

  it('выход закрывает сессию', async () => {
    const cookie = sessionCookie(await login('ivanov', PASSWORD));
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
    expect(audit.actions()).toEqual(['auth.login', 'auth.logout']);
  });

  it('поддельная подпись cookie не принимается', async () => {
    const res = await app.inject({ url: '/api/v1/auth/me', headers: { cookie: 'ib_session=abc.def' } });
    expect(res.statusCode).toBe(401);
  });

  it('изменяющий запрос с чужого Origin отклоняется', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example', host: 'portal.local' },
      payload: { login: 'ivanov', password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BAD_ORIGIN');
  });

  it('Origin сверяется с PORTAL_URL, а не с заголовком Host: совпадение с поддельным Host не помогает', async () => {
    const spoofed = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example', host: 'evil.example' },
      payload: { login: 'ivanov', password: PASSWORD },
    });
    expect(spoofed.statusCode).toBe(403);
    expect(spoofed.json().error.code).toBe('BAD_ORIGIN');
    // Тот же хост, другая схема или порт — тоже чужой источник.
    for (const origin of ['http://portal.test', 'https://portal.test:8443']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin, host: 'portal.test' }, payload: { login: 'ivanov', password: PASSWORD } });
      expect(res.statusCode, origin).toBe(403);
    }
    expect(audit.actions()).toEqual([]);

    // Origin портала проходит при любом Host (nginx может передать его без порта или с внутренним именем).
    const own = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { origin: TEST_PORTAL_URL, host: 'backend:3000' },
      payload: { login: 'ivanov', password: PASSWORD },
    });
    expect(own.statusCode).toBe(200);
  });
});

describe('«Мои сессии» и сессии пользователя (1.10.0)', () => {
  const list = (cookie: string) => app.inject({ url: '/api/v1/auth/sessions', headers: { cookie } });

  it('открытые сессии с отметкой текущей; в ответе public_id, не хэш токена', async () => {
    await login('ivanov', PASSWORD, true);
    const second = sessionCookie(await login('ivanov', PASSWORD, false));
    const res = await list(second);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { id: string; current: boolean; remember: boolean }[];
    expect(items).toHaveLength(2);
    expect(items.filter((x) => x.current)).toHaveLength(1);
    expect(items.find((x) => x.current)?.remember).toBe(false);
    for (const x of items) {
      expect(x.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(repo.sessions.has(x.id)).toBe(false);
    }
  });

  it('«Завершить все, кроме текущей» и «Завершить» одну; текущую — 409, чужую — 404', async () => {
    const first = sessionCookie(await login('ivanov', PASSWORD, true));
    const second = sessionCookie(await login('ivanov', PASSWORD, true));
    const third = sessionCookie(await login('ivanov', PASSWORD, true));
    const items = (await list(third)).json().items as { id: string; current: boolean }[];
    const current = items.find((x) => x.current);
    if (!current) throw new Error('нет текущей');
    expect((await app.inject({ method: 'POST', url: `/api/v1/auth/sessions/${current.id}/revoke`, headers: { cookie: third } })).statusCode).toBe(409);

    repo.addUser({ id: 'u9', login: 'petrova', passwordHash: `hash:${PASSWORD}` }, ['ib.work']);
    const foreign = sessionCookie(await login('petrova', PASSWORD, true));
    const foreignId = ((await list(foreign)).json().items as { id: string }[])[0]?.id;
    expect((await app.inject({ method: 'POST', url: `/api/v1/auth/sessions/${foreignId}/revoke`, headers: { cookie: third } })).statusCode).toBe(404);
    expect((await me(foreign)).statusCode).toBe(200);

    const other = items.find((x) => !x.current);
    expect((await app.inject({ method: 'POST', url: `/api/v1/auth/sessions/${other?.id}/revoke`, headers: { cookie: third } })).statusCode).toBe(204);
    expect(audit.actions()).toContain('auth.session_revoked');
    const rest = await app.inject({ method: 'POST', url: '/api/v1/auth/sessions/revoke-others', headers: { cookie: third } });
    expect(rest.json()).toEqual({ revoked: 1 });
    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(401);
    expect((await me(third)).statusCode).toBe(200);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.sessions_revoked_others', diff: { count: 1 } });
  });

  it('администратор users.manage видит и завершает одну и все сессии пользователя; без права — 403, нет пользователя — 404', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    repo.addUser({ id, login: 'smirnov', passwordHash: `hash:${PASSWORD}` }, ['ib.work']);
    repo.addUser({ id: '00000000-0000-4000-8000-0000000000a1', login: 'admin', passwordHash: `hash:${PASSWORD}` }, ['users.manage']);
    const admin = sessionCookie(await login('admin', PASSWORD));
    const a = sessionCookie(await login('smirnov', PASSWORD, true));
    const b = sessionCookie(await login('smirnov', PASSWORD, false));
    expect((await app.inject({ url: `/api/v1/users/${id}/sessions`, headers: { cookie: a } })).statusCode).toBe(403);
    const seen = await app.inject({ url: `/api/v1/users/${id}/sessions`, headers: { cookie: admin } });
    expect(seen.statusCode, seen.body).toBe(200);
    const items = seen.json().items as { id: string; current: boolean }[];
    expect(items).toHaveLength(2);
    expect(items.every((x) => !x.current)).toBe(true);
    const one = await app.inject({ method: 'POST', url: `/api/v1/users/${id}/sessions/${items[0]?.id}/revoke`, headers: { cookie: admin } });
    expect(one.json()).toEqual({ revoked: 1 });
    const all = await app.inject({ method: 'POST', url: `/api/v1/users/${id}/sessions/revoke-all`, headers: { cookie: admin } });
    expect(all.json()).toEqual({ revoked: 1 });
    expect((await me(a)).statusCode).toBe(401);
    expect((await me(b)).statusCode).toBe(401);
    expect((await me(admin)).statusCode).toBe(200);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'user.sessions_revoked', entityId: id, diff: { count: 1, all: true } });
    const missing = await app.inject({ url: '/api/v1/users/00000000-0000-4000-8000-0000000000ff/sessions', headers: { cookie: admin } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('смена пароля', () => {
  it('при must_change_password доступны только me, смена пароля и выход', async () => {
    repo.addUser({ id: 'u2', login: 'petrov', passwordHash: `hash:${PASSWORD}`, mustChangePassword: true }, ['ib.work']);
    const res = await login('petrov', PASSWORD);
    expect(res.json().user.mustChangePassword).toBe(true);
    const cookie = sessionCookie(res);

    const changed = await app.inject({
      method: 'POST', url: '/api/v1/auth/change-password', headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'Brand-New-Pass-77' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().user.mustChangePassword).toBe(false);
    expect(audit.actions()).toContain('auth.password_changed');
  });

  it('проверяет политику и повтор последних паролей', async () => {
    const cookie = sessionCookie(await login('ivanov', PASSWORD));
    const change = (currentPassword: string, newPassword: string) =>
      app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: { cookie }, payload: { currentPassword, newPassword } });

    expect((await change('wrong', 'Another-Pass-2026')).json().error.code).toBe('WRONG_CURRENT_PASSWORD');
    expect((await change(PASSWORD, 'short1A')).json().error.code).toBe('PASSWORD_POLICY');
    expect((await change(PASSWORD, PASSWORD)).json().error.code).toBe('PASSWORD_REUSED');

    let current = PASSWORD;
    for (const next of ['Second-Pass-2026', 'Third-Pass-20266', 'Fourth-Pass-2026', 'Fifth-Pass-20266']) {
      expect((await change(current, next)).statusCode).toBe(200);
      current = next;
    }
    // Текущий + 4 предыдущих = последние 5: исходный пароль ещё в окне.
    expect((await change(current, 'Second-Pass-2026')).json().error.code).toBe('PASSWORD_REUSED');
    expect((await change(current, 'Sixth-Pass-20266')).statusCode).toBe(200);
    // Теперь исходный пароль вышел из окна последних 5.
    expect((await change('Sixth-Pass-20266', PASSWORD)).statusCode).toBe(200);
  });

  it('смена пароля закрывает остальные сессии', async () => {
    const first = sessionCookie(await login('ivanov', PASSWORD));
    const second = sessionCookie(await login('ivanov', PASSWORD));
    await app.inject({
      method: 'POST', url: '/api/v1/auth/change-password', headers: { cookie: second },
      payload: { currentPassword: PASSWORD, newPassword: 'Brand-New-Pass-77' },
    });
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie: first } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie: second } })).statusCode).toBe(200);
  });
});

describe('health', () => {
  it('отвечает без авторизации и без данных', async () => {
    const ok = await app.inject({ url: '/api/health' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: 'ok', db: 'ok' });
    repo.healthy = false;
    const down = await app.inject({ url: '/api/health' });
    expect(down.statusCode).toBe(503);
  });
});

describe('срок действия пароля', () => {
  it('после 90 дней пароль нужно сменить, после смены доступ восстанавливается', async () => {
    const day = 24 * 60 * 60 * 1000;
    repo.addUser({
      id: 'u3', login: 'sidorov', passwordHash: `hash:${PASSWORD}`,
      passwordChangedAt: new Date(clock.now().getTime() - 90 * day),
    }, ['ib.work']);
    const res = await login('sidorov', PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ mustChangePassword: true, passwordExpired: true });

    const cookie = sessionCookie(res);
    const changed = await app.inject({
      method: 'POST', url: '/api/v1/auth/change-password', headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'Fresh-Password-2026' },
    });
    expect(changed.json().user).toMatchObject({ mustChangePassword: false, passwordExpired: false });
  });

  it('за день до истечения смена не требуется', async () => {
    const day = 24 * 60 * 60 * 1000;
    repo.addUser({
      id: 'u4', login: 'kuznetsov', passwordHash: `hash:${PASSWORD}`,
      passwordChangedAt: new Date(clock.now().getTime() - 89 * day),
    }, ['ib.work']);
    expect((await login('kuznetsov', PASSWORD)).json().user.passwordExpired).toBe(false);
  });
});
