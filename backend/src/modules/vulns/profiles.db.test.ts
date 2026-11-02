// Профили сканирования VM (релиз 1.6.0): seed справочника, предупреждение о несовпадении, импорт с группы, регулярность.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { expectCode, inTx, lastAudit, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { SAMPLE, SAMPLE_NAME, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { PROFILE_TYPES, seedVulnGroups } from '../../../prisma/seed/vuln-groups.js';
import { assetFacts } from '../assets/service.js';
import { cancelImport } from '../registers/excel.service.js';
import { XLSX_TYPE } from '../registers/routes.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as groups from './groups.service.js';
import { VULN_SETTINGS_KEY, groupScanTarget } from './profiles.js';
import * as scan from './scan-import.service.js';
import { getScan } from './scans.service.js';
import { overview } from './section.service.js';

const root = mkdtempSync(join(tmpdir(), 'ibportal-profiles-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PASSWORD = 'Vulns-Test-Pass-2026';
const MARKER = 'starter.system_types.profiles.v1';
const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const catalog = groups.SYSTEM_TYPES_CATALOG;

const typeId = async (tx: Tx, value: string) => (await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: catalog, value, deletedAt: null } })).id;

async function makeGroup(tx: Tx, x: VulnFixture, ...types: string[]) {
  return groups.createGroup(tx, x.actor, { name: unique('Хумо Онлайн'), kind: 'service', systemTypeIds: await Promise.all(types.map((t) => typeId(tx, t))) });
}

describe('seed профилей', () => {
  it('значения есть; повторный запуск не дублирует, в том числе без отметки', () =>
    inTx(async (tx) => {
      const before = await tx.catalogItem.count({ where: { catalogCode: catalog } });
      for (const v of PROFILE_TYPES) await typeId(tx, v);
      await seedVulnGroups(tx);
      await tx.seedMarker.delete({ where: { key: MARKER } });
      await seedVulnGroups(tx);
      expect(await tx.catalogItem.count({ where: { catalogCode: catalog } })).toBe(before);
    }));

  it('значение в другом регистре не переименовывается и не дублируется; нет значения — добавляется', () =>
    inTx(async (tx) => {
      await tx.catalogItem.update({ where: { id: await typeId(tx, 'Linux') }, data: { value: 'LINUX' } });
      await tx.catalogItem.update({ where: { id: await typeId(tx, 'Docker') }, data: { deletedAt: new Date() } });
      await tx.seedMarker.delete({ where: { key: MARKER } });
      await seedVulnGroups(tx);
      const rows = await tx.catalogItem.findMany({ where: { catalogCode: catalog, deletedAt: null, value: { in: ['Linux', 'LINUX', 'Docker'] } } });
      expect(rows.map((r) => r.value).sort()).toEqual(['Docker', 'LINUX']);
    }));

  it('архивированное значение при повторе не восстанавливается', () =>
    inTx(async (tx) => {
      const id = await typeId(tx, 'Website');
      await tx.catalogItem.update({ where: { id }, data: { archivedAt: new Date() } });
      await seedVulnGroups(tx);
      expect((await tx.catalogItem.findUniqueOrThrow({ where: { id } })).archivedAt).not.toBeNull();
    }));
});

