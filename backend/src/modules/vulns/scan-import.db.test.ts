// Шаг 3 релиза 1.5.0 (ADR-0029; CLAUDE.md, раздел 7, правило 6): импорт скана в узел — пять групп, выбор, охват.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import type { Values } from '../../lib/register-values.js';
import { expectCode, inTx, lastAudit, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { SAMPLE, SAMPLE_NAME, sampleBook, toBuffer, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { seedVulnLegacy } from '../../../prisma/seed/vuln-legacy.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as records from '../registers/records.service.js';
import { XLSX_TYPE } from '../registers/routes.js';
import * as groups from './groups.service.js';
import * as scan from './scan-import.service.js';
import { keyNorm } from './keys.js';
import { transferRecords } from './transfer.service.js';

const root = mkdtempSync(join(tmpdir(), 'ibportal-scan-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function makeNode(tx: Tx, x: VulnFixture, type = 'Рабочие станции') {
  const t = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: type } });
  const g = await groups.createGroup(tx, x.actor, { name: unique('Отдел платёжных карт'), kind: 'department', systemTypeIds: [t.id] });
  return must(g.nodes[0]);
}

async function setup(tx: Tx) {
  const x = await vulnRegister(tx);
  return { x, node: await makeNode(tx, x) };
}

async function load(tx: Tx, x: VulnFixture, nodeId: string, buffer: Buffer = SAMPLE, name = SAMPLE_NAME, input: scan.ApplyScanInput = {}) {
  const preview = await scan.previewNodeScan(tx, store, x.actor, nodeId, buffer, name);
  const applied = await scan.applyNodeScan(tx, x.actor, preview.id, input);
  await x.reload();
  return { preview, applied };
}

/** Лист находок образца: строка по идентификатору (и пакету) и колонка по заголовку. */
function findings(wb: ExcelJS.Workbook) {
  const ws = must(wb.worksheets.find((w) => w.name !== 'Хосты'));
  const col = (h: string) => {
    let n = 0;
    ws.getRow(1).eachCell((c, i) => {
      if (c.value === h) n = i;
    });
    return n;
  };
  const rowOf = (cve: string) => {
    for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(col('CVE')).value === cve) return { row: ws.getRow(r) };
    throw new Error(`нет строки ${cve}`);
  };
  /** Строка пропала из файла: «Оценку» с общей формулой не трогаем, её разбор не читает. */
  const drop = (cve: string) => {
    const { row } = rowOf(cve);
    row.eachCell((c, i) => {
      if (i !== col('Оценка')) c.value = null;
    });
  };
  return { ws, col, rowOf, drop };
}

async function byCve(tx: Tx, x: VulnFixture, nodeId: string, cve: string, pkg?: string) {
  const rows = await tx.vulnRecord.findMany({ where: { nodeId, keyNorm: { not: null } }, include: { record: true } });
  const r = rows.find((v) => (v.record.values as Values)[x.vf.cve.id] === cve && (!pkg || x.vf.pkg.options.find((o) => o.id === (v.record.values as Values)[x.vf.pkg.id])?.label === pkg));
  if (!r) throw new Error(`нет записи ${cve}`);
  return { vuln: r, rec: await records.getRecord(tx, r.recordId) };
}

const sampleKey = (pkg: string, cve: string) => keyNorm(pkg, cve);

