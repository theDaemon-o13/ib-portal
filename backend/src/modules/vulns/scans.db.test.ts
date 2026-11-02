// Шаг 4 релиза 1.5.0 (ADR-0030): сканы, передача ИКТ, срок от первого переданного скана, чтение раздела.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { addDays, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { expectCode, inTx, lastAudit, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { SAMPLE, SAMPLE_NAME, sampleBook, toBuffer, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { seedVulnLegacy } from '../../../prisma/seed/vuln-legacy.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { runAutomations } from '../automations/service.js';
import { uploadFile, getFileMeta } from '../files/service.js';
import { vulnsBlock } from '../monitor/service.js';
import * as records from '../registers/records.service.js';
import * as groups from './groups.service.js';
import * as scan from './scan-import.service.js';
import * as scans from './scans.service.js';
import * as section from './section.service.js';
import { transferRecords } from './transfer.service.js';

const root = mkdtempSync(join(tmpdir(), 'ibportal-scans-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function setup(tx: Tx) {
  const x = await vulnRegister(tx);
  const t = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: 'Windows' } });
  const g = await groups.createGroup(tx, x.actor, { name: unique('Отдел карт'), kind: 'department', systemTypeIds: [t.id] });
  return { x, node: must(g.nodes[0]) };
}

async function load(tx: Tx, x: VulnFixture, nodeId: string, name: string, buffer: Buffer = SAMPLE, input: scan.ApplyScanInput = {}) {
  const p = await scan.previewNodeScan(tx, store, x.actor, nodeId, buffer, name);
  const applied = await scan.applyNodeScan(tx, x.actor, p.id, input);
  await x.reload();
  return applied;
}

async function rec(tx: Tx, x: VulnFixture, nodeId: string, cve: string) {
  const rows = await tx.vulnRecord.findMany({ where: { nodeId, keyNorm: { not: null } }, include: { record: true } });
  const r = must(rows.find((v) => (v.record.values as Values)[x.vf.cve.id] === cve), cve);
  return { vuln: r, dto: await records.getRecord(tx, r.recordId) };
}

const CRITICAL_CVE = 'CVE-2024-21413';

