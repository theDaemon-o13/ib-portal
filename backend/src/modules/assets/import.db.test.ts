// Адаптеры импорта активов (релиз 1.6.0, ADR-0032) с настоящей БД: отчёты KSC и реестр сервисов через общий конвейер
// импорта — каждый отчёт обновляет свои поля, «Нет в файле» только по развёртыванию, повторная загрузка ничего не меняет,
// продукты и хосты создаются только при применении. Каждый тест — транзакция с откатом.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { basesReport, deploymentReport, kscOtherReport, serviceRegistry, versionsReport } from '../../test/asset-files.js';
import { actorFor, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { loadRegister, type RegisterDef } from '../registers/definition.js';
import * as excel from '../registers/excel.service.js';
import * as records from '../registers/records.service.js';
import { updatePortalParam } from '../settings/portal-params.js';
import { ASSET_COMPONENTS_KEY, ASSET_HOSTS_KEY, ASSET_SERVICES_KEY } from './definition.js';
import { assetImportAdapter, type AssetAdapterKind } from './import.js';
import { seedComponentInstances } from '../../../prisma/seed/assets.js';

const PASSWORD = 'Http-Test-Pass-2026';

async function setup(tx: Tx) {
  const staff = await makeUser(tx, ['ib_staff']);
  const actor = await actorFor(tx, staff.id);
  const reg = async (key: string) => loadRegister(tx, must(await tx.register.findUnique({ where: { systemKey: key } }), key).id);
  const hosts = await reg(ASSET_HOSTS_KEY);
  const components = await reg(ASSET_COMPONENTS_KEY);
  const services = await reg(ASSET_SERVICES_KEY);
  const F = (r: RegisterDef, key: string) => must(r.fields.find((f) => f.systemKey === key), key);
  const label = (r: RegisterDef, key: string, id: unknown) => F(r, key).options.find((o) => o.id === id)?.label;
  const preview = async (kind: AssetAdapterKind, buf: Buffer, name = 'report.xls') => {
    const target = kind === 'ksc' ? hosts : components;
    return excel.previewImport(tx, actor, target.id, buf, name, await assetImportAdapter(tx, target.id, kind, buf));
  };
  const run = async (kind: AssetAdapterKind, buf: Buffer, skip: string[] = []) => {
    const p = await preview(kind, buf);
    return { preview: p, result: await excel.applyImport(tx, actor, p.id, { skip }) };
  };
  const rows = async (r: RegisterDef) => (await tx.registerRecord.findMany({ where: { registerId: r.id, deletedAt: null }, orderBy: { number: 'asc' } }))
    .map((x) => ({ id: x.id, number: x.number, values: x.values as Record<string, unknown> }));
  const hostByName = async (name: string) => must((await rows(hosts)).find((h) => String(h.values[F(hosts, 'name').id]).toLowerCase() === name.toLowerCase()), name);
  return { staff, actor, hosts, components, services, F, label, preview, run, rows, hostByName };
}

const DEPLOY = [
  { name: 'TEST-PC01NB', agent: '15.1', product: 'Kaspersky Endpoint Security для Windows', version: '12.5' },
  { name: 'TEST-PC02NB', agent: '15.1' },
  { name: 'TEST-SRV01', group: 'Servers' },
];

describe('отчёты KSC', () => {
  it('три отчёта подряд: каждый обновляет свои поля и не затирает чужие; повторная загрузка ничего не меняет', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const first = await s.run('ksc', deploymentReport(DEPLOY));
      expect(first.result).toMatchObject({ added: 3, updated: 0 });
      expect(first.preview.summary.source).toMatchObject({ adapter: 'ksc', reportType: 'deployment', summaryTotal: 3, detailsRows: 3 });
      let pc1 = await s.hostByName('TEST-PC01NB');
      const H = (k: string) => s.F(s.hosts, k).id;
      expect(s.label(s.hosts, 'coverage', pc1.values[H('coverage')])).toBe('Агент и защита');
      expect(s.label(s.hosts, 'type', pc1.values[H('type')])).toBe('Рабочая станция');
      expect(s.label(s.hosts, 'source', pc1.values[H('source')])).toBe('Kaspersky');
      expect(s.label(s.hosts, 'inKsc', pc1.values[H('inKsc')])).toBe('Да');
      expect(s.label(s.hosts, 'type', (await s.hostByName('TEST-SRV01')).values[H('type')])).toBe('Сервер');

      await s.run('ksc', basesReport([{ name: 'test-pc01nb.example.local', status: 'Актуальные', created: '2026-10-30', ip: '10.0.0.11' }]));
      await s.run('ksc', versionsReport([{ name: 'TEST-PC01NB', program: 'Kaspersky Endpoint Security для Windows', installed: '2025-01-10', visible: '2026-10-30', connected: '2026-10-29' }]));
      pc1 = await s.hostByName('TEST-PC01NB');
      expect(pc1.values[H('name')]).toBe('TEST-PC01NB'); // имя у найденного хоста не перезаписывается
      expect(pc1.values).toMatchObject({
        [H('agentVersion')]: '15.1', [H('protectionVersion')]: '12.5', [H('kscGroup')]: 'Филиал 1',
        [H('basesDate')]: '2026-10-30', [H('ip')]: '10.0.0.11', [H('domain')]: 'EXAMPLE',
        [H('seen')]: '2026-10-29', [H('lastVisible')]: '2026-10-30', [H('installedOn')]: '2025-01-10',
      });

      // Тот же файл ещё раз — без изменений.
      const again = await s.run('ksc', deploymentReport(DEPLOY));
      expect(again.preview.summary).toMatchObject({ added: 0, updated: 0, unchanged: 3, missingTotal: 0 });
    }));

  it('«Нет в файле» — только по развёртыванию и только среди хостов «В KSC = Да»', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.run('ksc', deploymentReport(DEPLOY));
      await records.createRecord(tx, s.actor, s.hosts.id, { values: { [s.F(s.hosts, 'name').id]: 'TEST-MANUAL' } });
      const p = await s.preview('ksc', deploymentReport(DEPLOY.slice(0, 2)));
      expect(p.summary.missing.map((m) => m.title)).toEqual(['TEST-SRV01']);
      const bases = await s.preview('ksc', basesReport([{ name: 'TEST-PC01NB', status: 'Актуальные', created: '2026-10-30' }]));
      expect(bases.summary.missingTotal).toBe(0);
      expect(bases.summary.warnings.join()).toMatch(/только по отчёту о развёртывании/);
    }));

  it('обрезанный отчёт блокируется до предпросмотра; ненужный отчёт — подсказка', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const before = await tx.registerImport.count();
      await expect(s.preview('ksc', deploymentReport(DEPLOY, { summaryTotal: 1200 }))).rejects.toMatchObject({ code: 'KSC_TRUNCATED' });
      await expect(s.preview('ksc', kscOtherReport('Отчет о владельцах устройств'))).rejects.toMatchObject({ code: 'KSC_NOT_NEEDED' });
      expect(await tx.registerImport.count()).toBe(before);
    }));

  it('дубли в KSC — блок предпросмотра; незнакомый статус баз добавляется в список при применении', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const options = s.F(s.hosts, 'basesStatus').options.length;
      const { preview } = await s.run('ksc', basesReport([
        { name: 'TEST-PC01NB', status: 'Обновлены более 7 дней назад', created: '2026-06-01' },
        { name: 'test-pc01nb.example.local', status: 'Новый статус', created: '2026-10-30' },
      ]));
      expect(preview.summary.blocks).toEqual([expect.objectContaining({ code: 'ksc_duplicates', items: ['TEST-PC01NB → оставлена test-pc01nb.example.local'], optional: false })]);
      expect(preview.summary.warnings.join()).toMatch(/Новый статус/);
      const hosts = await loadRegister(tx, s.hosts.id);
      expect(s.F(hosts, 'basesStatus').options).toHaveLength(options + 1);
      const pc = await s.hostByName('test-pc01nb');
      expect(s.label(hosts, 'basesStatus', pc.values[s.F(hosts, 'basesStatus').id])).toBe('Новый статус');
    }));

  it('«Покрытие защиты» ставит только адаптер: форма — 409', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.run('ksc', deploymentReport(DEPLOY));
      const pc = await s.hostByName('TEST-PC02NB');
      const rec = await records.getRecord(tx, pc.id);
      const cov = s.F(s.hosts, 'coverage');
      await expect(records.updateRecord(tx, s.actor, pc.id, { version: rec.version, values: { [cov.id]: must(cov.options[0]).id } })).rejects.toMatchObject({ code: 'VULN_SERVICE_FIELD' });
    }));
});

