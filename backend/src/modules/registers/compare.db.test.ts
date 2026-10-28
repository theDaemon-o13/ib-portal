import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import type { Values } from '../../lib/register-values.js';
import { expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { makeRegister } from '../../test/registers-fixture.js';
import { SAMPLE, SAMPLE_NAME, sampleBook, toBuffer, vulnRegister } from '../../test/vulns-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { sweepOrphanFiles } from '../files/links.js';
import { seedVulnDepartments } from '../../../prisma/seed/vulns.js';
import * as scan from '../vulns/scan-import.service.js';
import { parseScanReport } from '../vulns/scan-parser.js';
import * as compare from './compare.service.js';
import * as excel from './excel.service.js';
import { XLSX_TYPE } from './routes.js';
import * as records from './records.service.js';
import * as structure from './structure.service.js';

// Релиз 1.1.0, задача 4: сравнение с реестром — «Нет в файле», неполный скан, статус с журналом и файлом.

const root = mkdtempSync(join(tmpdir(), 'ibportal-compare-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Отчёт сканера без строки уязвимости `cve` и без хоста `host`. */
async function reportWithout(cve: string, host: string): Promise<Buffer> {
  const wb = await sampleBook();
  for (const ws of wb.worksheets) {
    const rows: number[] = [];
    ws.eachRow((row, n) => {
      const cells = (row.values as unknown[]).map((v) => String(v ?? ''));
      if (cells.includes(cve) || cells.includes(host)) rows.push(n);
    });
    for (const n of rows.reverse()) ws.spliceRows(n, 1);
  }
  return toBuffer(wb);
}

async function firstHost(): Promise<string> {
  return must((await parseScanReport(SAMPLE, SAMPLE_NAME)).hosts[0]).name;
}

describe('настройки сравнения', () => {
  it('seed: реестр уязвимостей — ключ «CVE / БДУ + Пакет», область «Отдел», «Система», «Отчёт сканирования»; DLP — ключ импорта', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      expect(x.reg.compareKeyFieldIds).toEqual([x.vf.cve.id, x.vf.pkg.id]);
      expect(x.reg.compareScopeFieldIds).toEqual([x.vf.department.id, x.vf.system.id, x.vf.report.id]);
      const keys = await tx.registerField.findMany({ where: { isImportKey: true, deletedAt: null } });
      for (const k of keys) {
        expect((await tx.register.findUniqueOrThrow({ where: { id: k.registerId } })).compareKeyFieldIds).toEqual([k.id]);
      }
    }));

  it('ключ и область проверяются; поле из настроек не уходит в архив и не меняет тип', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      await expectCode(structure.updateRegister(tx, x.actor, x.reg.id, { version: x.reg.version, compareKeyFieldIds: [x.f.due] }), 'BAD_COMPARE');
      await expectCode(structure.updateRegister(tx, x.actor, x.reg.id, { version: x.reg.version, compareScopeFieldIds: [x.f.title] }), 'BAD_COMPARE');
      const reg = await structure.updateRegister(tx, x.actor, x.reg.id, { version: x.reg.version, compareKeyFieldIds: [x.f.title, x.f.score], compareScopeFieldIds: [x.f.level] });
      expect([reg.compareKeyFieldIds, reg.compareScopeFieldIds]).toEqual([[x.f.title, x.f.score], [x.f.level]]);
      const score = must(reg.fields.find((f) => f.id === x.f.score));
      await expectCode(structure.setFieldArchived(tx, x.actor, x.f.score, score.version, true), 'COMPARE_FIELD');
      await expectCode(structure.previewTypeChange(tx, x.f.score, 'text'), 'COMPARE_FIELD');
    }));
});

