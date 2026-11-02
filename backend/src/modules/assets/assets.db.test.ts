// Реестр активов и сверка (релиз 1.6.0, ADR-0031) с настоящей БД: seed трёх реестров, единая структура факта,
// пустые источники, выведенные записи, совпавшие имена хостов, сканы, Kaspersky, права. Каждый тест — транзакция с откатом.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { actorFor, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { INCIDENT_REGISTER_KEY } from '../dashboard/incidents.js';
import { loadRegister, type RegisterDef } from '../registers/definition.js';
import * as records from '../registers/records.service.js';
import { RISK_REGISTER_KEY } from '../risks/definition.js';
import { seedAssets } from '../../../prisma/seed/assets.js';
import { ASSET_COMPONENTS_KEY, ASSET_HOSTS_KEY, ASSET_SERVICES_KEY } from './definition.js';
import { updatePortalParam } from '../settings/portal-params.js';
import { assetFacts, assetSections, assetSettingsView } from './service.js';

const NOW = new Date('2026-11-01T06:00:00Z');
const PASSWORD = 'Http-Test-Pass-2026';

async function setup(tx: Tx) {
  const staff = await makeUser(tx, ['ib_staff']);
  const actor = await actorFor(tx, staff.id);
  const byKey = async (systemKey: string) => loadRegister(tx, must(await tx.register.findUnique({ where: { systemKey } }), systemKey).id);
  const svc = await byKey(ASSET_SERVICES_KEY);
  const cmp = await byKey(ASSET_COMPONENTS_KEY);
  const hst = await byKey(ASSET_HOSTS_KEY);
  const dlp = await loadRegister(tx, must(await tx.register.findFirst({ where: { name: 'Устройства DLP' } }), 'DLP').id);
  const risks = await byKey(RISK_REGISTER_KEY);
  const F = (reg: RegisterDef, label: string) => must(reg.fields.find((f) => f.label === label), label);
  const O = (reg: RegisterDef, label: string, option: string) => must(F(reg, label).options.find((o) => o.label === option), option).id;
  const service = async (title: string, v: Record<string, unknown> = {}) => records.createRecord(tx, actor, svc.id, { values: { [F(svc, 'Сервис').id]: title, ...v } });
  const LEVEL = 'Категория критичности';
  const critical = (title: string, v: Record<string, unknown> = {}) => service(title, { [F(svc, LEVEL).id]: O(svc, LEVEL, 'Mission Critical'), ...v });
  const component = async (title: string, v: Record<string, unknown> = {}) => records.createRecord(tx, actor, cmp.id, { values: { [F(cmp, 'Компонент').id]: title, ...v } });
  const host = async (name: string, type: string, v: Record<string, unknown> = {}) =>
    records.createRecord(tx, actor, hst.id, { values: { [F(hst, 'Имя хоста').id]: name, [F(hst, 'Тип').id]: O(hst, 'Тип', type), ...v } });
  const withdraw = async (reg: RegisterDef, rec: { id: string; version: number }, status: string) =>
    records.updateRecord(tx, actor, rec.id, { version: rec.version, values: { [F(reg, 'Статус').id]: O(reg, 'Статус', status) } });
  const scan = async (names: string[], scanDate: string) => {
    const node = await tx.vulnNode.findFirstOrThrow();
    const vulns = must(await tx.register.findUnique({ where: { systemKey: 'vulns' } }), 'уязвимости');
    const imp = await tx.registerImport.create({ data: { registerId: vulns.id, kind: 'scan', status: 'applied', fileName: 's.xlsx', fileSha256: 'x', summary: {}, payload: {}, createdBy: staff.id, expiresAt: NOW } });
    return tx.vulnScan.create({ data: { nodeId: node.id, importId: imp.id, fileName: 's.xlsx', fileSha256: 'x', scanDate: new Date(`${scanDate}T00:00:00Z`), createdBy: staff.id, hosts: names.map((name) => ({ name, ip: '', os: '' })), hostsCount: names.length } });
  };
  const facts = async () => new Map((await assetFacts(tx, NOW)).map((f) => [f.code, f]));
  return { actor, staff, svc, cmp, hst, dlp, risks, F, O, LEVEL, service, critical, component, host, withdraw, scan, facts };
}