describe('импорт скана в узел: образец', () => {
  it('предпросмотр ничего не меняет: 90 новых, 12 хостов, охват, дата; Оценка считается порталом', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const before = await tx.registerRecord.count({ where: { registerId: x.reg.id } });
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
      const s = p.summary;
      expect(s.counts).toEqual({ new: 90, reopened: 0, changed: 0, unchanged: 0, gone: 0 });
      expect([s.hostsCount, s.coverageTitle, s.scanDate, s.rows, s.inFileDuplicates, s.errorRows, s.previousScan]).toEqual([12, 'Отдел платёжных карт', '2026-10-15', 90, 0, 0, null]);
      expect(s.critCounts.reduce((n, c) => n + c.count, 0)).toBe(90);
      const item = (cve: string) => must(s.groups.new.find((i) => i.cve === cve));
      expect(item('BDU:2025-01793')).toMatchObject({ cvss: null, score: null, crit: 'Высокая' });
      // 8,6 × 1,00 × 0,95 = 8,17 → 8,2; 7,0 × 1,00 × 0,95 = 6,65 → 6,7.
      expect(item('CVE-2026-34621')).toMatchObject({ pkg: 'Adobe Adobe Acrobat DC', score: 8.2 });
      expect(item('CVE-2025-0411')).toMatchObject({ pkg: 'Igor Pavlov 7-Zip', score: 6.7 });
      expect(s.groups.new.filter((i) => i.cve === 'CVE-2023-44487')).toHaveLength(2);
      expect(await tx.registerRecord.count({ where: { registerId: x.reg.id } })).toBe(before);
      expect(await tx.vulnScan.count({ where: { nodeId: node.id } })).toBe(0);
      expect((await lastAudit(tx)).action).toBe('vuln.scan.previewed');
    }));

  it('применение: записи узла без срока, скан с файлом, снимком и сравнением; отдел и отчёт — для отката', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const { applied } = await load(tx, x, node.id);
      expect(applied).toMatchObject({ created: 90, reopened: 0, changed: 0, unchanged: 0, gone: 0, skipped: 0 });
      const scanRow = await tx.vulnScan.findUniqueOrThrow({ where: { id: applied.scanId }, include: { file: true } });
      expect([scanRow.hostsCount, scanRow.findingsCount, scanRow.coverageTitle, scanRow.handedOverOn, scanRow.previousScanId]).toEqual([12, 90, 'Отдел платёжных карт', null, null]);
      expect(scanRow.scanDate.toISOString().slice(0, 10)).toBe('2026-10-15');
      expect(scanRow.file).toMatchObject({ originalName: SAMPLE_NAME, sha256: scanRow.fileSha256 });
      expect((scanRow.findings as { key: string; score: number | null; group: string }[]).find((f) => f.key === sampleKey('Adobe Adobe Acrobat DC', 'CVE-2026-34621'))).toMatchObject({ score: 8.2, group: 'new', selected: true });
      expect((scanRow.comparison as { counts: unknown }).counts).toEqual({ new: 90, reopened: 0, changed: 0, unchanged: 0, gone: 0 });
      expect(await tx.vulnRecord.count({ where: { nodeId: node.id } })).toBe(90);
      expect(await tx.vulnRecordScan.count({ where: { scanId: applied.scanId, outcome: 'new' } })).toBe(90);

      const { vuln, rec } = await byCve(tx, x, node.id, 'CVE-2026-34621');
      expect(vuln).toMatchObject({ keyNorm: sampleKey('Adobe Adobe Acrobat DC', 'CVE-2026-34621'), firstScanId: applied.scanId, lastScanId: applied.scanId, deadlineScanId: null, cycle: 1, legacy: false });
      // Срок не начат: импорт его не запускает.
      expect(rec.values[x.vf.notified.id]).toBeUndefined();
      expect(rec.calc[x.vf.due.id]).toBeNull();
      expect(rec.calc[x.vf.score.id]).toBe(8.2);
      expect([rec.display[x.vf.status.id], rec.display[x.vf.department.id], rec.display[x.vf.report.id]]).toEqual(['Открыта', 'Отдел платёжных карт', 'Отдел платёжных карт · 15.10.2026']);
      const bdu = await byCve(tx, x, node.id, 'BDU:2025-01793');
      expect([bdu.rec.calc[x.vf.score.id], bdu.rec.display[x.vf.crit.id]]).toEqual([null, 'Высокая']);
      const audit = await lastAudit(tx);
      expect([audit.action, audit.entityId]).toEqual(['vuln.scan.applied', applied.scanId]);
    }));

  it('повторный импорт того же файла: 90 без изменений, значения и версии записей те же; прошлый скан — ссылка', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const first = await load(tx, x, node.id);
      const a = await byCve(tx, x, node.id, 'CVE-2025-0411');
      const { preview, applied } = await load(tx, x, node.id, SAMPLE, 'vuln-windows-2026-10-22.xlsx');
      expect(preview.summary.counts).toEqual({ new: 0, reopened: 0, changed: 0, unchanged: 90, gone: 0 });
      expect(preview.summary.previousScan).toMatchObject({ id: first.applied.scanId, scanDate: '2026-10-15', handedOver: false });
      expect(preview.summary.coverage).toEqual({ newHosts: [], goneHosts: [] });
      expect(applied.unchanged).toBe(90);
      const b = await byCve(tx, x, node.id, 'CVE-2025-0411');
      expect([b.rec.version, b.rec.values]).toEqual([a.rec.version, a.rec.values]);
      expect([b.vuln.firstScanId, b.vuln.lastScanId]).toEqual([first.applied.scanId, applied.scanId]);
      expect(await tx.vulnRecordScan.count({ where: { recordId: b.vuln.recordId } })).toBe(2);
      expect((await tx.vulnScan.findUniqueOrThrow({ where: { id: applied.scanId } })).previousScanId).toBe(first.applied.scanId);
      expect(await tx.vulnRecord.count({ where: { nodeId: node.id } })).toBe(90);
    }));

  it('один ключ в разных узлах — разные записи', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      await load(tx, x, node.id);
      const other = await makeNode(tx, x, 'Серверы');
      const { preview } = await load(tx, x, other.id);
      expect(preview.summary.counts.new).toBe(90);
      expect((await byCve(tx, x, node.id, 'CVE-2025-0411')).rec.id).not.toBe((await byCve(tx, x, other.id, 'CVE-2025-0411')).rec.id);
    }));
});