describe('сравнение выгрузки реестра', () => {
  it('«Нет в файле» — открытые записи области с ключом; без ключа, закрытые, архивные и вне области — нет', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const title = must(x.reg.fields.find((f) => f.id === x.f.title));
      await structure.updateField(tx, x.actor, x.f.title, { version: title.version, isImportKey: true });
      const r0 = await x.reload();
      await structure.updateRegister(tx, x.actor, x.reg.id, { version: r0.version, compareKeyFieldIds: [x.f.title, x.f.score], compareScopeFieldIds: [x.f.level] });
      const high = x.opt('level', 'Высокий');
      const mk = (t: string, extra: Values) => records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: t, [x.f.level]: high, ...extra } });
      await mk('A', { [x.f.score]: 1 });
      const b = await mk('B', { [x.f.score]: 2 });
      await mk('C', { [x.f.score]: 3, [x.f.level]: x.opt('level', 'Средний') });
      await mk('D', { [x.f.score]: 4, [x.f.status]: x.opt('status', 'Закрыт') });
      const e = await mk('E', { [x.f.score]: 5 });
      await records.setRecordArchived(tx, x.actor, e.id, e.version, true);
      await mk('G', {});

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Реестр');
      ws.addRow(['Наименование', 'Уровень', 'Баллы']);
      ws.addRow([' a ', 'Высокий', 1]);
      ws.addRow(['C', 'Средний', 3]);
      ws.addRow(['X', 'Высокий', 9]);
      const buffer = Buffer.from(await wb.xlsx.writeBuffer());
      const p = await excel.previewImport(tx, x.actor, x.reg.id, buffer, 'выгрузка.xlsx');

      await expectCode(compare.compareWithRegister(tx, store, x.actor, p.id, buffer, { fieldId: x.f.level, values: [] }), 'BAD_SCOPE');
      await expectCode(compare.compareWithRegister(tx, store, x.actor, p.id, Buffer.from(SAMPLE), { all: true }), 'FILE_MISMATCH');
      const c = await compare.compareWithRegister(tx, store, x.actor, p.id, buffer, { fieldId: x.f.level, values: [high] });
      expect(c.missing.map((m) => m.number)).toEqual([b.number]);
      expect(c).toMatchObject({ format: 'records', noKey: 1, outOfScopeRows: 1, badKeyRows: 0, incompleteScan: null });
      expect(c.missing[0]?.key).toBe('B · 2');
      // «Весь реестр»: C в файле есть, D закрыта, E в архиве — отсутствует только B.
      expect((await compare.compareWithRegister(tx, store, x.actor, p.id, buffer, { all: true })).missing.map((m) => m.number)).toEqual([b.number]);

      // Файл — в хранилище, предпросмотр ссылается на него; уборка «через 3 дня» его не трогает.
      const imp = await tx.registerImport.findUniqueOrThrow({ where: { id: p.id }, include: { file: true } });
      expect(imp.file).toMatchObject({ id: c.file.id, sha256: c.file.sha256, mime: expect.stringContaining('spreadsheetml') });
      await sweepOrphanFiles(tx, new Date(Date.now() + 3 * 86_400_000));
      expect((await tx.file.findUniqueOrThrow({ where: { id: c.file.id } })).deletedAt).toBeNull();
      const run = must(await tx.auditLog.findFirst({ where: { action: 'register.compare.run', entityId: x.reg.id } }));
      expect(run.diff).toMatchObject({ after: { fileId: c.file.id, sha256: c.file.sha256, missing: 1, noKey: 1 } });
    }));
});

