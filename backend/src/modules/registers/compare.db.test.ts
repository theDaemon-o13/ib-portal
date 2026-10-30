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
import { SAMPLE, vulnRegister } from '../../test/vulns-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { sweepOrphanFiles } from '../files/links.js';
import * as compare from './compare.service.js';
import * as excel from './excel.service.js';
import { XLSX_TYPE } from './routes.js';
import * as records from './records.service.js';
import * as structure from './structure.service.js';

// Релиз 1.1.0, задача 4: сравнение с реестром — «Нет в файле», статус с журналом и файлом.

const root = mkdtempSync(join(tmpdir(), 'ibportal-compare-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

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

describe('реестр уязвимостей (релиз 1.5.0)', () => {
  it('сравнивается при импорте скана в узел: выгрузка реестра здесь — 409, статус по сравнению — тоже', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const exported = await excel.exportRegister(tx, x.reg.id);
      const p = await excel.previewImport(tx, x.actor, x.reg.id, exported.buffer, exported.fileName);
      await expectCode(compare.compareWithRegister(tx, store, x.actor, p.id, exported.buffer, { all: true }), 'VULN_COMPARE_IN_NODE');
      await expectCode(compare.previewCompareStatus(tx, store, p.id, { all: true }, [], null), 'COMPARE_FILE_MISSING');
    }));
});

describe('сравнение по HTTP', () => {
  it('сравнение и статус — records.edit; без права — 403', () =>
    inTx(async (tx: Tx) => {
      const PASSWORD = 'Http-Compare-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const x = await makeRegister(tx);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const board = await makeUser(tx, ['doc_reader'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const exported = await excel.exportRegister(tx, x.reg.id);
      const p = await excel.previewImport(tx, x.actor, x.reg.id, exported.buffer, exported.fileName);
      const url = `/api/v1/register-imports/${p.id}/compare?scope=all`;
      const headers = (cookie: string) => ({ cookie, 'content-type': XLSX_TYPE });
      expect((await app.inject({ method: 'POST', url, headers: headers(await login(board.login)), payload: exported.buffer })).statusCode).toBe(403);
      const ok = await app.inject({ method: 'POST', url, headers: headers(await login(staff.login)), payload: exported.buffer });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ format: 'records', scope: { all: true } });
    }));
});