describe('импорт скана: пять групп и выбор по строкам', () => {
  it('новые, повторно, изменились, без изменений, пропали; повтор ключа, второй лист, переименованные листы, CVSS «н/д»', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      await load(tx, x, node.id);
      const fixedOne = await byCve(tx, x, node.id, 'CVE-2025-0411');
      await records.updateRecord(tx, x.actor, fixedOne.rec.id, { version: fixedOne.rec.version, values: { [x.vf.status.id]: x.opt('status', 'fixed') } });

      const wb = await sampleBook();
      const { ws, col, rowOf, drop } = findings(wb);
      must(wb.getWorksheet('Хосты')).name = 'Inventory';
      ws.name = 'Находки';
      // Пропала.
      drop('CVE-2026-34621');
      // Изменилась: CVSS.
      const changedRow = rowOf('CVE-2025-6218').row;
      const cvssBefore = changedRow.getCell(col('CVSS')).value;
      changedRow.getCell(col('CVSS')).value = 9.9;
      // CVSS «н/д» — строка остаётся, значение реестра не стирается.
      rowOf('CVE-2023-40477').row.getCell(col('CVSS')).value = 'н/д';
      // Повтор ключа (регистр и пробелы не важны) — объединяется по максимуму.
      const hits = must(rowOf('CVE-2025-6218').row.getCell(col('Обнаружений')).value) as number;
      const dup = ws.addRow([]);
      dup.getCell(col('Пакет')).value = ' ' + String(rowOf('CVE-2025-6218').row.getCell(col('Пакет')).value).toUpperCase();
      dup.getCell(col('CVE')).value = 'cve-2025-6218';
      dup.getCell(col('Обнаружений')).value = hits + 7;
      // Новая — на втором листе.
      const more = wb.addWorksheet('Ещё находки');
      more.addRow(['Пакет', 'Идентификатор', 'CVSS']);
      more.addRow(['Новый пакет', 'BDU:2026-00001', 5.5]);
      // Хост выбыл, хост добавлен.
      const hosts = must(wb.getWorksheet('Inventory'));
      const lost = String(hosts.getRow(3).getCell(2).value);
      hosts.spliceRows(3, 1);
      hosts.addRow([99, 'HOST-NEW', '10.0.0.99', 'Windows 11']);

      const { summary: s, id } = await scan.previewNodeScan(tx, store, x.actor, node.id, await toBuffer(wb), 'vuln_2026_10_22.xlsx');
      expect(s.counts).toEqual({ new: 1, reopened: 1, changed: 1, unchanged: 87, gone: 1 });
      expect([s.inFileDuplicates, s.scanDate, s.sheets.length]).toEqual([1, '2026-10-22', 2]);
      expect(s.notes.map((n) => n.field)).toEqual(['CVSS']);
      expect(s.groups.new[0]).toMatchObject({ pkg: 'Новый пакет', cve: 'BDU:2026-00001', recordId: null });
      expect(s.groups.reopened[0]).toMatchObject({ cve: 'CVE-2025-0411', recordId: fixedOne.rec.id });
      const changed = must(s.groups.changed[0]);
      expect(changed.cve).toBe('CVE-2025-6218');
      expect(changed.changes.map((c) => [c.label, c.from, c.to])).toEqual([['CVSS', String(cvssBefore), '9.9'], ['Обнаружений', String(hits), String(hits + 7)]]);
      expect(s.groups.gone.map((g) => g.cve)).toEqual(['CVE-2026-34621']);
      expect(s.coverage).toEqual({ newHosts: ['HOST-NEW'], goneHosts: [lost] });
      expect(s.warnings.join(' ')).toContain('Из охвата выбыли хосты (1)');
      expect(await tx.vulnScan.count({ where: { nodeId: node.id } })).toBe(1);

      const gone = must(s.groups.gone[0]);
      const applied = await scan.applyNodeScan(tx, x.actor, id, { selected: { gone: [gone.key] } });
      await x.reload();
      expect(applied).toMatchObject({ created: 1, reopened: 1, changed: 1, unchanged: 87, gone: 1 });

      const ch = await byCve(tx, x, node.id, 'CVE-2025-6218');
      expect(ch.rec.values[x.vf.cvss.id]).toBe(9.9);
      expect(ch.rec.values[x.vf.hits.id]).toBe(hits + 7);
      expect(ch.rec.display[x.vf.crit.id]).toBe('Критическая');
      const hist = await records.recordHistory(tx, ch.rec.id);
      expect(hist[0]).toMatchObject({ via: 'scan_import' });
      expect(hist[0]?.changes.map((c) => c.label)).toEqual(expect.arrayContaining(['CVSS', 'Обнаружений', 'Критичность']));
      const nd = await byCve(tx, x, node.id, 'CVE-2023-40477');
      expect(nd.rec.values[x.vf.cvss.id]).toBeTypeOf('number');
      const g = await records.getRecord(tx, gone.recordId);
      expect(g.display[x.vf.status.id]).toBe('Устранена');
      expect(await tx.vulnRecordScan.findUnique({ where: { recordId_scanId: { recordId: gone.recordId, scanId: applied.scanId } } })).toMatchObject({ outcome: 'fixed' });
      expect((await records.recordHistory(tx, gone.recordId))[0]?.summary).toContain('нет в скане, отмечена устранённой');
      const scanRow = await tx.vulnScan.findUniqueOrThrow({ where: { id: applied.scanId } });
      const cmp = scanRow.comparison as { groups: { gone: { selected: boolean }[]; new: { number: number | null }[] } };
      expect(cmp.groups.gone[0]?.selected).toBe(true);
      expect(cmp.groups.new[0]?.number).toBeGreaterThan(0);
    }));

  it('повторное обнаружение: статус «Открыта», новый цикл, срок, продления и решение п. 7.3 сняты, в истории — было; срока до передачи нет', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      await load(tx, x, node.id);
      const a = await byCve(tx, x, node.id, 'CVE-2025-0411');
      // Как после передачи ИКТ, продления и решения п. 7.3.
      const row = await tx.registerRecord.findUniqueOrThrow({ where: { id: a.rec.id } });
      await tx.registerRecord.update({
        where: { id: a.rec.id },
        data: {
          values: {
            ...(row.values as object), [x.vf.notified.id]: '2026-10-16', [x.vf.legacyDue.id]: '2026-12-01', [x.vf.extDays.id]: 30,
            [x.vf.measures.id]: 'Сегментация', [x.vf.newDue.id]: '2027-02-01', [x.vf.status.id]: x.opt('status', 'fixed'),
          } as Prisma.InputJsonValue,
        },
      });
      const { preview, applied } = await load(tx, x, node.id, SAMPLE, 'vuln-2026-10-30.xlsx');
      expect(preview.summary.counts.reopened).toBe(1);
      expect(preview.summary.groups.reopened[0]).toMatchObject({ dueBefore: '2027-02-01', dueAfter: null });
      const b = await byCve(tx, x, node.id, 'CVE-2025-0411');
      expect(b.vuln).toMatchObject({ cycle: 2, deadlineScanId: null, lastScanId: applied.scanId });
      expect(b.vuln.reopenedAt).toBeInstanceOf(Date);
      expect(b.rec.display[x.vf.status.id]).toBe('Открыта');
      for (const f of [x.vf.notified, x.vf.legacyDue, x.vf.extDays, x.vf.measures, x.vf.newDue]) expect(b.rec.values[f.id], f.label).toBeUndefined();
      expect(b.rec.calc[x.vf.due.id]).toBeNull();
      expect(b.rec.display[x.vf.report.id]).toBe('Отдел платёжных карт · 30.10.2026');
      const h = must((await records.recordHistory(tx, b.rec.id))[0]);
      expect(h.summary).toContain('повторно обнаружена');
      expect(h.changes.find((c) => c.label === 'Компенсирующие меры')).toMatchObject({ from: 'Сегментация', to: '' });
      expect(await tx.vulnRecordScan.findUnique({ where: { recordId_scanId: { recordId: b.rec.id, scanId: applied.scanId } } })).toMatchObject({ outcome: 'reopened', cycle: 2 });
    }));

  it('«Риск принят» не открывается и не пропадает: поля обновляются, статус тот же', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      await load(tx, x, node.id);
      const a = await byCve(tx, x, node.id, 'CVE-2025-0411');
      await records.updateRecord(tx, x.actor, a.rec.id, { version: a.rec.version, values: { [x.vf.status.id]: x.opt('status', 'accepted') } });
      const gonePkg = await byCve(tx, x, node.id, 'CVE-2025-6218');
      await records.updateRecord(tx, x.actor, gonePkg.rec.id, { version: gonePkg.rec.version, values: { [x.vf.status.id]: x.opt('status', 'accepted') } });

      const wb = await sampleBook();
      const { col, rowOf, drop } = findings(wb);
      rowOf('CVE-2025-0411').row.getCell(col('CVSS')).value = 2.2;
      drop('CVE-2025-6218');
      const { preview } = await load(tx, x, node.id, await toBuffer(wb), 'vuln-2026-10-30.xlsx');
      expect(preview.summary.counts).toEqual({ new: 0, reopened: 0, changed: 1, unchanged: 88, gone: 0 });
      expect(preview.summary.groups.changed[0]).toMatchObject({ closedStatus: 'Риск принят' });
      const b = await byCve(tx, x, node.id, 'CVE-2025-0411');
      expect([b.rec.display[x.vf.status.id], b.rec.values[x.vf.cvss.id], b.vuln.cycle]).toEqual(['Риск принят', 2.2, 1]);
    }));

  it('выбор: невыбранные новые не создаются, изменившиеся и повторные не трогаются; в снимке остаются с отметкой', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      await load(tx, x, node.id);
      const fixedOne = await byCve(tx, x, node.id, 'CVE-2025-0411');
      await records.updateRecord(tx, x.actor, fixedOne.rec.id, { version: fixedOne.rec.version, values: { [x.vf.status.id]: x.opt('status', 'fixed') } });
      const wb = await sampleBook();
      const { ws, col, rowOf } = findings(wb);
      rowOf('CVE-2025-6218').row.getCell(col('CVSS')).value = 9.9;
      const nw = ws.addRow([]);
      nw.getCell(col('Пакет')).value = 'Ещё пакет';
      nw.getCell(col('CVE')).value = 'CVE-2026-55555';
      const buffer = await toBuffer(wb);
      const ch = await byCve(tx, x, node.id, 'CVE-2025-6218');

      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, buffer, 'vuln-2026-10-30.xlsx');
      await expectCode(scan.applyNodeScan(tx, x.actor, p.id, { selected: { new: ['нет такого'] } }), 'BAD_SELECTION');
      const applied = await scan.applyNodeScan(tx, x.actor, p.id, { selected: { new: [], reopened: [], changed: [] } });
      expect(applied).toMatchObject({ created: 0, reopened: 0, changed: 0, unchanged: 88, gone: 0 });
      expect(await tx.vulnRecord.count({ where: { nodeId: node.id } })).toBe(90);
      const after = await byCve(tx, x, node.id, 'CVE-2025-6218');
      expect([after.rec.version, after.rec.values[x.vf.cvss.id]]).toEqual([ch.rec.version, ch.rec.values[x.vf.cvss.id]]);
      // Запись встречалась в скане, хотя поля не приняты; устранённая так и осталась устранённой.
      expect(after.vuln.lastScanId).toBe(applied.scanId);
      expect((await byCve(tx, x, node.id, 'CVE-2025-0411')).rec.display[x.vf.status.id]).toBe('Устранена');
      expect(await tx.vulnRecordScan.count({ where: { recordId: fixedOne.rec.id, scanId: applied.scanId } })).toBe(0);
      const snap = (await tx.vulnScan.findUniqueOrThrow({ where: { id: applied.scanId } })).findings as { cve: string; group: string; selected: boolean }[];
      expect(snap.find((f) => f.cve === 'CVE-2026-55555')).toMatchObject({ group: 'new', selected: false });
      expect(snap.find((f) => f.cve === 'CVE-2025-6218')).toMatchObject({ group: 'changed', selected: false });
    }));

  it('ручная Критичность не перетирается; изменение, делающее запись просроченной, помечено; пустое в файле значение не стирает', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      await load(tx, x, node.id);
      const man = await byCve(tx, x, node.id, 'CVE-2025-0411');
      await records.updateRecord(tx, x.actor, man.rec.id, { version: man.rec.version, values: { [x.vf.crit.id]: x.opt('crit', 'low') } });
      // Срок идёт: передано ИКТ 60 дней назад, Критичность средняя (90 дней) — сейчас в срок; станет критической (14) — просрочка.
      const auto = await byCve(tx, x, node.id, 'CVE-2025-6218');
      const row = await tx.registerRecord.findUniqueOrThrow({ where: { id: auto.rec.id } });
      const notified = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
      await tx.registerRecord.update({ where: { id: auto.rec.id }, data: { values: { ...(row.values as object), [x.vf.notified.id]: notified, [x.vf.crit.id]: x.opt('crit', 'medium') } as Prisma.InputJsonValue } });

      const wb = await sampleBook();
      const { col, rowOf } = findings(wb);
      rowOf('CVE-2025-0411').row.getCell(col('CVSS')).value = 9.9;
      rowOf('CVE-2025-6218').row.getCell(col('CVSS')).value = 9.9;
      rowOf('CVE-2023-40477').row.getCell(col('Обнаружений')).value = null;
      rowOf('CVE-2023-40477').row.getCell(col('Обновить до версии')).value = null;
      const { preview } = await load(tx, x, node.id, await toBuffer(wb), 'vuln-2026-10-30.xlsx');
      const changed = preview.summary.groups.changed;
      expect(changed.map((c) => c.cve).sort()).toEqual(['CVE-2025-0411', 'CVE-2025-6218']);
      expect(must(changed.find((c) => c.cve === 'CVE-2025-6218')).becomesOverdue).toBe(true);
      expect(must(changed.find((c) => c.cve === 'CVE-2025-0411')).becomesOverdue).toBe(false);
      const after = await byCve(tx, x, node.id, 'CVE-2025-0411');
      expect([after.rec.values[x.vf.cvss.id], after.rec.values[x.vf.crit.id], after.rec.manualFieldIds]).toEqual([9.9, x.opt('crit', 'low'), [x.vf.crit.id]]);
      expect((await byCve(tx, x, node.id, 'CVE-2023-40477')).rec.values[x.vf.hits.id]).toBeTypeOf('number');
    }));
});