describe('сравнение отчёта сканера', () => {
  it('ключ «CVE + пакет» в области отчёта, неполный скан; статус — с подтверждением, журналом и ссылкой на файл', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const first = await scan.previewScan(tx, x.actor, x.reg.id, SAMPLE, SAMPLE_NAME);
      await scan.applyScan(tx, x.actor, first.id, {});
      await x.reload();
      const report = must(x.vf.report.options.at(-1));
      const victim = must((await tx.registerRecord.findMany({ where: { registerId: x.reg.id, deletedAt: null }, orderBy: { number: 'asc' } }))[0]);
      const cve = String((victim.values as Values)[x.vf.cve.id]);
      const host = await firstHost();
      const buffer = await reportWithout(cve, host);
      const name = 'scan-report-sample-2026-10-22.xlsx';
      const p = await scan.previewScan(tx, x.actor, x.reg.id, buffer, name);

      const scope = { fieldId: x.vf.report.id, values: [report.id] };
      const c = await compare.compareWithRegister(tx, store, x.actor, p.id, buffer, scope);
      expect(c.format).toBe('scan');
      expect(c.missing.map((m) => m.id)).toContain(victim.id);
      expect(c.missing.every((m) => m.key.includes('·'))).toBe(true);
      expect(c.incompleteScan).toMatchObject({ previousReport: report.label, missingHosts: [host] });
      // Полный отчёт тех же уязвимостей: отсутствующих нет.
      const full = await scan.previewScan(tx, x.actor, x.reg.id, SAMPLE, SAMPLE_NAME);
      const cf = await compare.compareWithRegister(tx, store, x.actor, full.id, SAMPLE, scope);
      expect([cf.missing.length, cf.incompleteScan]).toEqual([0, null]);

      const fixed = x.opt('status', 'fixed');
      const changes = c.missing.map((m) => ({ recordId: m.id, optionId: fixed }));
      const pv = await compare.previewCompareStatus(tx, store, p.id, scope, changes, null);
      expect(pv).toMatchObject({ total: changes.length, willChange: changes.length, skipped: [] });
      await expectCode(compare.applyCompareStatus(tx, store, x.actor, p.id, scope, changes, { expected: { willChange: pv.willChange + 1 }, reason: null, acknowledgeIncompleteScan: true }), 'BULK_CHANGED');
      await expectCode(compare.applyCompareStatus(tx, store, x.actor, p.id, scope, changes, { expected: { willChange: pv.willChange }, reason: null, acknowledgeIncompleteScan: false }), 'INCOMPLETE_SCAN');
      const done = await compare.applyCompareStatus(tx, store, x.actor, p.id, scope, changes, { expected: { willChange: pv.willChange }, reason: null, acknowledgeIncompleteScan: true });
      expect(done).toEqual({ changed: changes.length, skipped: 0 });
      expect((await records.getRecord(tx, victim.id)).values[x.vf.status.id]).toBe(fixed);

      // История записи: правка «по сравнению» со ссылкой на файл отчёта.
      const upd = must(await tx.auditLog.findFirst({ where: { entityId: victim.id, action: 'register_record.updated' }, orderBy: { id: 'desc' } }));
      expect(upd.diff).toMatchObject({ after: { via: 'compare', importId: p.id, fileId: c.file.id, sha256: c.file.sha256 } });
      const sum = must(await tx.auditLog.findFirst({ where: { entityId: x.reg.id, action: 'register_records.compare_status' } }));
      expect(sum.diff).toMatchObject({ after: { fileId: c.file.id, changed: changes.length, incompleteScan: { missingHosts: [host] } } });

      // Повторно: записи закрыты — больше не «нет в файле».
      const again = await compare.previewCompareStatus(tx, store, p.id, scope, changes, null);
      expect(again.willChange).toBe(0);
      expect(again.skipped[0]?.reason).toContain('нашлась в файле, закрыта');
    }));
});

