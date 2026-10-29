import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../app.js';
import { createPrisma } from '../../lib/db.js';
import { LOCK_DURATION_MS } from '../../lib/lockout.js';
import { SESSION_IDLE_MS } from '../../lib/session-token.js';
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

async function login(loginName: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: loginName, password } });
}

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

  it('неактивная сессия закрывается через 30 минут', async () => {
    const cookie = sessionCookie(await login('ivanov', PASSWORD));
    clock.advance(SESSION_IDLE_MS - 1000);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(200);
    clock.advance(SESSION_IDLE_MS + 1);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
    expect(audit.actions()).toContain('auth.session_expired');
  });

  it('фоновые запросы (X-Background: 1) не продлевают сессию; действие пользователя продлевает; остаток — в X-Session-Idle-Ms', async () => {
    const cookie = sessionCookie(await login('ivanov', PASSWORD));
    const bg = { cookie, 'x-background': '1' };
    clock.advance(20 * 60_000);
    const polled = await app.inject({ url: '/api/v1/auth/me', headers: bg });
    expect(polled.statusCode).toBe(200);
    expect(Number(polled.headers['x-session-idle-ms'])).toBe(SESSION_IDLE_MS - 20 * 60_000);
    clock.advance(9 * 60_000);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: bg })).statusCode).toBe(200);
    // Действие пользователя (без заголовка) продлевает: снова 30 минут.
    const active = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    expect(Number(active.headers['x-session-idle-ms'])).toBe(SESSION_IDLE_MS);
    // 31 минута одних фоновых запросов — сессия закрыта по бездействию.
    for (let i = 0; i < 31; i++) {
      clock.advance(60_000);
      const r = await app.inject({ url: '/api/v1/auth/me', headers: bg });
      if (i < 29) expect(r.statusCode).toBe(200);
    }
    expect((await app.inject({ url: '/api/v1/auth/me', headers: bg })).statusCode).toBe(401);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'auth.session_expired', diff: { reason: 'idle' } });
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
