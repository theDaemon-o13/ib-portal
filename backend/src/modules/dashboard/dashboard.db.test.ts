// Дашборд и мониторинг на настоящей БД (этап 8): граничные сроки, архивные записи не учитываются,
// KPI и плитка совпадают с total списка по своей ссылке, права (киоск), кэш на минуту.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { parseIpList } from '../../lib/ip-list.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { addDaysIso, todayIso } from '../../lib/today.js';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { loadRegister } from '../registers/definition.js';
import { parseRecordFilter } from '../registers/filter.js';
import * as records from '../registers/records.service.js';
import * as decisions from '../registers/decisions.service.js';
import { RISK_REGISTER_KEY } from '../risks/definition.js';
import * as tasks from '../tasks/service.js';
import { INCIDENT_DATE_KEY, INCIDENT_REGISTER_KEY } from './incidents.js';
import { computeKpis, widgetData, type Kpi } from './service.js';
import * as tiles from './tiles.service.js';

const today = todayIso();
const day = (n: number) => addDaysIso(today, n);

/** total списка раздела по ссылке KPI или плитки — тем же разбором адреса, что у GET /registers/:id/records. */
async function totalByLink(tx: Tx, link: string): Promise<number> {
  const url = new URL(link, 'https://portal.local');
  if (url.pathname === '/registers') {
    const registerId = url.hash.slice(1).split('/')[0] as string;
    const q = Object.fromEntries(url.searchParams) as Record<string, string>;
    const filter = parseRecordFilter(await loadRegister(tx, registerId), q);
    return (await records.listRecords(tx, registerId, { limit: 1, filter })).total;
  }
  if (url.pathname === '/tasks') {
    return (await tasks.listTasks(tx, { archived: false, overdue: url.searchParams.get('overdue') === '1', limit: 1 })).total;
  }
  throw new Error(`ссылка не из реестра или задач: ${link}`);
}

const kpi = (list: Kpi[], key: Kpi['key']) => must(list.find((k) => k.key === key), key);

/** Уязвимость со сроком ровно через n дней: п. 7.3 — срок из решения ИБ при заполненных мерах. */
async function vulnDue(tx: Tx, x: VulnFixture, cve: string, n: number, extra: Record<string, unknown> = {}) {
  return records.createRecord(tx, x.actor, x.reg.id, {
    values: { [x.vf.cve.id]: cve, [x.vf.measures.id]: 'Сегментация сети', [x.vf.newDue.id]: day(n), ...extra },
  });
}

