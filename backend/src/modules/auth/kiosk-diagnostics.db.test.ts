// Диагностика входа настенного монитора (1.13.7) с настоящим PostgreSQL: подпись причины в «Журнале» и в Excel,
// маска неизвестного логина в показе, GET /users/kiosk-status для «Пользователи и роли». Имена вымышленные.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { parseIpList, type IpList } from '../../lib/ip-list.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { inTx, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from './repository.prisma.js';

const PASSWORD = 'Kiosk-Diag-Pass-2026';
const NGINX = '172.31.250.6';
const WALL = '10.20.30.40';
const OTHER = '10.20.30.99';

async function appWith(tx: Tx, kioskAllowedIps?: IpList) {
  return buildApp({
    db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
    sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
    trustProxy: NGINX, ...(kioskAllowedIps ? { kioskAllowedIps } : {}),
  });
}
type App = Awaited<ReturnType<typeof appWith>>;

const tryLogin = (app: App, login: string, client: string, password = PASSWORD) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password }, remoteAddress: NGINX, headers: { 'x-forwarded-for': client } });

async function adminCookie(app: App, login: string) {
  const res = await tryLogin(app, login, OTHER);
  expect(res.statusCode).toBe(200);
  return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
}

async function fixture(tx: Tx) {
  const hash = await argon2Hasher.hash(PASSWORD);
  const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash, mustChangePassword: false, fullName: 'Администратор Проверок' });
  const wall = await makeUser(tx, ['kiosk'], { passwordHash: hash, mustChangePassword: false, fullName: 'Монитор Стены' });
  const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash, mustChangePassword: false });
  return { admin, wall, staff };
}

describe('диагностика входа настенного монитора (1.13.7)', () => {
  it('«Журнал»: у неудачного входа подпись причины (и в Excel); неизвестный логин — в маске и в подписи, и в diff', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const app = await appWith(tx, parseIpList(WALL));
      expect((await tryLogin(app, x.wall.login, OTHER)).statusCode).toBe(401);
      expect((await tryLogin(app, x.staff.login, OTHER, 'Wrong-Pass-2026#')).statusCode).toBe(401);
      expect((await tryLogin(app, 'secret-typed-here', OTHER)).statusCode).toBe(401);
      const A = await adminCookie(app, x.admin.login);

      const res = await app.inject({ url: '/api/v1/audit?action=auth.login_failed&limit=10', headers: { cookie: A } });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as { summary: string; ip: string; diff: { login?: string } }[];
      expect(items.map((i) => [i.summary, i.ip])).toEqual([
        ['Неудачный вход «se… (17 симв.)»: логин не найден', OTHER],
        [`Неудачный вход «${x.staff.login}»: неверный пароль (попытка 1)`, OTHER],
        [`Неудачный вход «${x.wall.login}»: адрес не разрешён для настенного монитора (MONITOR_ALLOWED_IPS)`, OTHER],
      ]);
      expect(items[0]?.diff.login).toBe('se… (17 симв.)');
      expect(JSON.stringify(res.json())).not.toContain('secret-typed-here');
      // В базе запись не меняется: логин как был введён (журнал только пополняется).
      const raw = await tx.auditLog.findFirstOrThrow({ where: { action: 'auth.login_failed', userId: null }, orderBy: { id: 'desc' } });
      expect(raw.diff).toMatchObject({ login: 'secret-typed-here', reason: 'unknown_user' });

      const xlsx = await app.inject({ url: '/api/v1/audit/export?action=auth.login_failed', headers: { cookie: A } });
      expect(xlsx.statusCode).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
      const summaries = must(wb.getWorksheet('Журнал')).getColumn(7).values.slice(2).map(String);
      expect(summaries).toContain(`Неудачный вход «${x.wall.login}»: адрес не разрешён для настенного монитора (MONITOR_ALLOWED_IPS)`);
    }));

  it('kiosk-status: последний отказ по адресу после последнего входа; после входа с разрешённого адреса — пусто', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const app = await appWith(tx, parseIpList(WALL));
      const A = await adminCookie(app, x.admin.login);
      const status = async () => {
        const r = await app.inject({ url: '/api/v1/users/kiosk-status', headers: { cookie: A } });
        expect(r.statusCode).toBe(200);
        return r.json() as { allowedIpsEmpty: boolean; items: { userId: string; lastDenied: { at: string; ip: string | null } | null }[] };
      };
      expect(await status()).toEqual({ allowedIpsEmpty: false, items: expect.arrayContaining([{ userId: x.wall.id, lastDenied: null }]) });
      expect((await status()).items.map((i) => i.userId)).not.toContain(x.staff.id);

      await tryLogin(app, x.wall.login, OTHER);
      const denied = (await status()).items.find((i) => i.userId === x.wall.id);
      expect(denied?.lastDenied).toMatchObject({ ip: OTHER });

      expect((await tryLogin(app, x.wall.login, WALL)).statusCode).toBe(200);
      expect((await status()).items.find((i) => i.userId === x.wall.id)?.lastDenied).toBeNull();
    }));

  it('kiosk-status: MONITOR_ALLOWED_IPS не задана — allowedIpsEmpty; без users.manage — 403', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const app = await appWith(tx);
      const A = await adminCookie(app, x.admin.login);
      expect((await app.inject({ url: '/api/v1/users/kiosk-status', headers: { cookie: A } })).json()).toMatchObject({ allowedIpsEmpty: true });
      const S = await adminCookie(app, x.staff.login);
      expect((await app.inject({ url: '/api/v1/users/kiosk-status', headers: { cookie: S } })).statusCode).toBe(403);
    }));
});