describe('передача ИКТ', () => {
  it('срок начинается от даты передачи; журнал и история; повторная — 409; даты проверяются; файл письма', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const a = await load(tx, x, node.id, SAMPLE_NAME);
      expect((await rec(tx, x, node.id, CRITICAL_CVE)).dto.calc[x.vf.due.id]).toBeNull();

      await expectCode(scans.handOverScan(tx, x.actor, a.scanId, { date: '2026-10-14' }), 'BAD_DATE');
      await expectCode(scans.handOverScan(tx, x.actor, a.scanId, { date: addDays(todayIso(), 1) }), 'BAD_DATE');
      const letter = await uploadFile(tx, store, x.actor, 'письмо.txt', Buffer.from('служебка'));
      const res = await scans.handOverScan(tx, x.actor, a.scanId, { date: '2026-10-15', fileId: letter.id });
      expect(res).toMatchObject({ started: 90, keptLegacy: 0 });
      const { dto, vuln } = await rec(tx, x, node.id, CRITICAL_CVE);
      expect(dto.values[x.vf.notified.id]).toBe('2026-10-15');
      expect(dto.calc[x.vf.due.id]).toBe('2026-10-29'); // + 14 дней, четверг
      expect(vuln.deadlineScanId).toBe(a.scanId);
      const h = must((await records.recordHistory(tx, dto.id))[0]);
      expect(h.summary).toContain('отчёт передан ИКТ 15.10.2026, срок по процедуре: 29.10.2026');
      const audit = await lastAudit(tx);
      expect([audit.action, audit.entityId]).toEqual(['vuln.scan.handed_over', a.scanId]);

      const brief = (await scans.listScans(tx, node.id))[0];
      expect(brief?.handover).toMatchObject({ date: '2026-10-15', to: 'ОИКТ', fileId: letter.id });
      await expectCode(scans.handOverScan(tx, x.actor, a.scanId, { date: '2026-10-16' }), 'ALREADY_HANDED_OVER');
      expect((await getFileMeta(tx, x.actor, letter.id)).refs.map((r) => r.kind)).toEqual(['vuln_scan']);
    }));

  it('окончание на выходном переносится на рабочий день', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const a = await load(tx, x, node.id, SAMPLE_NAME);
      await scans.handOverScan(tx, x.actor, a.scanId, { date: '2026-10-17' }); // + 14 = суббота 31.10
      expect((await rec(tx, x, node.id, CRITICAL_CVE)).dto.calc[x.vf.due.id]).toBe('2026-11-02');
    }));

  it('срок — от первого переданного скана: поздняя передача раннего и повторные сканы его не сдвигают; ручная Критичность пересчитывает базу', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const s1 = await load(tx, x, node.id, 'vuln-2026-10-15.xlsx');
      const s2 = await load(tx, x, node.id, 'vuln-2026-10-20.xlsx');
      // Второй скан передан первым: срок от него.
      await scans.handOverScan(tx, x.actor, s2.scanId, { date: '2026-10-20' });
      const a = await rec(tx, x, node.id, CRITICAL_CVE);
      expect([a.vuln.deadlineScanId, a.dto.calc[x.vf.due.id]]).toEqual([s2.scanId, '2026-11-03']);
      // Первый передан позже — срок прежний.
      expect((await scans.handOverScan(tx, x.actor, s1.scanId, { date: '2026-10-21' })).started).toBe(0);
      // Третий скан и его передача — тоже.
      const s3 = await load(tx, x, node.id, 'vuln-2026-10-25.xlsx');
      await scans.handOverScan(tx, x.actor, s3.scanId, { date: '2026-10-26' });
      const b = await rec(tx, x, node.id, CRITICAL_CVE);
      expect([b.vuln.deadlineScanId, b.dto.calc[x.vf.due.id]]).toEqual([s2.scanId, '2026-11-03']);
      // Ручная Критичность: + 180 дней от той же даты.
      const low = await records.updateRecord(tx, x.actor, b.dto.id, { version: b.dto.version, values: { [x.vf.crit.id]: x.opt('crit', 'low') } });
      expect(low.calc[x.vf.due.id]).toBe('2027-04-19');
    }));

  it('повторное обнаружение: срок от передачи нового скана; скан прошлого цикла срок не начинает', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const s1 = await load(tx, x, node.id, 'vuln-2026-10-15.xlsx');
      await scans.handOverScan(tx, x.actor, s1.scanId, { date: '2026-10-15' });
      const a = await rec(tx, x, node.id, CRITICAL_CVE);
      await records.updateRecord(tx, x.actor, a.dto.id, { version: a.dto.version, values: { [x.vf.status.id]: x.opt('status', 'fixed') } });
      const s2 = await load(tx, x, node.id, 'vuln-2026-10-20.xlsx');
      expect((await rec(tx, x, node.id, CRITICAL_CVE)).vuln.deadlineScanId).toBeNull();
      await scans.handOverScan(tx, x.actor, s2.scanId, { date: '2026-10-22' });
      const b = await rec(tx, x, node.id, CRITICAL_CVE);
      expect([b.vuln.deadlineScanId, b.vuln.cycle, b.dto.calc[x.vf.due.id]]).toEqual([s2.scanId, 2, '2026-11-05']);
      // Срок нового цикла идёт только от новых сканов: непереданный скан прошлого цикла его не трогает.
      expect(b.dto.values[x.vf.notified.id]).toBe('2026-10-22');
    }));

  it('запись, закрытая после скана, срока не получает; перенесённая со сроком из прежнего реестра — сохраняет его', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const s1 = await load(tx, x, node.id, 'vuln-2026-10-15.xlsx');
      const a = await rec(tx, x, node.id, CRITICAL_CVE);
      await records.updateRecord(tx, x.actor, a.dto.id, { version: a.dto.version, values: { [x.vf.status.id]: x.opt('status', 'accepted') } });

      // Запись «как в 1.1.0», перенесённая в узел; следующий скан её находит.
      const pkg = must(x.vf.pkg.options.find((o) => o.label === 'Igor Pavlov 7-Zip'));
      const number = await records.nextNumbers(tx, x.reg.id, 1);
      const old = await tx.registerRecord.create({
        data: { registerId: x.reg.id, number, values: { [x.vf.cve.id]: 'CVE-2019-1111', [x.vf.pkg.id]: pkg.id, [x.vf.status.id]: x.opt('status', 'open'), [x.vf.crit.id]: x.opt('crit', 'high'), [x.vf.notified.id]: '2026-09-01' } as Prisma.InputJsonValue },
      });
      await seedVulnLegacy(tx);
      await x.reload();
      await transferRecords(tx, x.actor, { recordIds: [old.id], nodeId: node.id });
      const due = (await records.getRecord(tx, old.id)).calc[x.vf.due.id];
      expect(due).toBe('2026-10-01');
      const wb = await sampleBook();
      const ws = must(wb.worksheets.find((w) => w.name !== 'Хосты'));
      ws.addRow(['Igor Pavlov 7-Zip', 'CVE-2019-1111']);
      const s2 = await load(tx, x, node.id, 'vuln-2026-10-20.xlsx', await toBuffer(wb));

      const res = await scans.handOverScan(tx, x.actor, s2.scanId, { date: '2026-10-20' });
      expect(res.keptLegacy).toBe(1);
      expect((await records.getRecord(tx, old.id)).calc[x.vf.due.id]).toBe(due);
      expect((await rec(tx, x, node.id, CRITICAL_CVE)).dto.values[x.vf.notified.id]).toBeUndefined();
      expect((await scans.handOverScan(tx, x.actor, s1.scanId, { date: '2026-10-21' })).started).toBe(0);
    }));

  it('скан не меняется: триггер; передача — один раз', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const a = await load(tx, x, node.id, SAMPLE_NAME);
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.$executeRaw`UPDATE vuln_scans SET file_name = 'x' WHERE id = ${a.scanId}::uuid`).rejects.toThrow(/скан не меняется/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      await scans.handOverScan(tx, x.actor, a.scanId, { date: '2026-10-15' });
      await tx.$executeRaw`SAVEPOINT s2`;
      await expect(tx.$executeRaw`UPDATE vuln_scans SET handed_over_on = '2026-10-16' WHERE id = ${a.scanId}::uuid`).rejects.toThrow(/скан не меняется/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s2`;
    }));
});

describe('«Не передано ИКТ» и п. 7.4', () => {
  it('до передачи нет событий и просрочки; корзина монитора «Не передано ИКТ»; передача давней датой — просрочка и события сразу', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const s1 = await load(tx, x, node.id, 'vuln-2026-01-10.xlsx');
      await runAutomations(tx, { registerId: x.reg.id, trigger: 'import', actorId: x.adminId });
      const ids = (await tx.vulnRecord.findMany({ where: { nodeId: node.id }, select: { recordId: true } })).map((r) => r.recordId);
      expect(await tx.automationEvent.count({ where: { recordId: { in: ids } } })).toBe(0);
      const none = must((await vulnsBlock(tx, x.reg, todayIso())).buckets.find((b) => b.key === 'none'));
      expect(none.label).toBe('Не передано ИКТ');
      expect(none.count).toBeGreaterThanOrEqual(90);

      await scans.handOverScan(tx, x.actor, s1.scanId, { date: '2026-01-10' });
      await runAutomations(tx, { registerId: x.reg.id, trigger: 'import', actorId: x.adminId });
      expect(await tx.automationEvent.count({ where: { recordId: { in: ids } } })).toBeGreaterThan(0);
    }));
});

describe('чтение раздела', () => {
  it('скан: факты, сравнение, находки, охват; файл виден сотруднику ИБ', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const a = await load(tx, x, node.id, SAMPLE_NAME);
      const s = await scans.getScan(tx, a.scanId);
      expect([s.hostsCount, s.findingsCount, s.coverageTitle, s.legacy, s.previousScan, s.handover]).toEqual([12, 90, 'Отдел платёжных карт', false, null, null]);
      expect(s.counts).toMatchObject({ new: 90 });
      expect(s.hosts).toHaveLength(12);
      expect(s.findings).toHaveLength(90);
      expect((s.comparison?.groups.new as unknown[]).length).toBe(90);
      expect((await getFileMeta(tx, x.actor, must(s.fileId))).refs).toEqual([expect.objectContaining({ kind: 'vuln_scan', id: a.scanId })]);
      await expectCode(scans.getScan(tx, x.adminId), 'NOT_FOUND');
    }));

  it('реестр узла: сортировка и фильтры по состоянию, счётчики; просрочка видна в обзоре и на дашборде так же', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const s1 = await load(tx, x, node.id, 'vuln-2026-09-01.xlsx');
      let page = await section.nodeRecords(tx, node.id, {});
      expect([page.total, page.stateCounts.not_handed, page.stateCounts.overdue]).toEqual([90, 90, 0]);
      expect(page.items[0]?.vuln.state).toBe('not_handed');
      expect(page.items[0]?.display[x.vf.crit.id]).toBe('Критическая');
      expect(page.nextCursor).toBeNull();
      expect((await section.nodeRecords(tx, node.id, { limit: 10, cursor: '85' })).items).toHaveLength(5);

      const ov = (await section.overview(tx)).nodes.find((n) => n.nodeId === node.id);
      expect(ov).toMatchObject({ open: 90, overdue: 0, notHandedOver: 90, total: 90, lastScan: { id: s1.scanId, handedOver: false } });
      expect((await section.overview(tx)).awaiting.map((a) => a.id)).toContain(s1.scanId);

      await scans.handOverScan(tx, x.actor, s1.scanId, { date: addDays(todayIso(), -20) });
      page = await section.nodeRecords(tx, node.id, {});
      expect(page.stateCounts.not_handed).toBe(0);
      const critical = page.stateCounts.overdue;
      expect(critical).toBeGreaterThan(0);
      expect(page.items.slice(0, critical).every((r) => r.vuln.state === 'overdue')).toBe(true);
      const after = must((await section.overview(tx)).nodes.find((n) => n.nodeId === node.id));
      expect(after.overdue).toBe(critical);
      expect((await section.overview(tx)).awaiting.map((a) => a.id)).not.toContain(s1.scanId);

      const crit = x.opt('crit', 'critical');
      const only = await section.nodeRecords(tx, node.id, { crit, state: 'all', limit: 200 });
      expect(only.items.every((r) => r.values[x.vf.crit.id] === crit)).toBe(true);
      const found = await section.nodeRecords(tx, node.id, { search: CRITICAL_CVE.toLowerCase(), state: 'all' });
      expect(found.total).toBe(1);

      const one = await rec(tx, x, node.id, CRITICAL_CVE);
      await records.updateRecord(tx, x.actor, one.dto.id, { version: one.dto.version, values: { [x.vf.status.id]: x.opt('status', 'fixed') } });
      expect((await section.nodeRecords(tx, node.id, { state: 'fixed' })).total).toBe(1);
      expect((await section.nodeRecords(tx, node.id, { state: 'open' })).total).toBe(89);
    }));

  it('карточка записи: база, источник, решение п. 7.3 главнее, сканы, отметка «повторно»', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const s1 = await load(tx, x, node.id, 'vuln-2026-10-15.xlsx');
      const before = await section.recordInfo(tx, (await rec(tx, x, node.id, CRITICAL_CVE)).dto.id);
      expect(before.deadline).toMatchObject({ source: 'none', base: null, final: null, days: 14 });
      expect(before.state).toBe('not_handed');
      await scans.handOverScan(tx, x.actor, s1.scanId, { date: '2026-10-15' });
      const a = await rec(tx, x, node.id, CRITICAL_CVE);
      const info = await section.recordInfo(tx, a.dto.id);
      expect(info.deadline).toMatchObject({ source: 'procedure', base: '2026-10-29', days: 14, final: '2026-10-29', scan: { id: s1.scanId, handedOverOn: '2026-10-15' }, decision: null });
      expect(info.node).toMatchObject({ id: node.id, legacy: false });
      expect(info.scans.map((s) => s.outcome)).toEqual(['new']);
      const decided = await records.updateRecord(tx, x.actor, a.dto.id, { version: a.dto.version, values: { [x.vf.measures.id]: 'Сегментация', [x.vf.newDue.id]: '2027-01-15' } });
      const info2 = await section.recordInfo(tx, decided.id);
      expect(info2.deadline).toMatchObject({ base: '2026-10-29', final: '2027-01-15', decision: { measures: 'Сегментация', due: '2027-01-15' } });
      await expectCode(section.recordInfo(tx, x.adminId), 'NOT_FOUND');
    }));

  it('скан прежнего реестра: без снимка и сравнения, хосты из scan_hosts, передан в «Уведомлено ДИКТ»', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const imp = await tx.registerImport.create({
        data: { registerId: x.reg.id, kind: 'scan', status: 'applied', fileName: 'old.xlsx', fileSha256: 'a'.repeat(64), summary: {}, payload: {}, createdBy: x.adminId, expiresAt: new Date() },
      });
      const label = unique('Отдел · 01.09.2026');
      const report = await tx.scanReport.create({
        data: {
          registerId: x.reg.id, importId: imp.id, fileName: 'old-2026-09-01.xlsx', fileSha256: 'a'.repeat(64), reportDate: new Date('2026-09-01'), notifiedDate: new Date('2026-09-03'),
          department: 'Отдел', label, rowsTotal: 1, createdCount: 1, mergedCount: 0, hostsCount: 1, createdBy: x.adminId, hosts: { create: [{ sortOrder: 1, name: 'PC-1' }] },
        },
      });
      await seedVulnLegacy(tx);
      const s = must(await tx.vulnScan.findUnique({ where: { legacyReportId: report.id } }));
      const d = await scans.getScan(tx, s.id);
      expect([d.legacy, d.comparison, d.findings, d.hosts.map((h) => h.name), d.handover?.date, d.counts]).toEqual([true, null, [], ['PC-1'], '2026-09-03', null]);
      await expectCode(scans.handOverScan(tx, x.actor, s.id, { date: '2026-10-01' }), 'ALREADY_HANDED_OVER');
    }));
});

describe('права раздела по HTTP', () => {
  it('просмотр — ib.work; передача — records.edit; без прав — 403', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Http-Scans-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const { x, node } = await setup(tx);
      const a = await load(tx, x, node.id, SAMPLE_NAME);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const head = await makeUser(tx, ['ib_head'], { passwordHash: hash });
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return { cookie: `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`, origin: TEST_PORTAL_URL };
      };
      const [S, H, R] = [await login(staff.login), await login(head.login), await login(reader.login)];
      const one = await rec(tx, x, node.id, CRITICAL_CVE);
      for (const url of ['/api/v1/vulns/overview', `/api/v1/vulns/nodes/${node.id}/records`, `/api/v1/vulns/nodes/${node.id}/scans`, `/api/v1/vulns/scans/${a.scanId}`, `/api/v1/vulns/records/${one.dto.id}`]) {
        expect((await app.inject({ url, headers: R })).statusCode, url).toBe(403);
        const ok = await app.inject({ url, headers: S });
        expect(ok.statusCode, `${url}: ${ok.body.slice(0, 300)}`).toBe(200);
      }
      const url = `/api/v1/vulns/scans/${a.scanId}/handover`;
      expect((await app.inject({ method: 'POST', url, headers: H, payload: { date: '2026-10-15' } })).statusCode).toBe(403);
      const done = await app.inject({ method: 'POST', url, headers: S, payload: { date: '2026-10-15' } });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toEqual({ started: 90, keptLegacy: 0 });
    }));
});
