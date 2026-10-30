// Маршруты настроек целиком: вход, права на маршрутах, журнал. Всё в одной транзакции с откатом.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { inTx, makeUser, type Tx } from '../../test/db.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';

const PASSWORD = 'Http-Test-Pass-2026';

async function appWith(tx: Tx, logs: string[]) {
  return buildApp({
    db: tx,
    repo: prismaAuthRepository(tx),
    audit: prismaAuditWriter(tx),
    hasher: argon2Hasher,
    sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL,
    logger: { level: 'trace', stream: { write: (line: string) => void logs.push(line) } },
  });
}

async function loginAs(app: Awaited<ReturnType<typeof appWith>>, login: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  const c = res.cookies.find((x) => x.name === 'ib_session');
  return { cookie: `ib_session=${c?.value}` };
}

describe('настройки по HTTP', () => {
  it('права на маршрутах: просмотр — ib.work, изменение — settings.manage / users.manage', () =>
    inTx(async (tx) => {
      const hash = await argon2Hasher.hash(PASSWORD);
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const lawyer = await makeUser(tx, ['doc_reader'], { passwordHash: hash });
      const logs: string[] = [];
      const app = await appWith(tx, logs);
      const A = await loginAs(app, admin.login);
      const S = await loginAs(app, staff.login);
      const L = await loginAs(app, lawyer.login);

      // Справочники для списков выбора — любому вошедшему (типы документов нужны и юристу).
      expect((await app.inject({ url: '/api/v1/catalogs/document_types/items', headers: { cookie: L.cookie } })).statusCode).toBe(200);
      // Архивные значения и настройки — только с ib.work.
      expect((await app.inject({ url: '/api/v1/catalogs/systems/items?includeArchived=true', headers: { cookie: L.cookie } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/v1/users', headers: { cookie: L.cookie } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/v1/users', headers: { cookie: S.cookie } })).statusCode).toBe(200);

      // Сотрудник ИБ смотрит, но не меняет.
      const add = { method: 'POST' as const, url: '/api/v1/catalogs/systems/items', payload: { value: 'SIEM' } };
      expect((await app.inject({ ...add, headers: { cookie: S.cookie } })).statusCode).toBe(403);
      expect((await app.inject({ ...add, headers: { cookie: A.cookie } })).statusCode).toBe(201);
      const createUser = {
        method: 'POST' as const, url: '/api/v1/users',
        payload: { login: 'http.user', fullName: 'HTTP Пользователь', roleIds: [] },
      };
      expect((await app.inject({ ...createUser, headers: { cookie: S.cookie } })).statusCode).toBe(403);

      // Временный пароль — в ответе один раз и не в логах сервера.
      const created = await app.inject({ ...createUser, headers: { cookie: A.cookie } });
      expect(created.statusCode).toBe(201);
      const { temporaryPassword } = created.json() as { temporaryPassword: string };
      expect(temporaryPassword).toHaveLength(16);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join('\n')).not.toContain(temporaryPassword);

      // Новый пользователь входит с временным паролем и обязан его сменить.
      const first = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'http.user', password: temporaryPassword } });
      expect(first.json().user).toMatchObject({ mustChangePassword: true, passwordExpired: false });
    }));

  it('журнал изменений: кто, с какими ролями, что поменял — новые сверху, с пагинацией', () =>
    inTx(async (tx) => {
      const hash = await argon2Hasher.hash(PASSWORD);
      const admin = await makeUser(tx, ['super_admin', 'ib_staff'], { passwordHash: hash, fullName: 'Админ Журнала' });
      const app = await appWith(tx, []);
      const A = await loginAs(app, admin.login);
      for (const value of ['Журнал-1', 'Журнал-2', 'Журнал-3']) {
        await app.inject({ method: 'POST', url: '/api/v1/catalogs/systems/items', headers: { cookie: A.cookie }, payload: { value } });
      }
      const page = await app.inject({ url: '/api/v1/settings/journal?limit=2', headers: { cookie: A.cookie } });
      const body = page.json() as { items: { summary: string; actor: { fullName: string }; actorRoles: string[]; action: string }[]; nextCursor: string };
      expect(body.items.map((i) => i.summary)).toEqual(['«Системы»: добавлено «Журнал-3»', '«Системы»: добавлено «Журнал-2»']);
      expect(body.items[0]).toMatchObject({ actor: { fullName: 'Админ Журнала' }, actorRoles: ['Сотрудник ИБ', 'Супер-администратор'] });
      const next = await app.inject({ url: `/api/v1/settings/journal?limit=2&cursor=${body.nextCursor}`, headers: { cookie: A.cookie } });
      expect((next.json() as typeof body).items[0]?.summary).toBe('«Системы»: добавлено «Журнал-1»');
      // Вход и выход — не изменения настроек, в журнал не попадают.
      expect(body.items.some((i) => i.action.startsWith('auth.'))).toBe(false);
    }));
});
