// Эталон содержимого массовых операций «Уязвимостей» (1.13.9): записи, audit_log, история и «встречалась в скане»
// после пакетной записи те же, что у построчной записи 1.13.7. Эталон снят на коде v1.13.7 (UPDATE_GOLDEN=1) и
// сравнивается без id и времени: id заменены именами (поле, значение, запись #n, скан, узел), номера — от первой записи,
// sha256 скрыты (книги, собранные в тесте, содержат время создания).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { diskFileStore } from '../../lib/file-store.js';
import type { Values } from '../../lib/register-values.js';
import { inTxLong, makeFileRow, must, type Tx } from '../../test/db.js';
import { SAMPLE, SAMPLE_NAME, sampleBook, toBuffer, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import * as excel from '../registers/excel.service.js';
import * as extensions from './extensions.service.js';
import * as groups from './groups.service.js';
import * as scan from './scan-import.service.js';
import * as scans from './scans.service.js';
import { transferRecords } from './transfer.service.js';

const GOLDEN = new URL('../../../test/fixtures/vuln-bulk-golden.json', import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'ibportal-golden-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Снимок состояния после сценария: id → имена, номера записей — от первой записи сценария. */
async function snapshot(tx: Tx, x: VulnFixture, ctx: { base: number; auditFrom: bigint; optionsBefore: Set<string>; names: Map<string, string> }) {
  await x.reload();
  const names = new Map(ctx.names);
  for (const f of x.reg.fields) {
    names.set(f.id, `field:${f.label}`);
    for (const o of f.options) names.set(o.id, `opt:${f.label}:${o.label}`);
  }
  const recs = await tx.registerRecord.findMany({ where: { registerId: x.reg.id, number: { gte: ctx.base } }, orderBy: { number: 'asc' } });
  for (const r of recs) names.set(r.id, `rec#${r.number - ctx.base}`);
  const scanRows = await tx.vulnScan.findMany({ where: { id: { in: [...names.keys()] } } });
  const label = (s: string) => s.replace(UUID, (id) => names.get(id) ?? '<id>').replace(/#(\d+)/g, (m, n: string) => (Number(n) >= ctx.base ? `#${Number(n) - ctx.base}` : m));
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string') return label(v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [label(k), k === 'sha256' ? '<sha256>' : k === 'number' && typeof val === 'number' && val >= ctx.base ? val - ctx.base : clean(val)]));
    }
    return v;
  };
  const vuln = await tx.vulnRecord.findMany({ where: { recordId: { in: recs.map((r) => r.id) } } });
  const seen = await tx.vulnRecordScan.findMany({ where: { recordId: { in: recs.map((r) => r.id) } } });
  const audit = await tx.auditLog.findMany({ where: { id: { gt: ctx.auditFrom } }, orderBy: { id: 'asc' } });
  const options = x.reg.fields.flatMap((f) => f.options.filter((o) => !ctx.optionsBefore.has(o.id)).map((o) => ({ field: f.label, label: o.label, sortOrder: o.sortOrder, archived: o.archived })));
  return clean({
    records: recs.map((r) => ({
      n: r.number - ctx.base, values: Object.fromEntries(Object.entries(r.values as Values).sort(([a], [b]) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b))),
      searchText: r.searchText.replace(String(r.number), '{n}'), manual: r.manualFieldIds, version: r.version, archived: r.archivedAt !== null, deleted: r.deletedAt !== null,
    })),
    vuln: vuln.map((v) => ({
      rec: v.recordId, node: v.nodeId, key: v.keyNorm, deadlineScan: v.deadlineScanId, first: v.firstScanId, last: v.lastScanId, cycle: v.cycle, reopened: v.reopenedAt !== null, legacy: v.legacy, version: v.version,
    })).sort((a, b) => label(a.rec).localeCompare(label(b.rec), 'en', { numeric: true })),
    seen: seen.map((s) => ({ rec: s.recordId, scan: s.scanId, outcome: s.outcome, cycle: s.cycle, changes: s.changes }))
      .sort((a, b) => `${label(a.scan)} ${label(a.rec)}`.localeCompare(`${label(b.scan)} ${label(b.rec)}`, 'en', { numeric: true })),
    audit: audit.map((a) => ({ user: a.userId, action: a.action, entity: a.entity, entityId: a.entityId, diff: a.diff, ip: a.ip })),
    scans: scanRows.map((s) => ({ name: s.id, findingsCount: s.findingsCount, findings: s.findings, comparison: s.comparison, hosts: s.hosts })).sort((a, b) => label(a.name).localeCompare(label(b.name))),
    options,
  });
}