describe('KPI: граничные сроки и архив', () => {
  it('уязвимости: −1 — просрочено; 0 и 7 — «скоро»; 8 — в срок; закрытые и архивные не считаются; число = total по ссылке', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      await vulnDue(tx, x, 'CVE-OVER', -1);
      await vulnDue(tx, x, 'CVE-TODAY', 0);
      await vulnDue(tx, x, 'CVE-7', 7);
      await vulnDue(tx, x, 'CVE-8', 8);
      await vulnDue(tx, x, 'CVE-FIXED', -5, { [x.vf.status.id]: x.opt('status', 'fixed') });
      const arch = await vulnDue(tx, x, 'CVE-ARCH', -3);
      await records.setRecordArchived(tx, x.actor, arch.id, arch.version, true);

      const list = await computeKpis(tx);
      expect(kpi(list, 'vulns_open').value).toBe(4);
      expect(kpi(list, 'vulns_overdue')).toMatchObject({ value: 1, tone: 'bad' });
      expect(kpi(list, 'vulns_soon').value).toBe(2);
      for (const key of ['vulns_open', 'vulns_overdue', 'vulns_soon'] as const) {
        const k = kpi(list, key);
        expect(await totalByLink(tx, must(k.link)), key).toBe(k.value);
      }
    }));

  it('инциденты за 30 дней: сегодня и 29 дней назад — да; 30 дней назад, завтра и архивные — нет', () =>
    inTx(async (tx) => {
      const admin = await makeUser(tx, ['super_admin', 'ib_staff']);
      const actor = await actorFor(tx, admin.id);
      const reg = await loadRegister(tx, (await tx.register.findUniqueOrThrow({ where: { systemKey: INCIDENT_REGISTER_KEY } })).id);
      const date = must(reg.fields.find((f) => f.systemKey === INCIDENT_DATE_KEY));
      const title = must(reg.fields.find((f) => f.isTitle));
      const inc = (name: string, d: string) => records.createRecord(tx, actor, reg.id, { values: { [title.id]: name, [date.id]: d } });
      await inc('Сегодня', day(0));
      await inc('29 дней назад', day(-29));
      await inc('30 дней назад', day(-30));
      await inc('Завтра', day(1));
      const arch = await inc('Архив', day(-2));
      await records.setRecordArchived(tx, actor, arch.id, arch.version, true);

      const k = kpi(await computeKpis(tx), 'incidents_30d');
      expect(k.value).toBe(2);
      expect(await totalByLink(tx, must(k.link))).toBe(2);
    }));

  it('просроченные задачи: срок вчера — да; сегодня, выполненные и архивные — нет; число = total по ссылке', () =>
    inTx(async (tx) => {
      const admin = await makeUser(tx, ['super_admin', 'ib_staff']);
      const actor = await actorFor(tx, admin.id);
      const category = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', deletedAt: null, archivedAt: null } });
      const mk = async (title: string, due: string, extra: { completedAt?: Date; archivedAt?: Date } = {}) => {
        const t = await tasks.createTask(tx, actor, { title, categoryId: category.id });
        await tx.task.update({ where: { id: t.id }, data: { dueDate: new Date(`${due}T00:00:00Z`), ...extra } });
      };
      await mk('Вчера', day(-1));
      await mk('Неделю назад', day(-7));
      await mk('Сегодня', day(0));
      await mk('Вчера, выполнена', day(-1), { completedAt: new Date() });
      await mk('Вчера, архив', day(-1), { archivedAt: new Date() });
      const k = kpi(await computeKpis(tx), 'tasks_overdue');
      expect(k).toMatchObject({ value: 2, link: '/tasks?overdue=1', tone: 'warn' });
      expect(await totalByLink(tx, '/tasks?overdue=1')).toBe(2);
    }));

  it('риски без решения ОУР: без решения — да; с решением и архивные — нет', () =>
    inTx(async (tx) => {
      const admin = await makeUser(tx, ['super_admin', 'ib_staff']);
      const actor = await actorFor(tx, admin.id);
      const reg = await loadRegister(tx, (await tx.register.findUniqueOrThrow({ where: { systemKey: RISK_REGISTER_KEY } })).id);
      const title = must(reg.fields.find((f) => f.isTitle));
      const decision = must(reg.fields.find((f) => f.systemKey === 'decision'));
      const risk = (name: string) => records.createRecord(tx, actor, reg.id, { values: { [title.id]: name } });
      await risk('Без решения 1');
      await risk('Без решения 2');
      const decided = await risk('Принят ОУР');
      const file = await tx.file.create({
        data: { storageKey: `2026/10/${crypto.randomUUID()}`, originalName: 'Решение.pdf', mime: 'application/pdf', size: 10n, sha256: 'a'.repeat(64), uploadedBy: admin.id },
      });
      await decisions.addDecision(tx, actor, decided.id, {
        recordVersion: decided.version, fieldId: decision.id, optionId: must(decision.options.find((o) => o.label === 'Принят')).id,
        documentTitle: 'Протокол ОУР', documentNumber: '15', documentDate: day(-1), fileId: file.id,
      });
      const arch = await risk('Архив');
      await records.setRecordArchived(tx, actor, arch.id, arch.version, true);

      const k = kpi(await computeKpis(tx), 'risks_no_decision');
      expect(k.value).toBe(2);
      expect(await totalByLink(tx, must(k.link))).toBe(2);
    }));
});

describe('виджеты из полей реестров', () => {
  it('распределение по критичности: каждая строка = total по своей ссылке; архивные не считаются', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const crit = (k: string) => ({ [x.vf.crit.id]: x.opt('crit', k) });
      await vulnDue(tx, x, 'C1', 10, crit('critical'));
      await vulnDue(tx, x, 'C2', 10, crit('critical'));
      await vulnDue(tx, x, 'H1', 10, crit('high'));
      const arch = await vulnDue(tx, x, 'C3', 10, crit('critical'));
      await records.setRecordArchived(tx, x.actor, arch.id, arch.version, true);
      const w = await widgetData(tx, `field:${x.vf.crit.id}`);
      expect(w.kind).toBe('distribution');
      const row = (label: string) => must(w.rows.find((r) => r.label === label), label);
      expect(row('Критическая')).toMatchObject({ count: 2, tone: 'crit' });
      for (const r of w.rows) expect(await totalByLink(tx, must(r.link)), r.label).toBe(r.count);
    }));

  it('контроль сроков: просрочено / ≤ 7 дней / в срок и самые срочные первыми', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      await vulnDue(tx, x, 'LATE', -3);
      await vulnDue(tx, x, 'SOON', 2);
      await vulnDue(tx, x, 'LATER', 40);
      const w = await widgetData(tx, `field:${x.vf.due.id}`);
      expect(w.stats.map((s) => [s.label, s.value])).toEqual([['Просрочено', 1], ['≤ 7 дней', 1], ['В срок', 1]]);
      expect(w.items.map((i) => [i.title, i.days])).toEqual([['LATE', -3], ['SOON', 2]]);
      for (const s of w.stats) expect(await totalByLink(tx, must(s.link)), s.label).toBe(s.value);
    }));
});