describe('несовпадение профиля файла и типа узла', () => {
  const LINUX_NAME = 'Scan_Linux_2026-10-15.xlsx';

  it('предупреждение в предпросмотре; без подтверждения — ничего; с подтверждением — в скане и журнале', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const g = await makeGroup(tx, x, 'Windows');
      const node = must(g.nodes[0]);
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, LINUX_NAME);
      expect(p.summary.profile).toMatchObject({ detected: { label: 'Linux' }, nodeType: { label: 'Windows' }, mismatch: true });
      await expectCode(scan.applyNodeScan(tx, x.actor, p.id, {}), 'PROFILE_NOT_CONFIRMED');
      await expectCode(scan.applyNodeScan(tx, x.actor, p.id, { profileConfirmed: false }), 'PROFILE_NOT_CONFIRMED');
      expect(await tx.vulnScan.count({ where: { nodeId: node.id } })).toBe(0);

      const r = await scan.applyNodeScan(tx, x.actor, p.id, { profileConfirmed: true });
      const shown = await getScan(tx, r.scanId);
      expect(shown.comparison?.profileMismatch).toMatchObject({ fileProfile: { label: 'Linux' }, nodeType: { label: 'Windows' }, confirmedBy: x.actor.id });
      const audit = await lastAudit(tx);
      expect(JSON.stringify(audit.diff)).toContain('подтверждено, что файл относится к узлу');
      expect((audit.diff as { after: { profileMismatch: { confirmedBy: string } } }).after.profileMismatch.confirmedBy).toBe(x.actor.id);
    }));

  it('профиль совпал или не найден — как раньше, без подтверждения', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const g = await makeGroup(tx, x, 'Windows', 'Linux');
      const [win, linux] = [must(g.nodes.find((n) => n.label === 'Windows')), must(g.nodes.find((n) => n.label === 'Linux'))];
      const same = await scan.previewNodeScan(tx, store, x.actor, win.id, SAMPLE, SAMPLE_NAME);
      expect(same.summary.profile?.mismatch).toBe(false);
      const none = await scan.previewNodeScan(tx, store, x.actor, linux.id, SAMPLE, 'Отчёт 2026_10_15.xlsx');
      expect(none.summary.profile).toMatchObject({ detected: null, mismatch: false });
      const applied = await scan.applyNodeScan(tx, x.actor, none.id, {});
      expect((await getScan(tx, applied.scanId)).comparison?.profileMismatch).toBeNull();
    }));

  it('синонимы из настроек; значение в архиве профилем не считается', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const g = await makeGroup(tx, x, 'Windows');
      const pg = await typeId(tx, 'PostgreSQL');
      await tx.appSetting.upsert({ where: { key: VULN_SETTINGS_KEY }, create: { key: VULN_SETTINGS_KEY, value: { profileAliases: { [pg]: ['pg'] } } }, update: { value: { profileAliases: { [pg]: ['pg'] } } } });
      expect((await groupScanTarget(tx, g.id, 'scan-pg.xlsx')).detected?.label).toBe('PostgreSQL');
      await tx.catalogItem.update({ where: { id: pg }, data: { archivedAt: new Date() } });
      expect((await groupScanTarget(tx, g.id, 'Scan_PostgreSQL.xlsx')).detected).toBeNull();
    }));
});

describe('импорт со страницы группы', () => {
  it('предлагается узел профиля; типа нет в группе — создаёт узел только право «Конструктор реестров»', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const g = await makeGroup(tx, x, 'Windows');
      const passwordHash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash });
      const admin = await makeUser(tx, ['super_admin'], { passwordHash });
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store, logger: false });
      const login = async (name: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const S = await login(staff.login);
      const target = (name: string, cookie: string) => app.inject({ url: `/api/v1/vulns/groups/${g.id}/scan-target?fileName=${encodeURIComponent(name)}`, headers: { cookie } });

      expect((await target(SAMPLE_NAME, await login(reader.login))).statusCode).toBe(403);
      expect((await target(SAMPLE_NAME, S)).json()).toMatchObject({ detected: { label: 'Windows' }, nodeId: must(g.nodes[0]).id });
      expect((await target('Отчёт.xlsx', S)).json()).toEqual({ detected: null, nodeId: null });
      const linuxTarget = (await target('Scan_Linux.xlsx', S)).json<{ detected: { id: string }; nodeId: string | null }>();
      expect(linuxTarget.nodeId).toBeNull();

      const add = (cookie: string) => app.inject({ method: 'POST', url: `/api/v1/vulns/groups/${g.id}/nodes`, headers: { cookie }, payload: { systemTypeIds: [linuxTarget.detected.id] } });
      expect((await add(S)).statusCode).toBe(403);
      expect(await tx.vulnNode.count({ where: { groupId: g.id } })).toBe(1);
      expect((await add(await login(admin.login))).statusCode).toBe(200);
      const after = (await target('Scan_Linux.xlsx', S)).json<{ nodeId: string }>();
      expect(after.nodeId).toEqual(expect.any(String));

      const p = await scan.previewNodeScan(tx, store, x.actor, after.nodeId, SAMPLE, 'Scan_Linux_2026-10-15.xlsx');
      expect(p.summary.profile?.mismatch).toBe(false);
    }));

  it('«Без группы» — отказ', () =>
    inTx(async (tx) => {
      const legacy = await groups.legacyNode(tx);
      await expectCode(groupScanTarget(tx, legacy.groupId, SAMPLE_NAME), 'LEGACY_NODE');
    }));
});