describe('массовые операции: содержимое совпадает с 1.13.7', () => {
  it('импорт образца, передача ИКТ, продление и отмена, второй скан (повторно, изменились, пропали), обратный импорт, перенос', () =>
    inTxLong(async (tx) => {
      const x = await vulnRegister(tx);
      const names = new Map<string, string>([[x.adminId, 'actor'], [x.reg.id, 'register']]);
      const optionsBefore = new Set(x.reg.fields.flatMap((f) => f.options.map((o) => o.id)));
      const t = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: 'Windows' } });
      const g = await groups.createGroup(tx, x.actor, { name: 'Эталон: отдел карт', kind: 'department', systemTypeIds: [t.id] });
      const node = must(g.nodes[0]);
      names.set(g.id, 'group').set(node.id, 'node');
      const base = (await tx.register.findUniqueOrThrow({ where: { id: x.reg.id } })).nextNumber;
      const auditFrom = (await tx.auditLog.aggregate({ _max: { id: true } }))._max.id ?? 0n;

      // 1. Образец: 90 новых.
      const p1 = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
      const a1 = await scan.applyNodeScan(tx, x.actor, p1.id, {});
      names.set(p1.id, 'import1').set(a1.scanId, 'scan1');
      expect(a1.created).toBe(90);

      // 2. Передача ИКТ, продление на 10 дней по всем уровням и его отмена.
      await scans.handOverScan(tx, x.actor, a1.scanId, { date: '2026-10-20' });
      const plan = await extensions.previewExtension(tx, { nodeId: node.id, daysByLevel: {} });
      const daysByLevel = Object.fromEntries(plan.levels.map((l) => [l.id, 10]));
      const preview = await extensions.previewExtension(tx, { nodeId: node.id, daysByLevel });
      const basis = await makeFileRow(tx, x.adminId, { name: 'Обоснование.pdf' });
      names.set(basis.id, 'basis');
      const ext = await extensions.applyExtension(tx, x.actor, { nodeId: node.id, daysByLevel, basisNumber: 'ОИКТ-7', basisDate: '2026-10-21', basisFileId: basis.id, expected: preview.items.length });
      names.set(ext.id, 'extension');
      await extensions.cancelExtension(tx, x.actor, ext.id);

      // 3. Одна запись «Устранена» вне сканов; второй скан: CVSS изменился, строка пропала, устранённая снова в файле.
      await x.reload();
      const all = await tx.registerRecord.findMany({ where: { registerId: x.reg.id, number: { gte: base } }, orderBy: { number: 'asc' } });
      const byCve = (cve: string) => must(all.find((r) => (r.values as Values)[x.vf.cve.id] === cve), cve);
      const fixed = byCve('BDU:2025-01793');
      await tx.registerRecord.update({ where: { id: fixed.id }, data: { values: { ...(fixed.values as object), [x.vf.status.id]: x.opt('status', 'fixed') } as Prisma.InputJsonValue } });
      const wb = await sampleBook();
      const ws = must(wb.worksheets.find((w) => w.name !== 'Хосты'));
      const col = (h: string) => {
        let n = 0;
        ws.getRow(1).eachCell((c, i) => {
          if (c.value === h) n = i;
        });
        return n;
      };
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const cve = row.getCell(col('CVE')).value;
        if (cve === 'CVE-2026-34621') row.getCell(col('CVSS')).value = 9.9;
        if (cve === 'CVE-2025-0411') row.eachCell((c, i) => {
          if (i !== col('Оценка')) c.value = null;
        });
      }
      const p2 = await scan.previewNodeScan(tx, store, x.actor, node.id, await toBuffer(wb), 'vuln-windows-2026-10-25.xlsx');
      const a2 = await scan.applyNodeScan(tx, x.actor, p2.id, { selected: { gone: p2.summary.groups.gone.map((i) => i.key) } });
      names.set(p2.id, 'import2').set(a2.scanId, 'scan2');
      expect([a2.reopened, a2.changed, a2.gone]).toEqual([1, 1, 1]);

      // 4. Обратный импорт по ID: «Обновить до версии» у трёх записей.
      const { buffer } = await excel.exportRegister(tx, x.reg.id);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      const main = must(book.getWorksheet(excel.MAIN_SHEET));
      let idCol = 0;
      let fixCol = 0;
      main.getRow(1).eachCell((c, i) => {
        if (c.value === 'ID') idCol = i;
        if (c.value === x.vf.fixVersion.label) fixCol = i;
      });
      let edited = 0;
      for (let r = 2; r <= main.rowCount && edited < 3; r++) {
        const row = main.getRow(r);
        if (Number(row.getCell(idCol).value) >= base && typeof row.getCell(fixCol).value === 'string') {
          row.getCell(fixCol).value = `${String(row.getCell(fixCol).value)} (проверено)`;
          edited++;
        }
      }
      const imp = await excel.previewImport(tx, x.actor, x.reg.id, Buffer.from(await book.xlsx.writeBuffer()), 'vulns-back.xlsx');
      names.set(imp.id, 'import3');
      expect((await excel.applyImport(tx, x.actor, imp.id)).updated).toBe(3);

      // 5. Перенос из «Без группы».
      const legacy = await groups.legacyNode(tx);
      names.set(legacy.id, 'legacy');
      const number = (await tx.register.findUniqueOrThrow({ where: { id: x.reg.id } })).nextNumber;
      await tx.register.update({ where: { id: x.reg.id }, data: { nextNumber: number + 1 } });
      const pkg = must(x.vf.pkg.options.find((o) => o.label === 'Igor Pavlov 7-Zip'));
      const old = await tx.registerRecord.create({
        data: { registerId: x.reg.id, number, values: { [x.vf.pkg.id]: pkg.id, [x.vf.cve.id]: 'CVE-2098-00001', [x.vf.status.id]: x.opt('status', 'open') } as Prisma.InputJsonValue },
      });
      await tx.vulnRecord.create({ data: { recordId: old.id, nodeId: legacy.id, legacy: true } });
      expect((await transferRecords(tx, x.actor, { recordIds: [old.id], nodeId: node.id })).moved).toHaveLength(1);

      const snap = JSON.parse(JSON.stringify(await snapshot(tx, x, { base, auditFrom, optionsBefore, names })));
      if (process.env.GOLDEN_DUMP) writeFileSync(process.env.GOLDEN_DUMP, `${JSON.stringify(snap, null, 1)}\n`);
      if (process.env.UPDATE_GOLDEN === '1') {
        writeFileSync(GOLDEN, `${JSON.stringify(snap, null, 1)}\n`);
        return;
      }
      expect(existsSync(GOLDEN), 'нет эталона test/fixtures/vuln-bulk-golden.json').toBe(true);
      const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
      expect(snap.records).toEqual(golden.records);
      expect(snap.vuln).toEqual(golden.vuln);
      expect(snap.seen).toEqual(golden.seen);
      expect(snap.options).toEqual(golden.options);
      expect(snap.scans).toEqual(golden.scans);
      expect(snap.audit).toEqual(golden.audit);
    }), 120_000);
});