describe('seed реестра активов', () => {
  it('реестры, ключи, область сравнения, настройки, метка, напоминание, поле у инцидентов', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      expect(s.F(s.svc, s.LEVEL).options.map((o) => o.label)).toEqual(['Mission Critical', 'Business Critical', 'Operational', 'Non-Critical']);
      expect(s.F(s.cmp, s.LEVEL).options.map((o) => o.label)).toEqual(['Mission Critical', 'Business Critical', 'Operational', 'Non-Critical']);
      expect(s.F(s.svc, 'RTO').settings.hint).toMatch(/Mission Critical — 2 ч/);
      expect(s.F(s.svc, 'RPO').settings.hint).toMatch(/Business Critical — 4–24 ч/);
      expect(s.F(s.svc, 'Пересмотр до').type).toBe('calc');
      expect(s.F(s.hst, 'Сервисы')).toMatchObject({ type: 'link', linkRegisterId: s.svc.id });
      expect(s.F(s.cmp, 'Продукт')).toMatchObject({ type: 'link', linkRegisterId: s.svc.id });
      expect(s.F(s.cmp, 'Хост')).toMatchObject({ type: 'link', linkRegisterId: s.hst.id });
      expect(s.F(s.cmp, 'Ключ компонента')).toMatchObject({ isImportKey: true, managed: true });
      expect(s.F(s.hst, 'Покрытие защиты').managed).toBe(true);
      expect(s.hst.fields.some((f) => f.label === 'Состояние защиты')).toBe(false);
      expect(s.F(s.hst, 'Имя хоста').isImportKey).toBe(true);
      expect(s.hst.compareKeyFieldIds).toEqual([s.F(s.hst, 'Имя хоста').id]);
      expect(s.hst.compareScopeFieldIds).toEqual([s.F(s.hst, 'Тип').id]);
      const view = await assetSettingsView(tx);
      expect(view.levelOptions.filter((o) => view.significantLevelOptionIds.includes(o.id)).map((o) => o.label)).toEqual(['Mission Critical', 'Business Critical']);
      expect(await tx.registerAutomation.count({ where: { registerId: s.svc.id } })).toBe(1);
      expect(await tx.catalogItem.count({ where: { catalogCode: 'notify_recipients', value: 'Активы' } })).toBe(1);
      const incidents = await loadRegister(tx, must(await tx.register.findUnique({ where: { systemKey: INCIDENT_REGISTER_KEY } }), 'инциденты').id);
      expect(s.F(incidents, 'Сервис')).toMatchObject({ type: 'link', linkRegisterId: s.svc.id });
    }));

  it('повторный запуск ничего не добавляет и не восстанавливает удалённое', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const count = await tx.register.count();
      await tx.registerAutomation.deleteMany({ where: { registerId: s.svc.id } });
      await seedAssets(tx);
      expect(await tx.register.count()).toBe(count);
      expect(await tx.registerAutomation.count({ where: { registerId: s.svc.id } })).toBe(0);
    }));

  it('доведение на месте (путь первой редакции): поля не дублируются, записи и выбор значений сохраняются', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const rec = await s.critical('АБС', { [s.F(s.svc, 'Дата классификации').id]: '2026-10-01' });
      const fields = await tx.registerField.count({ where: { registerId: s.svc.id } });
      // Как на dev после первой редакции: прежнее название поля и значения.
      await tx.registerField.update({ where: { id: s.F(s.svc, s.LEVEL).id }, data: { label: 'Уровень системы' } });
      await tx.registerFieldOption.update({ where: { id: s.O(s.svc, s.LEVEL, 'Operational') }, data: { label: 'Operational Critical' } });
      await tx.seedMarker.delete({ where: { key: 'system.register.assets.v2' } });
      await seedAssets(tx);
      const svc = await loadRegister(tx, s.svc.id);
      expect(await tx.registerField.count({ where: { registerId: s.svc.id } })).toBe(fields);
      expect(must(svc.fields.find((f) => f.systemKey === 'level')).options.map((o) => o.label)).toEqual(['Mission Critical', 'Business Critical', 'Operational', 'Non-Critical']);
      const after = await records.getRecord(tx, rec.id);
      expect(after.display[s.F(s.svc, s.LEVEL).id]).toBe('Mission Critical');
      expect(after.display[s.F(s.svc, 'Пересмотр до').id]).toBe('02.04.2027');
    }));
});