describe('реестр сервисов', () => {
  const FILE = () => serviceRegistry([
    { name: 'api', category: 'Mission Critical', address: '10.0.0.5:8080', os: 'Linux Centos 7', classification: 'В эксплуатации', team: 'Команда А', location: 'ЦОД 1', owner: 'Иванов И.' },
    { name: 'db', type: 'База данных', category: 'Business Operatinal', address: '10.0.0.6:5432', classification: 'Тест', team: 'Команда Б' },
    { name: 'api', category: 'Office Productivity', address: '10.0.0.5:9090', classification: 'В эксплуатации', team: 'Команда Б' },
  ]);

  it('предпросмотр ничего не создаёт; применение создаёт продукты, хосты и компоненты со связями', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await updatePortalParam(tx, s.actor, 'assets.teamProducts', { version: 0, value: { 'Команда А': 'Продукт А' } });
      const buf = await FILE();
      const p = await s.preview('services', buf, 'реестр.xlsx');
      expect(p.summary).toMatchObject({ added: 3, errorRows: 0 });
      expect(p.summary.blocks?.map((b) => [b.code, b.items, b.optional])).toEqual([
        ['new_products', ['Продукт А', 'Команда Б'], false],
        ['new_hosts', ['10.0.0.5', '10.0.0.6'], true],
      ]);
      expect(p.summary.blocks?.[0]?.hint).toMatch(/Параметры портала → Активы: команды → продукты/);
      expect(await s.rows(s.services)).toHaveLength(0);
      expect(await s.rows(s.hosts)).toHaveLength(0);

      await excel.applyImport(tx, s.actor, p.id);
      const products = await s.rows(s.services);
      expect(products.map((r) => r.values[s.F(s.services, 'title').id])).toEqual(['Продукт А', 'Команда Б']);
      expect(s.label(s.services, 'status', products[0]?.values[s.F(s.services, 'status').id])).toBe('Работает');
      const hosts = await s.rows(s.hosts);
      expect(hosts.map((r) => [r.values[s.F(s.hosts, 'name').id], s.label(s.hosts, 'source', r.values[s.F(s.hosts, 'source').id]), s.label(s.hosts, 'type', r.values[s.F(s.hosts, 'type').id])]))
        .toEqual([['10.0.0.5', 'Реестр сервисов', 'Сервер'], ['10.0.0.6', 'Реестр сервисов', 'Сервер']]);
      const C = (k: string) => s.F(s.components, k).id;
      const comps = await s.rows(s.components);
      expect(comps).toHaveLength(3);
      const api = must(comps.find((c) => c.values[C('key')] === 'api / продукт а / prod / 10.0.0.5:8080'));
      expect(api.values).toMatchObject({ [C('product')]: [products[0]?.id], [C('host')]: [hosts[0]?.id], [C('ip')]: '10.0.0.5', [C('port')]: '8080', [C('os')]: 'CentOS 7', [C('osSource')]: 'Linux Centos 7' });
      const components = await loadRegister(tx, s.components.id);
      expect(s.label(components, 'location', api.values[C('location')])).toBe('ЦОД 1');
      expect(s.label(components, 'level', api.values[C('level')])).toBe('Mission Critical');
      expect(s.label(components, 'env', api.values[C('env')])).toBe('Prod');
      const db = must(comps.find((c) => c.values[C('key')] === 'db / команда б / test / 10.0.0.6:5432'));
      expect(s.label(components, 'level', db.values[C('level')])).toBe('Operational');
      expect(s.label(components, 'env', db.values[C('env')])).toBe('Test');

      // Повторная загрузка того же файла — без изменений и без новых продуктов и хостов.
      const again = await s.preview('services', buf);
      expect(again.summary).toMatchObject({ added: 0, updated: 0, unchanged: 3 });
      expect(again.summary.blocks).toEqual([]);
    }));

  it('снятый блок хостов не создаётся, компоненты без хоста; отмена ничего не оставляет', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const buf = await FILE();
      const cancelled = await s.preview('services', buf);
      await excel.cancelImport(tx, s.actor, cancelled.id);
      expect([(await s.rows(s.services)).length, (await s.rows(s.hosts)).length, (await s.rows(s.components)).length]).toEqual([0, 0, 0]);

      await s.run('services', buf, ['new_hosts']);
      expect(await s.rows(s.hosts)).toHaveLength(0);
      const comps = await s.rows(s.components);
      expect(comps).toHaveLength(3);
      expect(comps.every((c) => c.values[s.F(s.components, 'host').id] === undefined)).toBe(true);
    }));

  it('продукт, заведённый после предпросмотра, — применение не выполняется целиком', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const p = await s.preview('services', await FILE());
      await records.createRecord(tx, s.actor, s.services.id, { values: { [s.F(s.services, 'title').id]: 'Команда Б' } });
      await expect(excel.applyImport(tx, s.actor, p.id)).rejects.toMatchObject({ code: 'IMPORT_STALE' });
    }));

  it('экземпляры (1.6.1): компонент в Prod и Test и два экземпляра в Prod — три записи; повторный импорт ничего не меняет', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const buf = await serviceRegistry([
        { name: 'b2b-api', address: '10.0.0.5:8070', classification: 'В эксплуатации', team: 'Команда А' },
        { name: 'b2b-api', address: '10.0.1.5:8070', classification: 'Тест', team: 'Команда А' },
        { name: 'b2b-api', address: '10.0.0.6:8070', classification: 'В эксплуатации', team: 'Команда А' },
      ]);
      const p = await s.preview('services', buf);
      expect(p.summary).toMatchObject({ added: 3, errorRows: 0 });
      await excel.applyImport(tx, s.actor, p.id);
      const C = (k: string) => s.F(s.components, k).id;
      const comps = await s.rows(s.components);
      expect(comps.map((c) => c.values[C('instance')]).sort()).toEqual([
        'b2b-api · Prod · 10.0.0.5:8070', 'b2b-api · Prod · 10.0.0.6:8070', 'b2b-api · Test · 10.0.1.5:8070',
      ]);
      expect(new Set(comps.map((c) => c.values[C('key')])).size).toBe(3);
      const again = await s.preview('services', buf);
      expect(again.summary).toMatchObject({ added: 0, updated: 0, unchanged: 3, errorRows: 0 });
    }));

  it('«Экземпляр» компонента, заведённого вручную, считается из полей и пересчитывается при правке', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const F = (k: string) => s.F(s.components, k);
      const prod = must(F('env').options.find((o) => o.systemKey === 'prod')).id;
      const rec = await records.createRecord(tx, s.actor, s.components.id, { values: { [F('title').id]: 'nginx', [F('env').id]: prod, [F('ip').id]: '10.0.0.7' } });
      const row = must(await tx.registerRecord.findUnique({ where: { id: rec.id } }));
      expect((row.values as Record<string, unknown>)[F('instance').id]).toBe('nginx · Prod · 10.0.0.7');
      await records.updateRecord(tx, s.actor, rec.id, { version: row.version, values: { [F('port').id]: '443' } });
      const after = must(await tx.registerRecord.findUnique({ where: { id: rec.id } }));
      expect((after.values as Record<string, unknown>)[F('instance').id]).toBe('nginx · Prod · 10.0.0.7:443');
      await expect(records.updateRecord(tx, s.actor, rec.id, { version: after.version, values: { [F('instance').id]: 'x' } })).rejects.toMatchObject({ code: 'VULN_SERVICE_FIELD' });
    }));

  it('seed 1.6.1: ключ и заголовок существующих записей пересчитываются один раз; совпадение ключей — остановка без изменений', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.run('services', await serviceRegistry([
        { name: 'api', address: '10.0.0.5:80', classification: 'В эксплуатации', team: 'Команда А' },
        { name: 'api', address: '10.0.0.6:80', classification: 'В эксплуатации', team: 'Команда Б' },
      ]));
      const C = (k: string) => s.F(s.components, k).id;
      // Записи 1.6.0: ключ «Компонент / Продукт», заголовка нет.
      for (const c of await s.rows(s.components)) {
        const { [C('instance')]: _i, ...rest } = c.values;
        void _i;
        const prod = String(c.values[C('key')]).split(' / ')[1];
        await tx.registerRecord.update({ where: { id: c.id }, data: { values: { ...rest, [C('key')]: `api / ${prod}` } as object } });
      }
      const marker = 'system.register.assets.components_instance.v1';
      await tx.seedMarker.delete({ where: { key: marker } });
      await seedComponentInstances(tx);
      const comps = await s.rows(s.components);
      expect(comps.map((c) => [c.values[C('key')], c.values[C('instance')]])).toEqual([
        ['api / команда а / prod / 10.0.0.5:80', 'api · Prod · 10.0.0.5:80'],
        ['api / команда б / prod / 10.0.0.6:80', 'api · Prod · 10.0.0.6:80'],
      ]);
      const audit = await tx.auditLog.count({ where: { entity: 'register_record', entityId: { in: comps.map((c) => c.id) }, userId: null } });
      expect(audit).toBe(2);
      // Повтор — отметка стоит, ничего не делает; без отметки — те же значения, записей не меняет.
      await seedComponentInstances(tx);
      await tx.seedMarker.delete({ where: { key: marker } });
      await seedComponentInstances(tx);
      expect(await tx.auditLog.count({ where: { entity: 'register_record', entityId: { in: comps.map((c) => c.id) }, userId: null } })).toBe(2);

      // Два экземпляра с одинаковым новым ключом — не склеиваются, seed останавливается со списком.
      const [a, b] = comps;
      await tx.registerRecord.update({ where: { id: must(b).id }, data: { values: { ...must(b).values, [C('ip')]: '10.0.0.5', [C('product')]: must(a).values[C('product')], [C('key')]: 'старый' } as object } });
      await tx.seedMarker.delete({ where: { key: marker } });
      await expect(seedComponentInstances(tx)).rejects.toThrow(/совпали ключи.*«api \/ команда а \/ prod \/ 10\.0\.0\.5:80» — #\d+, #\d+/);
    }));

  it('«Ключ компонента» вручную не меняется', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await expect(records.createRecord(tx, s.actor, s.components.id, { values: { [s.F(s.components, 'title').id]: 'x', [s.F(s.components, 'key').id]: 'x / y' } }))
        .rejects.toMatchObject({ code: 'VULN_SERVICE_FIELD' });
    }));
});

