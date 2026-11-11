// Массовые операции раздела «Уязвимости» на больших узлах (1.13.9, docs/tasks/1.13.9-vuln-import-timeout.md):
// импорт скана 3390 и 10 000 строк, передача ИКТ, продление и отмена, «Пропали → Устранена», обратный импорт по ID,
// «Перенести выбранные». Число SQL-запросов (события Prisma) растёт с числом пачек, а не записей; время — в пределах цели.
// PERF_REPORT_ONLY=1 — только напечатать таблицу (замеры «до» на прежнем коде), без проверки порогов.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { diskFileStore } from '../../lib/file-store.js';
import { todayIso } from '../../lib/today.js';
import { countingPrisma, makeFileRow, must, type Tx } from '../../test/db.js';
import { syntheticReport } from '../../test/scan-synthetic.js';
import { SAMPLE, SAMPLE_NAME, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { runAutomations } from '../automations/service.js';
import * as excel from '../registers/excel.service.js';
import * as extensions from './extensions.service.js';
import * as groups from './groups.service.js';
import * as scan from './scan-import.service.js';
import * as scans from './scans.service.js';
import { transferRecords } from './transfer.service.js';

const REPORT_ONLY = process.env.PERF_REPORT_ONLY === '1';
const root = mkdtempSync(join(tmpdir(), 'ibportal-perf-'));
const store = diskFileStore(root);
const db = countingPrisma();
const table: { op: string; rows: number; queries: number; ms: number }[] = [];
// Таблица замеров — в stderr (console.warn): правило линтера разрешает только warn и error.
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  console.warn(`\n${'операция'.padEnd(44)} ${'строк'.padStart(6)} ${'запросов'.padStart(9)} ${'мс'.padStart(7)}`);
  for (const t of table) console.warn(`${t.op.padEnd(44)} ${String(t.rows).padStart(6)} ${String(t.queries).padStart(9)} ${String(t.ms).padStart(7)}`);
});

/** Пачек по 1000 строк: от них, а не от числа записей, зависит число запросов. */
const batches = (n: number) => Math.ceil(n / 1000);

async function step<T>(op: string, rows: number, fn: () => Promise<T>, limit?: { queries: number; ms: number }): Promise<T> {
  const m = await db.measure(fn);
  table.push({ op, rows, queries: m.queries, ms: m.ms });
  if (limit && !REPORT_ONLY) {
    expect(m.queries, `${op}: запросов`).toBeLessThanOrEqual(limit.queries);
    expect(m.ms, `${op}: мс`).toBeLessThan(limit.ms);
  }
  return m.result;
}

const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function makeNode(tx: Tx, x: VulnFixture, type: string) {
  const t = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: type } });
  const g = await groups.createGroup(tx, x.actor, { name: unique('Серверы'), kind: 'service', systemTypeIds: [t.id] });
  return must(g.nodes[0]);
}

async function importScan(tx: Tx, x: VulnFixture, nodeId: string, buffer: Buffer, fileName: string, rows: number, input: scan.ApplyScanInput = {}) {
  const preview = await step(`импорт скана: предпросмотр`, rows, () => scan.previewNodeScan(tx, store, x.actor, nodeId, buffer, fileName));
  const applied = await step(`импорт скана: применение`, rows, () => scan.applyNodeScan(tx, x.actor, preview.id, input), { queries: 60 + 12 * batches(rows), ms: rows > 5000 ? 30_000 : 10_000 });
  return { preview, applied };
}