describe('единая структура факта и пустые источники', () => {
  it('все реестры пусты: каждая проверка — no_data, без процента и списка', () =>
    inTx(async (tx) => {
      const all = await assetFacts(tx, NOW);
      expect(all.length).toBeGreaterThanOrEqual(30);
      for (const f of all) {
        expect(f).toMatchObject({ status: 'no_data', numerator: null, denominator: null, percent: null, records: [], calculatedAt: NOW.toISOString() });
        expect(f.message).toMatch(/^Нет данных/);
        expect(f.section).toMatch(/^\d+\.\d+$/);
      }
    }));

  it('реестр рисков пуст: «сервис без риска» — no_data с сообщением, хотя значимый сервис есть', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.critical('АБС');
      expect(must((await s.facts()).get('products.without_risk'))).toMatchObject({
        section: '2.3', relatedSections: ['1.2'], status: 'no_data', percent: null, records: [], message: 'Нет данных: реестр рисков не заполнен',
      });
    }));

  it('риск есть: значимый сервис без риска — нарушитель со ссылкой', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const abs = await tx.catalogItem.create({ data: { catalogCode: 'systems', value: 'АБС-тест' } });
      const card = await tx.catalogItem.create({ data: { catalogCode: 'systems', value: 'Карты-тест' } });
      await s.critical('АБС', { [s.F(s.svc, 'Система').id]: abs.id });
      const cards = await s.critical('Карты', { [s.F(s.svc, 'Система').id]: card.id });
      await records.createRecord(tx, s.actor, s.risks.id, { values: { [s.F(s.risks, 'Риск ИБ').id]: 'Простой', [s.F(s.risks, 'Актив / система').id]: abs.id } });
      const f = must((await s.facts()).get('products.without_risk'));
      expect(f).toMatchObject({ status: 'violations', numerator: 1, denominator: 2, percent: 50 });
      expect(f.records).toEqual([{ id: cards.id, title: 'Карты', href: `/registers?record=${cards.id}#${s.svc.id}/records`, detail: null }]);
    }));

  it('только выведенные продукты — источник пуст; выведенные не считаются нигде', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const old = await s.critical('Старый');
      await s.withdraw(s.svc, old, 'Выведен');
      expect(must((await s.facts()).get('products.ownership'))).toMatchObject({ status: 'no_data', message: 'Нет данных: реестр сервисов не заполнен' });
      await s.critical('АБС');
      expect(must((await s.facts()).get('products.ownership'))).toMatchObject({ status: 'violations', numerator: 0, denominator: 1, percent: 0 });
    }));

  it('значимых сервисов нет: no_data, а не 100%', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.service('Портал', { [s.F(s.svc, s.LEVEL).id]: s.O(s.svc, s.LEVEL, 'Non-Critical') });
      expect(must((await s.facts()).get('products.not_monitored'))).toMatchObject({ status: 'no_data', percent: null });
    }));
});