describe('регулярность сканирования', () => {
  const NOW = new Date('2026-11-02T09:00:00Z');
  const fact = async (tx: Tx) => must((await assetFacts(tx, NOW)).find((f) => f.code === 'vuln_nodes.without_recent_scan'));
  async function scanAt(tx: Tx, x: VulnFixture, nodeId: string, date: string) {
    const imp = await tx.registerImport.create({ data: { registerId: x.reg.id, kind: 'scan', fileName: 's.xlsx', fileSha256: 'x', summary: {}, payload: {}, createdBy: x.actor.id, expiresAt: NOW, status: 'applied' } });
    await tx.vulnScan.create({ data: { nodeId, importId: imp.id, fileName: 's.xlsx', fileSha256: 'x', scanDate: new Date(`${date}T00:00:00Z`), createdBy: x.actor.id } });
  }

  it('узлов нет — «Нет данных»; «Без группы» не считается', () =>
    inTx(async (tx) => {
      expect(await fact(tx)).toMatchObject({ section: '5.2', status: 'no_data', numerator: null, denominator: null, percent: null, records: [], message: 'Нет данных: узлов уязвимостей нет', calculatedAt: NOW.toISOString() });
    }));

  it('сверка: старый и пропущенный узел — нарушители со ссылкой; порог из настроек', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const g = await makeGroup(tx, x, 'Windows', 'Linux', 'Docker');
      const by = (l: string) => must(g.nodes.find((n) => n.label === l)).id;
      await scanAt(tx, x, by('Windows'), '2026-10-30');
      await scanAt(tx, x, by('Linux'), '2026-07-01');
      await scanAt(tx, x, by('Linux'), '2026-06-01');
      const f = await fact(tx);
      expect(f).toMatchObject({ status: 'violations', numerator: 1, denominator: 3, percent: 33.3 });
      expect(f.records.map((r) => [r.id, r.href])).toEqual(expect.arrayContaining([[by('Linux'), `/vulns/node/${by('Linux')}`], [by('Docker'), `/vulns/node/${by('Docker')}`]]));
      expect(f.records.find((r) => r.id === by('Linux'))?.detail).toContain('124 дн. назад');
      expect(f.records.find((r) => r.id === by('Docker'))?.detail).toBe('Сканов нет');

      await tx.appSetting.upsert({ where: { key: VULN_SETTINGS_KEY }, create: { key: VULN_SETTINGS_KEY, value: { scanMaxAgeDays: 200 } }, update: { value: { scanMaxAgeDays: 200 } } });
      expect(await fact(tx)).toMatchObject({ numerator: 2, denominator: 3, title: 'Узел уязвимостей сканировали за 200 дней' });
    }));

  it('обзор раздела: возраст скана, список узлов дольше порога, без «Без группы»', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const g = await makeGroup(tx, x, 'Windows', 'Linux');
      const by = (l: string) => must(g.nodes.find((n) => n.label === l)).id;
      await scanAt(tx, x, by('Windows'), new Date().toISOString().slice(0, 10));
      const ov = await overview(tx);
      expect(ov.scanMaxAgeDays).toBe(90);
      expect(ov.nodes.find((n) => n.nodeId === by('Windows'))).toMatchObject({ scanAgeDays: 0, scanStale: false });
      expect(ov.nodes.find((n) => n.nodeId === by('Linux'))).toMatchObject({ scanAgeDays: null, scanStale: true });
      const legacy = await groups.legacyNode(tx);
      expect(ov.nodes.find((n) => n.nodeId === legacy.id)).toMatchObject({ scanStale: false });
      expect(ov.staleNodes).toEqual([{ nodeId: by('Linux'), label: `${g.name} / Linux`, lastScanDate: null, ageDays: null }]);
    }));
});