describe('импорт скана: отказы', () => {
  it('«Без группы» — 409; файл не отчёт; дата: нет в имени, будущая, правка в предпросмотре; чужой импорт, повтор', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      await seedVulnLegacy(tx);
      await expectCode(scan.previewNodeScan(tx, store, x.actor, (await groups.legacyNode(tx)).id, SAMPLE, SAMPLE_NAME), 'LEGACY_NODE');
      const plain = new ExcelJS.Workbook();
      plain.addWorksheet('Лист').addRow(['Имя', 'Дата']);
      await expectCode(scan.previewNodeScan(tx, store, x.actor, node.id, await toBuffer(plain), 'файл.xlsx'), 'NOT_SCAN_REPORT');

      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, 'отчёт сканера.xlsx');
      expect(p.summary.scanDate).toBeNull();
      expect(p.summary.warnings.join(' ')).toContain('укажите её перед применением');
      await expectCode(scan.applyNodeScan(tx, x.actor, p.id, {}), 'SCAN_DATE_REQUIRED');
      await expectCode(scan.applyNodeScan(tx, x.actor, p.id, { scanDate: '2099-01-01' }), 'BAD_DATE');
      const other = await vulnRegister(tx);
      await expectCode(scan.applyNodeScan(tx, other.actor, p.id, { scanDate: '2026-10-20' }), 'IMPORT_OTHER_USER');
      const done = await scan.applyNodeScan(tx, x.actor, p.id, { scanDate: '2026-10-20' });
      expect((await tx.vulnScan.findUniqueOrThrow({ where: { id: done.scanId } })).scanDate.toISOString().slice(0, 10)).toBe('2026-10-20');
      await expectCode(scan.applyNodeScan(tx, x.actor, p.id, { scanDate: '2026-10-20' }), 'IMPORT_NOT_PENDING');
    }));

  it('изменения после предпросмотра: запись правили, запись перенесли, другой скан — не применяется ничего', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      await load(tx, x, node.id);
      const scans = await tx.vulnScan.count({ where: { nodeId: node.id } });

      const p1 = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
      const a = await byCve(tx, x, node.id, 'CVE-2025-0411');
      await records.updateRecord(tx, x.actor, a.rec.id, { version: a.rec.version, values: { [x.vf.comment.id]: 'В работе у ДИКТ' } });
      await expectCode(scan.applyNodeScan(tx, x.actor, p1.id, {}), 'IMPORT_STALE');

      // Перенос из «Без группы» добавил запись в узел.
      const p2 = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
      const pkg = await tx.registerFieldOption.create({ data: { fieldId: x.vf.pkg.id, label: unique('Старый пакет'), sortOrder: 5000 } });
      const number = await records.nextNumbers(tx, x.reg.id, 1);
      const old = await tx.registerRecord.create({ data: { registerId: x.reg.id, number, values: { [x.vf.cve.id]: 'CVE-2020-0001', [x.vf.pkg.id]: pkg.id, [x.vf.status.id]: x.opt('status', 'open') } as Prisma.InputJsonValue } });
      await seedVulnLegacy(tx);
      await x.reload();
      expect((await transferRecords(tx, x.actor, { recordIds: [old.id], nodeId: node.id })).moved).toHaveLength(1);
      await expectCode(scan.applyNodeScan(tx, x.actor, p2.id, {}), 'IMPORT_STALE');

      // Два предпросмотра: второй после применения первого устарел.
      const p3 = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
      const p4 = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
      await scan.applyNodeScan(tx, x.actor, p3.id, {});
      await expectCode(scan.applyNodeScan(tx, x.actor, p4.id, {}), 'IMPORT_STALE');
      expect(await tx.vulnScan.count({ where: { nodeId: node.id } })).toBe(scans + 1);
    }));

  it('запись узла в архиве: строка файла её не трогает, с предупреждением; не «пропала»', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      await load(tx, x, node.id);
      const a = await byCve(tx, x, node.id, 'CVE-2025-0411');
      await records.setRecordArchived(tx, x.actor, a.rec.id, a.rec.version, true);
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
      expect(p.summary.counts).toEqual({ new: 0, reopened: 0, changed: 0, unchanged: 89, gone: 0 });
      expect(p.summary.archived.map((r) => r.number)).toEqual([a.rec.number]);
      expect(p.summary.warnings.join(' ')).toContain('Записей в архиве');
    }));

  it('удалённая запись освобождает ключ: следующий скан заводит её заново', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      await load(tx, x, node.id);
      const a = await byCve(tx, x, node.id, 'CVE-2025-0411');
      await records.deleteRecord(tx, x.actor, a.rec.id, a.rec.version);
      const { preview } = await load(tx, x, node.id, SAMPLE, 'vuln-2026-10-30.xlsx');
      expect(preview.summary.counts).toMatchObject({ new: 1, unchanged: 89 });
      expect((await byCve(tx, x, node.id, 'CVE-2025-0411')).rec.id).not.toBe(a.rec.id);
    }));

  it('система: необязательна, у новых записей; следующий импорт узла предзаполняет её', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const sys = must(await tx.catalogItem.findFirst({ where: { catalogCode: 'systems', deletedAt: null, archivedAt: null } }));
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
      expect(p.summary.systemId).toBeNull();
      await expectCode(scan.applyNodeScan(tx, x.actor, p.id, { systemId: x.adminId }), 'BAD_SYSTEM');
      await scan.applyNodeScan(tx, x.actor, p.id, { systemId: sys.id });
      await x.reload();
      expect((await byCve(tx, x, node.id, 'CVE-2025-0411')).rec.values[x.vf.system.id]).toBe(sys.id);
      expect((await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME)).summary.systemId).toBe(sys.id);
    }));
});