describe('проверки', () => {
  it('владельцы значимого продукта: чего не хватает — в detail; заполненный не нарушитель', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.critical('Полный', { [s.F(s.svc, 'Бизнес-владелец').id]: 'Иванов И.', [s.F(s.svc, 'ИТ-владелец').id]: 'Петров П.', [s.F(s.svc, 'Назначение и бизнес-процессы').id]: 'Платежи' });
      await s.critical('Пустой', { [s.F(s.svc, 'Бизнес-владелец').id]: 'Иванов И.' });
      await s.service('Незначимый');
      const f = must((await s.facts()).get('products.ownership'));
      expect(f).toMatchObject({ numerator: 1, denominator: 2, percent: 50 });
      expect(f.records[0]).toMatchObject({ title: 'Пустой', detail: 'Нет: ИТ-владельца, назначения' });
    }));

  it('пересмотр = дата классификации + 183 дня: нет даты и просрочка — нарушения', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const on = s.F(s.svc, 'Дата классификации').id;
      await s.critical('Свежий', { [on]: '2026-09-01' });
      await s.critical('Просроченный', { [on]: '2026-01-10' }); // + 183 = 2026-07-12
      await s.critical('Без даты');
      const f = must((await s.facts()).get('products.review'));
      expect(f).toMatchObject({ numerator: 1, denominator: 3 });
      expect(f.records.map((r) => r.detail).sort()).toEqual(['Пересмотр не задан: нет даты классификации или категории', 'Пересмотр просрочен: 2026-07-12']);
    }));

  it('классификация: без категории (продукт и компонент), «Работает» без категории, RTO/RPO, связь с рисками, документирование', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const working = s.O(s.svc, 'Статус', 'Работает');
      await s.service('Без категории', { [s.F(s.svc, 'Статус').id]: working });
      await s.critical('Значимый', { [s.F(s.svc, 'RTO').id]: '2 ч', [s.F(s.svc, 'Дата классификации').id]: '2026-10-01' });
      await s.component('api');
      const m = await s.facts();
      expect(must(m.get('products.without_category'))).toMatchObject({ numerator: 1, denominator: 3 });
      expect(must(m.get('products.without_category')).records.map((r) => r.detail).sort()).toEqual(['Компонент', 'Продукт']);
      expect(must(m.get('products.working_without_category'))).toMatchObject({ numerator: 0, denominator: 1 });
      expect(must(m.get('products.rto_rpo')).records[0]?.detail).toBe('Нет: RPO');
      expect(must(m.get('products.risk_link')).records[0]?.detail).toBe('Нет: связи с ключевыми рисками');
      const doc = must(m.get('products.documented'));
      expect(doc.relatedSections).toEqual(['2.3']);
      expect(doc.records.find((r) => r.title === 'Значимый')?.detail).toBe('Нет: согласования руководителем ИБ');
    }));

  it('компонент критичнее продукта; значимый продукт без компонентов и хостов; хосты через компоненты', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const bc = await s.service('Продукт Б', { [s.F(s.svc, s.LEVEL).id]: s.O(s.svc, s.LEVEL, 'Business Critical') });
      const mc = await s.critical('Продукт А');
      const host = await s.host('TEST-SRV01', 'Сервер');
      await s.component('api', { [s.F(s.cmp, 'Продукт').id]: [bc.id], [s.F(s.cmp, s.LEVEL).id]: s.O(s.cmp, s.LEVEL, 'Mission Critical'), [s.F(s.cmp, 'Хост').id]: [host.id] });
      await s.component('db', { [s.F(s.cmp, 'Продукт').id]: [bc.id], [s.F(s.cmp, s.LEVEL).id]: s.O(s.cmp, s.LEVEL, 'Operational') });
      const m = await s.facts();
      const above = must(m.get('components.above_product'));
      expect(above).toMatchObject({ numerator: 1, denominator: 2 });
      expect(above.records[0]).toMatchObject({ title: 'api', detail: 'Mission Critical при продукте «Продукт Б» — Business Critical' });
      expect(must(m.get('products.without_components')).records.map((r) => r.id)).toEqual([mc.id]);
      expect(must(m.get('products.without_hosts')).records.map((r) => r.id)).toEqual([mc.id]);
    }));

  it('неподдерживаемые ОС без плана в продукте; среды Test и Prod', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const p = await s.critical('Продукт А');
      const planned = await s.critical('Продукт Б', { [s.F(s.svc, 'План по устаревшей системе').id]: 'Замена до 2027' });
      const host = await s.host('TEST-SRV01', 'Сервер', { [s.F(s.hst, 'ОС').id]: 'Debian 11' });
      const env = (e: string) => ({ [s.F(s.cmp, 'Среда').id]: s.O(s.cmp, 'Среда', e) });
      await s.component('api', { [s.F(s.cmp, 'Продукт').id]: [p.id], [s.F(s.cmp, 'ОС / ПО').id]: 'CentOS 7', [s.F(s.cmp, 'Хост').id]: [host.id], ...env('Prod') });
      await s.component('test-api', { [s.F(s.cmp, 'Продукт').id]: [p.id], [s.F(s.cmp, 'Хост').id]: [host.id], ...env('Test') });
      await s.component('legacy', { [s.F(s.cmp, 'Продукт').id]: [planned.id], [s.F(s.cmp, 'ОС / ПО').id]: 'centos 7', ...env('Prod') });
      const m = await s.facts();
      const os = must(m.get('assets.unsupported_os'));
      expect(os).toMatchObject({ numerator: 1, denominator: 3 });
      expect(os.records.map((r) => r.title).sort()).toEqual(['TEST-SRV01', 'api']);
      expect(must(m.get('products.test_share'))).toMatchObject({ numerator: 2, denominator: 3 });
      expect(must(m.get('hosts.test_prod_mixed')).records.map((r) => r.title)).toEqual(['TEST-SRV01']);
    }));

  it('сканы: нужен каждый хост значимого сервиса за 90 дней; домен в имени не мешает', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const abs = await s.critical('АБС');
      const link = { [s.F(s.hst, 'Сервисы').id]: [abs.id] };
      await s.host('SRV-01', 'Сервер', link);
      await s.host('SRV-02', 'Сервер', link);
      expect(must((await s.facts()).get('products.not_scanned'))).toMatchObject({ status: 'no_data', message: 'Нет данных: сканы не загружены' });
      await s.scan(['srv-01.example.local', 'SRV-03'], '2026-10-20');
      await s.scan(['SRV-02'], '2026-01-01'); // старше 90 дней
      const m = await s.facts();
      const f = must(m.get('products.not_scanned'));
      expect(f).toMatchObject({ status: 'violations', numerator: 0, denominator: 1 });
      expect(f.records[0]?.detail).toBe('Не было в сканах: SRV-02');
      // Кандидаты: SRV-03 нет в реестре; ссылка на скан.
      const c = must(m.get('scan_hosts.not_in_registry'));
      expect(c).toMatchObject({ numerator: 1, denominator: 2 });
      expect(c.records[0]).toMatchObject({ title: 'SRV-03', detail: 'Кандидат на добавление' });
      expect(c.records[0]?.href).toMatch(/^\/vulns\/scan\//);
    }));

  it('выведенный хост: не кандидат из сканов и не участвует в сервисе', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.host('SRV-01', 'Сервер');
      const old = await s.host('SRV-OLD', 'Сервер');
      await s.withdraw(s.hst, old, 'Выведен');
      await s.scan(['SRV-01', 'SRV-OLD'], '2026-10-20');
      expect(must((await s.facts()).get('scan_hosts.not_in_registry'))).toMatchObject({ status: 'ok', numerator: 1, denominator: 1, records: [] });
    }));

  it('совпавшие имена: предупреждение со ссылками, записи остаются отдельными', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const a = await s.host('WS-01', 'Рабочая станция');
      const b = await s.host('ws-01.example.local', 'Рабочая станция');
      const cov = s.F(s.hst, 'Покрытие защиты');
      await tx.registerRecord.update({ where: { id: a.id }, data: { values: { ...(await tx.registerRecord.findUniqueOrThrow({ where: { id: a.id } })).values as object, [cov.id]: must(cov.options.find((o) => o.systemKey === 'full')).id } } });
      const f = must((await s.facts()).get('ksc.workstations_coverage'));
      expect(f.denominator).toBe(2);
      expect(f.warnings).toHaveLength(1);
      expect(f.warnings[0]?.code).toBe('host_name_collision');
      expect(f.warnings[0]?.records.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    }));

  it('рабочие станции: сверка с DLP в обе стороны; серверы не требуют агента', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.host('WS-01', 'Рабочая станция');
      await s.host('WS-02', 'Рабочая станция');
      await s.host('SRV-01', 'Сервер');
      expect(must((await s.facts()).get('workstations.without_dlp'))).toMatchObject({ status: 'no_data', message: 'Нет данных: реестр устройств DLP не заполнен' });
      for (const name of ['ws-01', 'WS-99']) await records.createRecord(tx, s.actor, s.dlp.id, { values: { [s.F(s.dlp, 'Имя хоста').id]: name } });
      const m = await s.facts();
      const w = must(m.get('workstations.without_dlp'));
      expect(w).toMatchObject({ numerator: 1, denominator: 2 });
      expect(w.records[0]?.title).toBe('WS-02');
      const d = must(m.get('dlp.without_host'));
      expect(d).toMatchObject({ numerator: 1, denominator: 2 });
      expect(d.records[0]?.title).toBe('WS-99');
    }));

  it('Kaspersky: агент молчит, устаревшие базы, минимальная версия; без отчётов — no_data', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const v = (label: string, value: string) => ({ [s.F(s.hst, label).id]: value });
      const outdated = s.O(s.hst, 'Статус антивирусных баз', 'Обновлены более 7 дней назад');
      const fresh = s.O(s.hst, 'Статус антивирусных баз', 'Актуальные');
      await s.host('WS-SILENT', 'Рабочая станция', { ...v('Последнее появление в сети', '2026-10-30'), ...v('Последняя связь с Kaspersky', '2026-09-01'), [s.F(s.hst, 'Статус антивирусных баз').id]: outdated, ...v('Версия защиты', '11.10.0') });
      await s.host('WS-OK', 'Рабочая станция', { ...v('Последнее появление в сети', '2026-10-30'), ...v('Последняя связь с Kaspersky', '2026-10-30'), [s.F(s.hst, 'Статус антивирусных баз').id]: fresh, ...v('Версия защиты', '12.5.0') });
      await s.host('WS-AWAY', 'Рабочая станция', { ...v('Последнее появление в сети', '2026-09-01'), ...v('Последняя связь с Kaspersky', '2026-08-01') });
      let m = await s.facts();
      expect(must(m.get('ksc.agent_silent'))).toMatchObject({ numerator: 1, denominator: 2 });
      expect(must(m.get('ksc.agent_silent')).records[0]?.title).toBe('WS-SILENT');
      expect(must(m.get('ksc.bases_outdated'))).toMatchObject({ numerator: 1, denominator: 2 });
      expect(must(m.get('ksc.version_below_min'))).toMatchObject({ status: 'no_data', message: 'Нет данных: минимальная версия защиты не задана в «Параметрах портала»' });
      expect(must(m.get('ksc.workstations_coverage'))).toMatchObject({ status: 'no_data', message: 'Нет данных: отчёт о развёртывании защиты не загружен' });
      expect(must(m.get('ksc.deployment_stale')).status).toBe('no_data');
      await updatePortalParam(tx, s.actor, 'assets.minProtectionVersion', { version: 0, value: '12.5' });
      m = await s.facts();
      expect(must(m.get('ksc.version_below_min'))).toMatchObject({ title: 'Версия защиты не ниже 12.5', numerator: 1, denominator: 2 });
    }));

  it('устаревшие системы: без плана — нарушение; не отмечены — no_data', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.service('Обычный', { [s.F(s.svc, 'Устаревшая система').id]: s.O(s.svc, 'Устаревшая система', 'Нет') });
      expect(must((await s.facts()).get('products.legacy_without_plan')).status).toBe('no_data');
      await s.service('Древний', { [s.F(s.svc, 'Устаревшая система').id]: s.O(s.svc, 'Устаревшая система', 'Да') });
      expect(must((await s.facts()).get('products.legacy_without_plan'))).toMatchObject({ status: 'violations', numerator: 0, denominator: 1 });
    }));

  it('сверка ничего не пишет', () =>
    inTx(async (tx) => {
      const before = await tx.auditLog.count();
      await assetFacts(tx, NOW);
      expect(await tx.auditLog.count()).toBe(before);
    }));
});

