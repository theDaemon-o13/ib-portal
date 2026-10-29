// Раздел «Журнал» (ADR-0021) по HTTP: права, фильтры, переходы к объектам, выгрузка; пароли в журнал не попадают.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, makeUser, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { prismaAuditWriter } from './audit.js';
import { exportAudit, listAudit } from './service.js';

const PASSWORD = 'Audit-Test-Pass-2026';

async function appWith(tx: Tx) {
  return buildApp({
    db: tx,
    repo: prismaAuthRepository(tx),
    audit: prismaAuditWriter(tx),
    hasher: argon2Hasher,
    sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL,
    logger: { level: 'silent' },
  });
}
type App = Awaited<ReturnType<typeof appWith>>;

async function login(app: App, login: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password } });
  expect(res.statusCode).toBe(200);
  return `ib_session=${res.cookies.find((x) => x.name === 'ib_session')?.value}`;
}

describe('раздел «Журнал»', () => {
  it('без audit.view — 403 на список, фильтры, выгрузку и прежний журнал настроек; с правом — 200', () =>
    inTx(async (tx) => {
      const hash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const head = await makeUser(tx, ['ib_head'], { passwordHash: hash });
      const app = await appWith(tx);
      const S = await login(app, staff.login);
      const H = await login(app, head.login);
      for (const url of ['/api/v1/audit', '/api/v1/audit/facets', '/api/v1/audit/export', '/api/v1/settings/journal']) {
        expect((await app.inject({ url, headers: { cookie: S } })).statusCode, url).toBe(403);
        expect((await app.inject({ url, headers: { cookie: H } })).statusCode, url).toBe(200);
      }
    }));

  it('фильтры: пользователь, раздел (группа), действие, поиск, период; курсор; переход к задаче', () =>
    inTx(async (tx) => {
      const hash = await argon2Hasher.hash(PASSWORD);
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash, fullName: 'Журнал Проверяющий' });
      const app = await appWith(tx);
      const A = await login(app, admin.login);
      const from = new Date(Date.now() - 60_000).toISOString();

      const category = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', deletedAt: null, archivedAt: null } });
      const task = await app.inject({ method: 'POST', url: '/api/v1/tasks', headers: { cookie: A }, payload: { title: 'Журнал: задача', categoryId: category.id } });
      expect(task.statusCode).toBe(201);
      const taskId = task.json().id as string;
      expect((await app.inject({ method: 'POST', url: '/api/v1/catalogs/systems/items', headers: { cookie: A }, payload: { value: 'Журнал SIEM' } })).statusCode).toBe(201);

      const get = async (qs: string) => {
        const res = await app.inject({ url: `/api/v1/audit?${qs}`, headers: { cookie: A } });
        expect(res.statusCode, qs).toBe(200);
        return res.json() as { items: { action: string; actionLabel: string; entity: string; summary: string; href: string | null; actor: { id: string } | null }[]; nextCursor: string | null };
      };
      const mine = await get(`userId=${admin.id}&from=${encodeURIComponent(from)}&limit=50`);
      expect(mine.items.map((i) => i.action)).toEqual(expect.arrayContaining(['auth.login', 'task.created', 'catalog.item.created']));
      expect(mine.items.every((i) => i.actor?.id === admin.id)).toBe(true);

      const created = (await get(`userId=${admin.id}&action=task.created`)).items[0];
      expect(created?.actionLabel).toBe('Задача создана');
      expect(created?.href).toBe(`/tasks?task=${taskId}`);

      const settings = await get(`userId=${admin.id}&entity=${encodeURIComponent('user,role,catalog_item')}`);
      // Вход тоже записан с разделом «user»; задачи в выборку не попадают.
      expect(new Set(settings.items.map((i) => i.entity))).toEqual(new Set(['catalog_item', 'user']));
      expect((await get(`q=${encodeURIComponent('журнал siem')}`)).items[0]?.entity).toBe('catalog_item');
      expect((await get(`userId=${admin.id}&to=${encodeURIComponent(from)}`)).items).toEqual([]);

      const p1 = await get(`userId=${admin.id}&limit=1`);
      expect(p1.items).toHaveLength(1);
      const p2 = await get(`userId=${admin.id}&limit=1&cursor=${p1.nextCursor}`);
      expect(p2.items[0]?.action).not.toBe(p1.items[0]?.action);

      // Удалённая задача — без ссылки, с пометкой.
      await tx.task.update({ where: { id: taskId }, data: { deletedAt: new Date() } });
      const gone = (await listAudit(tx, { userId: admin.id, action: 'task.created', limit: 1 })).items[0];
      expect(gone).toMatchObject({ href: null, objectDeleted: true });
    }));

  it('выгрузка в Excel: те же строки, что в списке; больше предела — «Сузьте период»; выгрузка — в журнал', () =>
    inTx(async (tx) => {
      const admin = await makeUser(tx, ['super_admin']);
      const actor = await actorFor(tx, admin.id);
      for (const n of [1, 2, 3]) {
        await tx.auditLog.create({ data: { userId: admin.id, action: 'role.updated', entity: 'role', diff: { summary: `Проверка выгрузки ${n}` } } });
      }
      const filter = { userId: admin.id, action: 'role.updated' };
      const { buffer, fileName } = await exportAudit(tx, actor, filter);
      expect(fileName).toMatch(/^Журнал \d{4}-\d{2}-\d{2}\.xlsx$/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const ws = wb.getWorksheet('Журнал');
      const summaries = ws?.getColumn(7).values.slice(2).map(String);
      expect(summaries).toEqual(['Проверка выгрузки 3', 'Проверка выгрузки 2', 'Проверка выгрузки 1']);
      expect((await tx.auditLog.findFirstOrThrow({ where: { userId: admin.id, action: 'audit.exported' } })).diff).toMatchObject({ rows: 3 });

      await expectCode(exportAudit(tx, actor, filter, 2), 'TOO_MANY_ROWS');
    }));

  it('пароли и хеши в журнал не попадают: создание, первый вход, смена, неудачные вход и смена, сброс', () =>
    inTx(async (tx) => {
      const hash = await argon2Hasher.hash(PASSWORD);
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const app = await appWith(tx);
      const A = await login(app, admin.login);
      const startId = (await tx.auditLog.aggregate({ _max: { id: true } }))._max.id ?? 0n;

      const created = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie: A }, payload: { login: 'audit.secret', fullName: 'Проверка Паролей', roleIds: [] } });
      expect(created.statusCode).toBe(201);
      const { user, temporaryPassword } = created.json() as { user: { id: string; version: number }; temporaryPassword: string };
      const U = await login(app, 'audit.secret', temporaryPassword);
      const newPassword = 'Nov-Parol-Audit-2026!';
      const wrong = 'Wrong-Audit-Password-1';
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: { cookie: U }, payload: { currentPassword: wrong, newPassword } })).statusCode).not.toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: { cookie: U }, payload: { currentPassword: temporaryPassword, newPassword } })).statusCode).toBe(200);
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'audit.secret', password: wrong } });
      const version = (await tx.user.findUniqueOrThrow({ where: { id: user.id } })).version;
      const reset = await app.inject({ method: 'POST', url: `/api/v1/users/${user.id}/reset-password`, headers: { cookie: A }, payload: { version } });
      expect(reset.statusCode).toBe(200);
      const tempAfterReset = (reset.json() as { temporaryPassword: string }).temporaryPassword;

      const hashes = [
        (await tx.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
        ...(await tx.passwordHistory.findMany({ where: { userId: user.id } })).map((h) => h.passwordHash),
      ];
      const secrets = [temporaryPassword, newPassword, wrong, tempAfterReset, ...hashes];
      const rows = await tx.auditLog.findMany({ where: { id: { gt: startId } } });
      expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['user.created', 'auth.login', 'auth.password_changed', 'auth.login_failed', 'user.password_reset']));
      const stored = JSON.stringify(rows.map((r) => ({ ...r, id: r.id.toString() })));
      for (const s of secrets) expect(stored).not.toContain(s);

      // И в выдаче раздела «Журнал».
      const shown = await app.inject({ url: '/api/v1/audit?limit=200', headers: { cookie: A } });
      for (const s of secrets) expect(shown.body).not.toContain(s);
    }));
});