describe('этап Б.2: отдел, подсказка, область по умолчанию', () => {
  it('seed заполняет «Отдел» у записей, загруженных до 1.1.0, по отчёту; журнал по записи и сводный; повторно — ничего', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const first = await scan.previewScan(tx, x.actor, x.reg.id, SAMPLE, SAMPLE_NAME);
      await scan.applyScan(tx, x.actor, first.id, {});
      await x.reload();
      const deptId = x.vf.department.id;
      // Как до 1.1.0: у записей нет отдела.
      await tx.$executeRaw`UPDATE register_records SET "values" = "values" - ${deptId} WHERE register_id = ${x.reg.id}::uuid`;
      const manual = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.vf.cve.id]: 'CVE-2026-11111' } });
      expect(await seedVulnDepartments(tx)).toContain('заполнено у записей 90');
      const rows = await tx.registerRecord.findMany({ where: { registerId: x.reg.id, deletedAt: null } });
      expect(rows.filter((r) => (r.values as Values)[deptId] !== undefined)).toHaveLength(90);
      expect((rows.find((r) => r.id === manual.id)?.values as Values)[deptId]).toBeUndefined();
      const one = must(rows.find((r) => r.id !== manual.id));
      const h = await records.recordHistory(tx, one.id);
      expect(h[0]?.summary).toContain('«Отдел» — «Отдел платёжных карт» по отчёту');
      expect(await seedVulnDepartments(tx)).toContain('заполнено у записей 0');
    }));

  it('подсказка «нет в этом отчёте» и сравнение по умолчанию — отдел и система; без системы — «все системы»', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const sys = must(await tx.catalogItem.findFirst({ where: { catalogCode: 'systems', deletedAt: null, archivedAt: null } }));
      const first = await scan.previewScan(tx, x.actor, x.reg.id, SAMPLE, SAMPLE_NAME);
      await scan.applyScan(tx, x.actor, first.id, { systemId: sys.id });
      await x.reload();
      const victim = must((await tx.registerRecord.findMany({ where: { registerId: x.reg.id, deletedAt: null }, orderBy: { number: 'asc' } }))[0]);
      const buffer = await reportWithout(String((victim.values as Values)[x.vf.cve.id]), 'нет такого хоста');
      const p = await scan.previewScan(tx, x.actor, x.reg.id, buffer, 'scan-report-sample-2026-11-15.xlsx');

      const all = await compare.notInReport(tx, p.id, null);
      expect(all).toMatchObject({ count: 1, label: 'отдел «Отдел платёжных карт», все системы' });
      const withSys = await compare.notInReport(tx, p.id, sys.id);
      expect(withSys).toMatchObject({ count: 1, label: `отдел «Отдел платёжных карт», система «${sys.value}»` });
      const other = must(await tx.catalogItem.findFirst({ where: { catalogCode: 'systems', deletedAt: null, id: { not: sys.id } } }));
      expect((await compare.notInReport(tx, p.id, other.id)).count).toBe(0);

      const c = await compare.compareWithRegister(tx, store, x.actor, p.id, buffer, must(withSys.scope));
      expect(c.missing.map((m) => m.id)).toEqual([victim.id]);
      expect(c.scope.label).toBe(`отдел «Отдел платёжных карт», система «${sys.value}»`);
      // Прежний вид области (одно условие) по-прежнему принимается.
      const legacy = await compare.compareWithRegister(tx, store, x.actor, p.id, buffer, { fieldId: x.vf.department.id, values: [must(x.vf.department.options[0]).id] });
      expect(legacy.missing.map((m) => m.id)).toEqual([victim.id]);
    }));
});

describe('сравнение по HTTP', () => {
  it('сравнение и статус — records.edit; без права — 403', () =>
    inTx(async (tx: Tx) => {
      const PASSWORD = 'Http-Compare-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const x = await vulnRegister(tx);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const board = await makeUser(tx, ['board'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const p = await scan.previewScan(tx, x.actor, x.reg.id, SAMPLE, SAMPLE_NAME);
      const url = `/api/v1/register-imports/${p.id}/compare?scope=all`;
      const headers = (cookie: string) => ({ cookie, 'content-type': XLSX_TYPE });
      expect((await app.inject({ method: 'POST', url, headers: headers(await login(board.login)), payload: SAMPLE })).statusCode).toBe(403);
      const ok = await app.inject({ method: 'POST', url, headers: headers(await login(staff.login)), payload: SAMPLE });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ format: 'scan', scope: { all: true } });
    }));
});