describe('разделы методики', () => {
  it('текст каждого раздела из проверок, включая связанные; все четыре уровня', () =>
    inTx(async (tx) => {
      const facts = await assetFacts(tx, NOW);
      const sections = await assetSections(tx, facts);
      expect(sections.map((s) => s.code)).toEqual(['1.2', '2.2', '2.3', '3.2', '5.2', '8.2', '9.2', '9.3']);
      const s = must(sections.find((x) => x.code === '2.2'));
      expect([s.name, s.domainNo, s.domainName]).toEqual(['Инвентаризация активов', 2, 'Управление активами']);
      expect(s.target).toContain('единая база активов');
      expect(s.levels.map((l) => l.name)).toEqual(['Базовый', 'Средний', 'Высокий', 'Продвинутый']);
      expect(s.levels.every((l) => l.criteria.length > 0)).toBe(true);
      expect(must(sections.find((x) => x.code === '1.2')).key).toBe(true);
    }));

  it('методика не загружена: разделов нет, сверка работает', () =>
    inTx(async (tx) => {
      await tx.assessmentMethodology.updateMany({ where: { isActive: true }, data: { isActive: false } });
      expect(await assetSections(tx, await assetFacts(tx, NOW))).toEqual([]);
    }));
});

describe('настройки сверки', () => {
  it('меняется состав значимых категорий', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.service('Обычный', { [s.F(s.svc, s.LEVEL).id]: s.O(s.svc, s.LEVEL, 'Operational') });
      expect(must((await s.facts()).get('products.not_monitored')).status).toBe('no_data');
      const view = await assetSettingsView(tx);
      await updatePortalParam(tx, s.actor, 'assets', { version: view.version, value: { significantLevelOptionIds: [s.O(s.svc, s.LEVEL, 'Operational')], dlpRegisterId: null } });
      expect(must((await s.facts()).get('products.not_monitored')).status).toBe('violations');
    }));
});

describe('маршруты', () => {
  it('сверка — ib.work', () =>
    inTx(async (tx) => {
      const passwordHash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash });
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: false });
      const login = async (name: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      expect((await app.inject({ url: '/api/v1/assets/checks' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1/assets/checks', headers: { cookie: await login(reader.login) } })).statusCode).toBe(403);
      const S = await login(staff.login);
      const checks = await app.inject({ url: '/api/v1/assets/checks', headers: { cookie: S } });
      expect(checks.statusCode).toBe(200);
      expect(checks.json<{ sections: unknown[] }>().sections.length).toBe(8);
      // Текст методики виден сотруднику, сам раздел самооценки — нет.
      expect((await app.inject({ url: '/api/v1/assessments', headers: { cookie: S } })).statusCode).toBe(403);
    }));
});