describe('маршрут импорта с адаптером', () => {
  it('records.edit; адаптер не к своему реестру — 409; skip при применении', () =>
    inTx(async (tx) => {
      const passwordHash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash });
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: false });
      const login = async (name: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const hosts = must(await tx.register.findUnique({ where: { systemKey: ASSET_HOSTS_KEY } }), 'хосты');
      const components = must(await tx.register.findUnique({ where: { systemKey: ASSET_COMPONENTS_KEY } }), 'компоненты');
      const upload = (cookie: string, registerId: string, adapter: string, body: Buffer) => app.inject({
        method: 'POST', url: `/api/v1/registers/${registerId}/imports?adapter=${adapter}`, payload: body,
        headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('отчёт.xls'), origin: TEST_PORTAL_URL },
      });
      const S = await login(staff.login);
      expect((await upload(await login(reader.login), hosts.id, 'ksc', deploymentReport(DEPLOY))).statusCode).toBe(403);
      const wrong = await upload(S, components.id, 'ksc', deploymentReport(DEPLOY));
      expect([wrong.statusCode, wrong.json<{ error: { code: string } }>().error.code]).toEqual([409, 'WRONG_ADAPTER']);
      const ok = await upload(S, components.id, 'services', await serviceRegistry([{ name: 'api', address: '10.0.0.5:80', team: 'Команда А' }]));
      expect(ok.statusCode).toBe(201);
      const id = ok.json<{ id: string }>().id;
      const applied = await app.inject({ method: 'POST', url: `/api/v1/register-imports/${id}/apply`, payload: { skip: ['new_hosts'] }, headers: { cookie: S, origin: TEST_PORTAL_URL } });
      expect(applied.json()).toMatchObject({ added: 1 });
      expect(await tx.registerRecord.count({ where: { registerId: hosts.id } })).toBe(0);
      // Без тела — как до 1.6.0: ничего не снято.
      const ksc = await upload(S, hosts.id, 'ksc', deploymentReport(DEPLOY));
      const plain = await app.inject({ method: 'POST', url: `/api/v1/register-imports/${ksc.json<{ id: string }>().id}/apply`, headers: { cookie: S, origin: TEST_PORTAL_URL } });
      expect([plain.statusCode, plain.json()]).toEqual([200, { added: 3, updated: 0, skipped: 0 }]);
    }));
});