describe('плитки-счётчики', () => {
  it('без закрытых и архивных; разбивка по значениям; число = total по ссылке', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const crit = (k: string, extra: Record<string, unknown> = {}) => ({ [x.vf.crit.id]: x.opt('crit', k), ...extra });
      await vulnDue(tx, x, 'C1', 10, crit('critical'));
      await vulnDue(tx, x, 'H1', 10, crit('high'));
      await vulnDue(tx, x, 'H2', 10, crit('high'));
      await vulnDue(tx, x, 'M1', 10, crit('medium'));
      await vulnDue(tx, x, 'C-FIXED', 10, crit('critical', { [x.vf.status.id]: x.opt('status', 'fixed') }));
      const arch = await vulnDue(tx, x, 'H-ARCH', 10, crit('high'));
      await records.setRecordArchived(tx, x.actor, arch.id, arch.version, true);

      const tile = await tiles.createTile(tx, x.actor, {
        registerId: x.reg.id, fieldId: x.vf.crit.id, optionIds: [x.opt('crit', 'critical'), x.opt('crit', 'high')], title: 'Критические и высокие',
      });
      const data = await tiles.tileData(tx, tile.id);
      expect(data.total).toBe(3);
      expect(data.rows.map((r) => [r.label, r.count])).toEqual([['Критическая', 1], ['Высокая', 2]]);
      expect(await totalByLink(tx, must(data.link))).toBe(3);
      for (const r of data.rows) expect(await totalByLink(tx, must(r.link))).toBe(r.count);
    }));

  it('проверки: поле-список, значения этого поля, закрытый статус нельзя; удаление мягкое', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const base = { registerId: x.reg.id, title: 'Плитка' };
      await expectCode(tiles.createTile(tx, x.actor, { ...base, fieldId: x.vf.cvss.id, optionIds: [crypto.randomUUID()] }), 'TILE_FIELD_TYPE');
      await expectCode(tiles.createTile(tx, x.actor, { ...base, fieldId: x.vf.crit.id, optionIds: [x.opt('status', 'open')] }), 'BAD_OPTION');
      await expectCode(tiles.createTile(tx, x.actor, { ...base, fieldId: x.vf.status.id, optionIds: [x.opt('status', 'fixed')] }), 'CLOSED_OPTION');
      const t = await tiles.createTile(tx, x.actor, { ...base, fieldId: x.vf.status.id, optionIds: [x.opt('status', 'open')] });
      await tiles.deleteTile(tx, x.actor, t.id, t.version);
      expect(await tx.dashboardTile.findUnique({ where: { id: t.id } })).toMatchObject({ deletedAt: expect.any(Date) });
      expect((await tiles.listTiles(tx)).some((l) => l.id === t.id)).toBe(false);
    }));
});