describe('импорт с группы в тип, которого нет: узел только при применении', () => {
  const NAME = 'Scan_Linux_2026-10-15.xlsx';
  async function start(tx: Tx) {
    const x = await vulnRegister(tx);
    const g = await makeGroup(tx, x, 'Windows');
    const linux = await typeId(tx, 'Linux');
    return { x, g, linux, nodes: () => tx.vulnNode.count({ where: { groupId: g.id } }) };
  }

  it('предпросмотр — пустой реестр: все новые, пропавших нет; узла нет', () =>
    inTx(async (tx) => {
      const { x, g, linux, nodes } = await start(tx);
      const p = await scan.previewNewNodeScan(tx, store, x.actor, g.id, linux, SAMPLE, NAME);
      expect(p.summary.counts).toMatchObject({ new: 90, reopened: 0, changed: 0, unchanged: 0, gone: 0 });
      expect(p.summary.node).toEqual({ id: null, label: `${g.name} / Linux` });
      expect(p.summary.profile?.mismatch).toBe(false);
      expect(p.summary.previousScan).toBeNull();
      expect(await nodes()).toBe(1);
      expect((await scan.getNodeScanImport(tx, p.id)).status).toBe('preview');
    }));

  it('отмена ничего не оставляет: ни узла, ни скана, ни записей', () =>
    inTx(async (tx) => {
      const { x, g, linux, nodes } = await start(tx);
      const scansBefore = await tx.vulnScan.count();
      const recordsBefore = await tx.vulnRecord.count();
      const p = await scan.previewNewNodeScan(tx, store, x.actor, g.id, linux, SAMPLE, NAME);
      await cancelImport(tx, x.actor, p.id);
      expect(await nodes()).toBe(1);
      expect(await tx.vulnScan.count()).toBe(scansBefore);
      expect(await tx.vulnRecord.count()).toBe(recordsBefore);
      await expectCode(scan.applyNodeScan(tx, x.actor, p.id, { canAddNode: true }), 'IMPORT_NOT_PENDING');
      expect(await nodes()).toBe(1);
    }));

  it('ошибка чтения файла ничего не оставляет', () =>
    inTx(async (tx) => {
      const { x, g, linux, nodes } = await start(tx);
      const imports = await tx.registerImport.count();
      await expect(scan.previewNewNodeScan(tx, store, x.actor, g.id, linux, Buffer.from('не xlsx'), NAME)).rejects.toThrow();
      expect(await nodes()).toBe(1);
      expect(await tx.registerImport.count()).toBe(imports);
    }));

  it('применение создаёт узел с правом; без права — 403 и узла нет; узел успели завести — отказ', () =>
    inTx(async (tx) => {
      const { x, g, linux, nodes } = await start(tx);
      const p = await scan.previewNewNodeScan(tx, store, x.actor, g.id, linux, SAMPLE, NAME);
      await expectCode(scan.applyNodeScan(tx, x.actor, p.id, {}), 'FORBIDDEN');
      expect(await nodes()).toBe(1);
      const r = await scan.applyNodeScan(tx, x.actor, p.id, { canAddNode: true });
      expect(await nodes()).toBe(2);
      const made = await tx.vulnNode.findFirstOrThrow({ where: { groupId: g.id, systemTypeId: linux } });
      expect(await tx.vulnRecord.count({ where: { nodeId: made.id } })).toBe(90);
      expect((await tx.vulnScan.findUniqueOrThrow({ where: { id: r.scanId } })).nodeId).toBe(made.id);
      expect(await tx.auditLog.count({ where: { action: 'vuln.node.created', entityId: g.id, diff: { path: ['after', 'nodeId'], equals: made.id } } })).toBe(1);

      await expectCode(scan.previewNewNodeScan(tx, store, x.actor, g.id, linux, SAMPLE, NAME), 'NODE_EXISTS');
      const docker = await typeId(tx, 'Docker');
      const q = await scan.previewNewNodeScan(tx, store, x.actor, g.id, docker, SAMPLE, 'Scan_Docker_2026-10-15.xlsx');
      await groups.addNodes(tx, x.actor, g.id, [docker]);
      await expectCode(scan.applyNodeScan(tx, x.actor, q.id, { canAddNode: true }), 'NODE_EXISTS');
    }));

  it('«Без группы» и маршрут: нужно и право импорта, и право структуры', () =>
    inTx(async (tx) => {
      const { x, g, linux } = await start(tx);
      const legacy = await groups.legacyNode(tx);
      await expectCode(scan.previewNewNodeScan(tx, store, x.actor, legacy.groupId, linux, SAMPLE, NAME), 'SYSTEM_GROUP');
      const passwordHash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store, logger: false });
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: staff.login, password: PASSWORD } });
      const cookie = `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      const up = await app.inject({ method: 'POST', url: `/api/v1/vulns/groups/${g.id}/scan-imports?systemTypeId=${linux}`, body: SAMPLE, headers: { cookie, 'content-type': XLSX_TYPE, 'x-file-name': NAME } });
      expect(up.statusCode).toBe(403);
    }));
});

describe('«Сменить тип узла»', () => {
  it('реестр и сканы остаются у узла; журнал и история; новый импорт сравнивается с новым типом', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const g = await makeGroup(tx, x, 'Рабочие станции');
      const node = must(g.nodes[0]);
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
      const applied = await scan.applyNodeScan(tx, x.actor, p.id, { profileConfirmed: true });
      const [oldType, windows] = [await typeId(tx, 'Рабочие станции'), await typeId(tx, 'Windows')];

      const after = await groups.changeNodeType(tx, x.actor, node.id, { systemTypeId: windows, fromTypeId: oldType });
      expect(after.nodes.map((n) => [n.id, n.label])).toEqual([[node.id, 'Windows']]);
      expect(await tx.vulnRecord.count({ where: { nodeId: node.id } })).toBe(90);
      expect((await tx.vulnScan.findUniqueOrThrow({ where: { id: applied.scanId } })).nodeId).toBe(node.id);
      expect((await getScan(tx, applied.scanId)).comparison?.profileMismatch).toMatchObject({ nodeType: { label: 'Рабочие станции' } });

      const audit = await lastAudit(tx);
      expect(audit).toMatchObject({ action: 'vuln.node.type_changed', entity: 'vuln_node', entityId: node.id });
      expect(audit.diff).toMatchObject({ before: { label: 'Рабочие станции' }, after: { label: 'Windows' } });
      const history = await groups.nodeHistory(tx, node.id);
      expect(history.map((h) => h.summary)).toEqual([expect.stringContaining('«Рабочие станции» заменён на «Windows»')]);

      expect((await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME)).summary.profile?.mismatch).toBe(false);
    }));

  it('только на тип, которого нет в группе; архивный, «Без группы», устаревшее окно — отказ', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const g = await makeGroup(tx, x, 'Windows', 'Linux');
      const node = must(g.nodes.find((n) => n.label === 'Windows'));
      const [windows, linux, docker] = [await typeId(tx, 'Windows'), await typeId(tx, 'Linux'), await typeId(tx, 'Docker')];
      await expectCode(groups.changeNodeType(tx, x.actor, node.id, { systemTypeId: linux, fromTypeId: windows }), 'NODE_EXISTS');
      await expectCode(groups.changeNodeType(tx, x.actor, node.id, { systemTypeId: windows, fromTypeId: windows }), 'NODE_EXISTS');
      await expectCode(groups.changeNodeType(tx, x.actor, node.id, { systemTypeId: docker, fromTypeId: linux }), 'VERSION_CONFLICT');
      const legacy = await groups.legacyNode(tx);
      await expectCode(groups.changeNodeType(tx, x.actor, legacy.id, { systemTypeId: docker, fromTypeId: windows }), 'LEGACY_NODE');
      await tx.catalogItem.update({ where: { id: docker }, data: { archivedAt: new Date() } });
      await expectCode(groups.changeNodeType(tx, x.actor, node.id, { systemTypeId: docker, fromTypeId: windows }), 'BAD_TYPE');
    }));

  it('маршрут — только registers.manage; история — history.view', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const g = await makeGroup(tx, x, 'Windows');
      const node = must(g.nodes[0]);
      const passwordHash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash });
      const admin = await makeUser(tx, ['super_admin'], { passwordHash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store, logger: false });
      const login = async (name: string) => `ib_session=${(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password: PASSWORD } })).cookies.find((c) => c.name === 'ib_session')?.value}`;
      const [S, A] = [await login(staff.login), await login(admin.login)];
      const payload = { systemTypeId: await typeId(tx, 'Docker'), fromTypeId: await typeId(tx, 'Windows') };
      const change = (cookie: string) => app.inject({ method: 'PATCH', url: `/api/v1/vulns/nodes/${node.id}/type`, headers: { cookie }, payload });
      expect((await change(S)).statusCode).toBe(403);
      expect((await change(A)).statusCode).toBe(200);
      const hist = (cookie: string) => app.inject({ url: `/api/v1/vulns/nodes/${node.id}/history`, headers: { cookie } });
      expect((await hist(S)).statusCode).toBe(403);
      expect((await hist(A)).statusCode).toBe(200);
    }));
});