describe('импорт скана по HTTP', () => {
  it('records.edit: предпросмотр и применение; без права — 403; импорт отчёта на реестр — 409', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Http-Scan-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const { x, node } = await setup(tx);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const [S, R] = [await login(staff.login), await login(reader.login)];
      const file = (cookie: string) => ({ cookie, 'content-type': XLSX_TYPE, 'x-file-name': encodeURIComponent(SAMPLE_NAME) });
      const url = `/api/v1/vulns/nodes/${node.id}/scan-imports`;
      expect((await app.inject({ method: 'POST', url, body: SAMPLE, headers: file(R) })).statusCode).toBe(403);
      const up = await app.inject({ method: 'POST', url, body: SAMPLE, headers: file(S) });
      expect(up.statusCode).toBe(201);
      const preview = up.json() as { id: string; summary: { counts: { new: number } } };
      expect(preview.summary.counts.new).toBe(90);
      expect((await app.inject({ url: `/api/v1/vulns/scan-imports/${preview.id}`, headers: { cookie: R } })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/v1/vulns/scan-imports/${preview.id}`, headers: { cookie: S } })).statusCode).toBe(200);
      const applied = await app.inject({ method: 'POST', url: `/api/v1/vulns/scan-imports/${preview.id}/apply`, headers: { cookie: S }, payload: { selected: { gone: [] } } });
      expect(applied.statusCode).toBe(200);
      expect(applied.json()).toMatchObject({ created: 90 });

      const code = (res: { json: () => unknown }) => (res.json() as { error: { code: string } }).error.code;
      const old = await app.inject({ method: 'POST', url: `/api/v1/registers/${x.reg.id}/file-imports`, body: SAMPLE, headers: file(S) });
      expect([old.statusCode, code(old)]).toEqual([409, 'VULN_IMPORT_IN_NODE']);
    }));
});