describe('по HTTP: права и кэш', () => {
  const PASSWORD = 'Dash-Board-Pass-2026';
  const WALL = '10.77.0.5';

  async function setup(tx: Tx) {
    const hash = await argon2Hasher.hash(PASSWORD);
    const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
    const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
    const wall = await makeUser(tx, ['kiosk'], { passwordHash: hash });
    const lawyer = await makeUser(tx, ['doc_reader'], { passwordHash: hash });
    const app = await buildApp({
      db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL,
      kioskAllowedIps: parseIpList(WALL),
    });
    const login = async (l: string, ip = '127.0.0.1') => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD }, remoteAddress: ip });
      const c = res.cookies.find((x) => x.name === 'ib_session');
      return { status: res.statusCode, cookie: c ? `ib_session=${c.value}` : '' };
    };
    return { app, admin, staff, wall, lawyer, login };
  }

  it('киоск: только /monitor и вход-выход; с чужого IP вход отклоняется; остальным — по ib.work', () =>
    inTx(async (tx) => {
      const { app, wall, staff, lawyer, login } = await setup(tx);
      expect((await login(wall.login, '10.77.0.99')).status).toBe(401);
      const K = (await login(wall.login, WALL)).cookie;
      const asWall = (url: string, method: 'GET' | 'POST' = 'GET') => app.inject({ method, url, headers: { cookie: K }, remoteAddress: WALL });
      const me = await asWall('/api/v1/auth/me');
      expect(me.json().user).toMatchObject({ kiosk: true, permissions: ['monitor.kiosk'] });
      expect((await asWall('/api/v1/monitor')).statusCode).toBe(200);
      for (const url of ['/api/v1/dashboard/kpis', '/api/v1/dashboard/widgets', '/api/v1/tasks', '/api/v1/documents', '/api/v1/registers', '/api/v1/evidence', '/api/v1/users']) {
        expect((await asWall(url)).statusCode, url).toBe(403);
      }
      // Сотрудник ИБ видит и монитор, и дашборд; юрист (без ib.work) — ни то, ни другое.
      const S = (await login(staff.login)).cookie;
      expect((await app.inject({ url: '/api/v1/monitor', headers: { cookie: S } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/v1/dashboard/kpis', headers: { cookie: S } })).statusCode).toBe(200);
      const L = (await login(lawyer.login)).cookie;
      expect((await app.inject({ url: '/api/v1/monitor', headers: { cookie: L } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/v1/dashboard/kpis', headers: { cookie: L } })).statusCode).toBe(403);
    }));

  it('все маршруты /api/v1, кроме входа, выхода, смены пароля и /monitor, отвечают киоску 403', () =>
    inTx(async (tx) => {
      const { app, wall, login } = await setup(tx);
      const K = (await login(wall.login, WALL)).cookie;
      // Все маршруты — из OpenAPI (контракт API): новый маршрут попадёт в проверку сам.
      const paths = (app.swagger() as { paths: Record<string, Record<string, unknown>> }).paths;
      const routes = Object.entries(paths).filter(([p]) => p.startsWith('/api/v1/'))
        .flatMap(([p, ops]) => Object.keys(ops).map((m) => [m.toUpperCase(), p] as const));
      expect(routes.length).toBeGreaterThan(100);
      const allowed = new Set(['/api/v1/monitor', '/api/v1/auth/me', '/api/v1/auth/logout', '/api/v1/auth/change-password', '/api/v1/auth/login']);
      for (const [method, path] of routes) {
        if (allowed.has(path)) continue;
        const url = path.replace(/\{[^}]+\}/g, (m) => (m === '{key}' ? 'kpis' : '00000000-0000-0000-0000-000000000001'));
        const res = await app.inject({ method: method as 'GET', url, headers: { cookie: K }, remoteAddress: WALL, ...(method === 'GET' ? {} : { payload: {} }) });
        expect(res.statusCode, `${method} ${path}`).toBe(403);
      }
    }));

  it('плитки добавляет только registers.manage; KPI кэшируются на минуту', () =>
    inTx(async (tx) => {
      const { app, admin, staff, login } = await setup(tx);
      const x = await vulnRegister(tx);
      const A = (await login(admin.login)).cookie;
      const S = (await login(staff.login)).cookie;
      const body = { registerId: x.reg.id, fieldId: x.vf.crit.id, optionIds: [x.opt('crit', 'critical')], title: 'Критические' };
      expect((await app.inject({ method: 'POST', url: '/api/v1/dashboard/tiles', headers: { cookie: S }, payload: body })).statusCode).toBe(403);
      const created = await app.inject({ method: 'POST', url: '/api/v1/dashboard/tiles', headers: { cookie: A }, payload: body });
      expect(created.statusCode).toBe(201);
      const widgets = await app.inject({ url: '/api/v1/dashboard/widgets', headers: { cookie: S } });
      expect(widgets.json().tiles.map((t: { title: string }) => t.title)).toContain('Критические');

      const first = await app.inject({ url: '/api/v1/dashboard/kpis', headers: { cookie: S } });
      const open = (r: typeof first) => (r.json().items as Kpi[]).find((k) => k.key === 'vulns_open')?.value;
      expect(first.json().items).toHaveLength(8);
      await vulnDue(tx, x, 'CVE-NEW', 5);
      const second = await app.inject({ url: '/api/v1/dashboard/kpis', headers: { cookie: S } });
      expect(open(second)).toBe(open(first));
      expect(second.json().computedAt).toBe(first.json().computedAt);
      void admin;
    }));
});