describe('массовые операции «Уязвимостей» на больших узлах', () => {
  it('образец на 90 строк', () =>
    db.inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const node = await makeNode(tx, x, 'Windows');
      const { applied } = await importScan(tx, x, node.id, SAMPLE, SAMPLE_NAME, 90);
      expect(applied.created).toBe(90);
    }), 600_000);

  it('3390 строк: импорт, передача ИКТ, продление и отмена, обратный импорт, «Пропали → Устранена»', () =>
    db.inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const node = await makeNode(tx, x, 'Linux');
      const { buffer, fileName } = await syntheticReport(3390);
      const { applied } = await importScan(tx, x, node.id, buffer, fileName, 3390);
      expect(applied.created).toBe(3390);

      const handed = await step('передача ИКТ', 3390, () => scans.handOverScan(tx, x.actor, applied.scanId, { date: todayIso() }), { queries: 30 + 6 * batches(3390), ms: 10_000 });
      expect(handed.started).toBe(3390);

      const plan = await extensions.previewExtension(tx, { nodeId: node.id, daysByLevel: {} });
      const daysByLevel = Object.fromEntries(plan.levels.map((l) => [l.id, 10]));
      const preview = await extensions.previewExtension(tx, { nodeId: node.id, daysByLevel });
      const basis = await makeFileRow(tx, x.adminId, { name: 'Обоснование.pdf' });
      const ext = await step('продление сроков', preview.items.length, () => extensions.applyExtension(tx, x.actor, {
        nodeId: node.id, daysByLevel, basisNumber: 'ОИКТ-1', basisDate: todayIso(), basisFileId: basis.id, expected: preview.items.length,
      }), { queries: 30 + 6 * batches(preview.items.length), ms: 10_000 });
      expect(ext.records).toBeGreaterThan(3000);
      const cancelled = await step('отмена продления', ext.records, () => extensions.cancelExtension(tx, x.actor, ext.id), { queries: 30 + 6 * batches(ext.records), ms: 10_000 });
      expect(cancelled.returned).toBe(ext.records);

      // Обратный импорт по ID: выгрузка реестра, правка «Обновить до версии» у записей узла, импорт.
      await x.reload();
      const { buffer: exported } = await excel.exportRegister(tx, x.reg.id);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(exported as unknown as ExcelJS.Buffer);
      const ws = must(wb.getWorksheet(excel.MAIN_SHEET));
      let fixCol = 0;
      ws.getRow(1).eachCell((c, i) => {
        if (c.value === x.vf.fixVersion.label) fixCol = i;
      });
      let edited = 0;
      for (let r = 2; r <= ws.rowCount; r++) {
        const cell = ws.getRow(r).getCell(fixCol);
        if (typeof cell.value === 'string' && cell.value.length) {
          cell.value = `${cell.value}+b1`;
          edited++;
        }
      }
      const back = Buffer.from(await wb.xlsx.writeBuffer());
      const imp = await step('обратный импорт по ID: предпросмотр', edited, () => excel.previewImport(tx, x.actor, x.reg.id, back, 'vulns.xlsx'));
      const done = await step('обратный импорт по ID: применение', edited, () => excel.applyImport(tx, x.actor, imp.id), { queries: 40 + 6 * batches(edited), ms: 10_000 });
      expect(done.updated).toBe(edited);
      expect(edited).toBeGreaterThan(2500);

      // Следующий скан без этих находок: все 3390 — «Пропали», выбраны → «Устранена».
      const next = await syntheticReport(1, 777);
      const p2 = await scan.previewNodeScan(tx, store, x.actor, node.id, next.buffer, next.fileName.replace('2026_11_10', '2026_11_11'));
      const gone = p2.summary.groups.gone.map((g) => g.key);
      expect(gone.length).toBeGreaterThanOrEqual(3389);
      await step('«Пропали → Устранена»', gone.length, () => scan.applyNodeScan(tx, x.actor, p2.id, { scanDate: todayIso(), selected: { gone } }), { queries: 60 + 12 * batches(gone.length), ms: 10_000 });
    }), 600_000);

  it('«Перенести выбранные»: 1000 записей из «Без группы»', () =>
    db.inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const node = await makeNode(tx, x, 'Linux');
      const legacy = await groups.legacyNode(tx);
      const pkgs = await tx.registerFieldOption.createManyAndReturn({
        data: Array.from({ length: 50 }, (_, i) => ({ fieldId: x.vf.pkg.id, label: unique(`legacy-pkg-${i}`), sortOrder: 10_000 + i })), select: { id: true },
      });
      const first = (await tx.register.findUniqueOrThrow({ where: { id: x.reg.id } })).nextNumber;
      await tx.register.update({ where: { id: x.reg.id }, data: { nextNumber: first + 1000 } });
      const recs = await tx.registerRecord.createManyAndReturn({
        data: Array.from({ length: 1000 }, (_, i) => ({
          registerId: x.reg.id, number: first + i,
          values: { [x.vf.pkg.id]: must(pkgs[i % pkgs.length]).id, [x.vf.cve.id]: `CVE-2098-${10_000 + i}`, [x.vf.status.id]: x.opt('status', 'open') } as Prisma.InputJsonValue,
        })),
        select: { id: true },
      });
      await tx.vulnRecord.createMany({ data: recs.map((r) => ({ recordId: r.id, nodeId: legacy.id, legacy: true })) });
      const moved = await step('«Перенести выбранные»', 1000, () => transferRecords(tx, x.actor, { recordIds: recs.map((r) => r.id), nodeId: node.id }), { queries: 20 + 6, ms: 10_000 });
      expect(moved.moved).toHaveLength(1000);
    }), 600_000);

  it('10 000 строк: импорт и передача ИКТ', () =>
    db.inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const node = await makeNode(tx, x, 'Linux');
      const { buffer, fileName } = await syntheticReport(10_000);
      const { applied } = await importScan(tx, x, node.id, buffer, fileName, 10_000);
      expect(applied.created).toBe(10_000);
      const handed = await step('передача ИКТ', 10_000, () => scans.handOverScan(tx, x.actor, applied.scanId, { date: todayIso() }), { queries: 30 + 6 * batches(10_000), ms: 30_000 });
      expect(handed.started).toBe(10_000);
    }), 900_000);
  it('3390 просроченных записей: прогон автоматизаций п. 7.4', () =>
    db.inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const node = await makeNode(tx, x, 'Linux');
      const { buffer, fileName } = await syntheticReport(3390);
      const preview = await scan.previewNodeScan(tx, store, x.actor, node.id, buffer, fileName);
      const applied = await scan.applyNodeScan(tx, x.actor, preview.id, { scanDate: '2026-01-05' });
      await scans.handOverScan(tx, x.actor, applied.scanId, { date: '2026-01-06' });
      const run = await step('прогон автоматизаций (просрочено)', 3390, () => runAutomations(tx, { registerId: x.reg.id, trigger: 'import', actorId: x.adminId }), { queries: 200 + 20 * batches(3390), ms: 10_000 });
      expect(run.created).toBeGreaterThanOrEqual(3390);
    }), 900_000);
});
