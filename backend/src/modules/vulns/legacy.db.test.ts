// Шаг 2 релиза 1.5.0 (ADR-0029, ADR-0030): перенос прежнего реестра в «Без группы / Из прежнего реестра»,
// служебные поля срока, «Перенести» и «Перенести выбранные». Записи «как в 1.1.0» создаются напрямую — без узла.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import type { Values } from '../../lib/register-values.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { seedVulnLegacy } from '../../../prisma/seed/vuln-legacy.js';
import { seedVulnDepartments } from '../../../prisma/seed/vulns.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as excel from '../registers/excel.service.js';
import * as records from '../registers/records.service.js';
import * as groups from './groups.service.js';
import { transferRecords } from './transfer.service.js';

const PASSWORD = 'Vulns-Test-Pass-2026';
const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Пакет — значение списка реестра (как создаёт импорт 1.1.0). */
async function pkgOption(tx: Tx, x: VulnFixture, label: string): Promise<string> {
  const have = x.vf.pkg.options.find((o) => o.label === label);
  if (have) return have.id;
  const o = await tx.registerFieldOption.create({ data: { fieldId: x.vf.pkg.id, label, sortOrder: 1000 + x.vf.pkg.options.length } });
  await x.reload();
  return o.id;
}

/** Запись «как в 1.1.0»: без строки vuln_records. */
async function legacyRecord(tx: Tx, x: VulnFixture, v: { pkg?: string; cve: string; crit?: string; notified?: string; extra?: Values; deleted?: boolean }) {
  const values: Values = { [x.vf.cve.id]: v.cve, [x.vf.status.id]: x.opt('status', 'open'), [x.vf.crit.id]: x.opt('crit', v.crit ?? 'critical'), ...(v.extra ?? {}) };
  if (v.pkg) values[x.vf.pkg.id] = await pkgOption(tx, x, v.pkg);
  if (v.notified) values[x.vf.notified.id] = v.notified;
  const number = await records.nextNumbers(tx, x.reg.id, 1);
  return tx.registerRecord.create({
    data: { registerId: x.reg.id, number, values: values as Prisma.InputJsonValue, searchText: v.cve.toLowerCase(), ...(v.deleted ? { deletedAt: new Date() } : {}) },
  });
}

/** Отчёт сканера «как в 1.1.0» с хостами и значением «Отчёт сканирования» у записей. */
async function legacyReport(tx: Tx, x: VulnFixture, label: string) {
  const imp = await tx.registerImport.create({
    data: { registerId: x.reg.id, kind: 'scan', status: 'applied', fileName: 'old.xlsx', fileSha256: 'a'.repeat(64), summary: {}, payload: {}, createdBy: x.adminId, expiresAt: new Date() },
  });
  const report = await tx.scanReport.create({
    data: {
      registerId: x.reg.id, importId: imp.id, fileName: 'old-2026-09-01.xlsx', fileSha256: 'a'.repeat(64), reportDate: new Date('2026-09-01'), notifiedDate: new Date('2026-09-03'),
      department: 'Отдел карт', label, rowsTotal: 2, createdCount: 2, mergedCount: 0, hostsCount: 2, createdBy: x.adminId,
      hosts: { create: [{ sortOrder: 1, name: 'PC-1' }, { sortOrder: 2, name: 'PC-2' }] },
    },
  });
  const option = await tx.registerFieldOption.create({ data: { fieldId: x.vf.report.id, label, sortOrder: 1000 } });
  await x.reload();
  return { report, option };
}

async function dueOf(tx: Tx, id: string): Promise<string | null> {
  const rec = await records.getRecord(tx, id);
  const regRow = await tx.registerRecord.findUniqueOrThrow({ where: { id } });
  const reg = await tx.registerField.findFirstOrThrow({ where: { registerId: regRow.registerId, systemKey: 'due' } });
  const v = rec.calc[reg.id];
  return typeof v === 'string' ? v : null;
}

describe('уязвимости: перенос прежнего реестра в «Без группы»', () => {
  it('все записи и отчёты — в «Без группы»; «Срок из прежнего реестра» = прежний срок по процедуре; итоговый срок не меняется; повтор ничего не делает', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const { option } = await legacyReport(tx, x, unique('Отдел карт · 01.09.2026'));
      const a = await legacyRecord(tx, x, { pkg: '7-Zip', cve: 'CVE-2025-0411', notified: '2026-09-03', extra: { [x.vf.report.id]: option.id } });
      const decided = await legacyRecord(tx, x, { pkg: 'OpenSSL', cve: 'CVE-2024-0001', crit: 'medium', notified: '2026-09-03', extra: { [x.vf.measures.id]: 'Сегментация', [x.vf.newDue.id]: '2027-03-01' } });
      const noDue = await legacyRecord(tx, x, { pkg: 'Chrome', cve: 'CVE-2024-0002' });
      const closed = await legacyRecord(tx, x, { pkg: '7-Zip', cve: 'CVE-2025-0411', notified: '2026-08-01', extra: { [x.vf.status.id]: x.opt('status', 'fixed') } });
      const deleted = await legacyRecord(tx, x, { pkg: 'Chrome', cve: 'CVE-2024-0003', notified: '2026-09-03', deleted: true });
      const before = new Map<string, string | null>();
      for (const r of [a, decided, noDue, closed]) before.set(r.id, await dueOf(tx, r.id));
      const auditBefore = await tx.auditLog.count({ where: { entityId: a.id } });

      const sum = must(await seedVulnLegacy(tx));
      expect(sum).toEqual({ records: 5, open: 3, withDue: 3, withoutDue: 1, deleted: 1, reports: 1, hosts: 2, archivedReports: 0, duplicateKeys: 1 });

      const legacy = await groups.legacyNode(tx);
      const rows = await tx.vulnRecord.findMany({ where: { recordId: { in: [a.id, decided.id, noDue.id, closed.id, deleted.id] } } });
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.nodeId === legacy.id && r.legacy && r.keyNorm === null && r.cycle === 1)).toBe(true);
      // Отчёт прежнего реестра — скан «Без группы», передан ИКТ в «Уведомлено ДИКТ»; запись связана со сканом своего отчёта.
      const scan = must(await tx.vulnScan.findFirst({ where: { nodeId: legacy.id, legacyReportId: { not: null } }, orderBy: { createdAt: 'desc' } }));
      expect(scan).toMatchObject({ hostsCount: 2, coverageTitle: 'Отдел карт', handedOverTo: 'ДИКТ' });
      expect(scan.handedOverOn?.toISOString().slice(0, 10)).toBe('2026-09-03');
      expect(must(rows.find((r) => r.recordId === a.id)).firstScanId).toBe(scan.id);
      expect(await tx.vulnRecordScan.count({ where: { recordId: a.id, scanId: scan.id, outcome: 'legacy' } })).toBe(1);

      await x.reload();
      const values = async (id: string) => (await tx.registerRecord.findUniqueOrThrow({ where: { id } })).values as Values;
      expect((await values(a.id))[x.vf.legacyDue.id]).toBe(before.get(a.id));
      // Решение п. 7.3 — не «Срок из прежнего реестра»: туда — срок по процедуре, итог — по-прежнему решение.
      expect((await values(decided.id))[x.vf.legacyDue.id]).toBe('2026-12-02');
      expect((await values(noDue.id))[x.vf.legacyDue.id]).toBeUndefined();
      for (const r of [a, decided, noDue, closed]) expect(await dueOf(tx, r.id), `#${r.number}`).toBe(before.get(r.id));
      // Остальные значения не меняются; по записи — строка журнала.
      const { [x.vf.legacyDue.id]: added, ...rest } = await values(a.id);
      expect(added).toBeDefined();
      expect(rest).toEqual(a.values);
      expect(await tx.auditLog.count({ where: { entityId: a.id } })).toBe(auditBefore + 1);
      expect(await tx.auditLog.count({ where: { action: 'vuln.legacy.moved', entityId: legacy.id } })).toBe(1);

      const version = (await tx.registerRecord.findUniqueOrThrow({ where: { id: a.id } })).version;
      expect(await seedVulnLegacy(tx)).toMatchObject({ records: 0, reports: 0 });
      expect((await tx.registerRecord.findUniqueOrThrow({ where: { id: a.id } })).version).toBe(version);
    }));

  it('seed заполняет «Отдел» у записей, загруженных до 1.1.0, по отчёту; журнал по записи; без отчёта — нет; повторно — ничего', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const { option } = await legacyReport(tx, x, unique('Отдел карт · 01.09.2026'));
      const a = await legacyRecord(tx, x, { pkg: '7-Zip', cve: 'CVE-2025-0411', extra: { [x.vf.report.id]: option.id } });
      const manual = await legacyRecord(tx, x, { pkg: 'Curl', cve: 'CVE-2026-11111' });
      expect(await seedVulnDepartments(tx)).toContain('заполнено у записей 1');
      await x.reload();
      const dept = async (id: string) => ((await tx.registerRecord.findUniqueOrThrow({ where: { id } })).values as Values)[x.vf.department.id];
      expect(x.vf.department.options.find((o) => o.label === 'Отдел карт')?.id).toBe(await dept(a.id));
      expect(await dept(manual.id)).toBeUndefined();
      expect((await records.recordHistory(tx, a.id))[0]?.summary).toContain('«Отдел» — «Отдел карт» по отчёту');
      expect(await seedVulnDepartments(tx)).toContain('заполнено у записей 0');
    }));

  it('служебные поля вручную не меняются: карточка — 409, обратный импорт Excel — колонка только для чтения', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const r = await legacyRecord(tx, x, { pkg: 'Curl', cve: 'CVE-2024-1111', notified: '2026-10-01' });
      await seedVulnLegacy(tx);
      await x.reload();
      const rec = await records.getRecord(tx, r.id);
      for (const f of [x.vf.notified, x.vf.legacyDue, x.vf.extDays]) {
        expect(f.managed).toBe(true);
        await expectCode(records.updateRecord(tx, x.actor, r.id, { version: rec.version, values: { [f.id]: f.type === 'number' ? 5 : '2030-01-01' } }), 'VULN_SERVICE_FIELD');
      }
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await excel.exportRegister(tx, x.reg.id)).buffer as unknown as ExcelJS.Buffer);
      const ws = must(wb.getWorksheet('Реестр'));
      let col = 0;
      ws.getRow(1).eachCell((c, i) => {
        if (c.value === x.vf.legacyDue.label) col = i;
      });
      expect(col).toBeGreaterThan(0);
      for (let i = 2; i <= ws.rowCount; i++) if (ws.getRow(i).getCell(1).value === rec.number) ws.getRow(i).getCell(col).value = new Date('2030-01-01T00:00:00Z');
      const p = await excel.previewImport(tx, x.actor, x.reg.id, Buffer.from(await wb.xlsx.writeBuffer()), 'ДИКТ.xlsx');
      expect(p.summary.warnings.join(' ')).toContain('только для чтения» изменено значений: 1');
    }));
});

describe('уязвимости: страница «Реестры»', () => {
  it('новые записи только из сканов: создание по API — 409, пустой ID в обратном импорте — ошибка строки; правка по ID работает', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const r = await legacyRecord(tx, x, { pkg: 'Curl', cve: 'CVE-2024-2222', notified: '2026-10-01' });
      await seedVulnLegacy(tx);
      await x.reload();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await excel.exportRegister(tx, x.reg.id)).buffer as unknown as ExcelJS.Buffer);
      const ws = must(wb.getWorksheet('Реестр'));
      let col = 0;
      ws.getRow(1).eachCell((c, i) => {
        if (c.value === x.vf.comment.label) col = i;
      });
      for (let i = 2; i <= ws.rowCount; i++) if (ws.getRow(i).getCell(1).value === r.number) ws.getRow(i).getCell(col).value = 'Комментарий ДИКТ';
      const added = ws.addRow([]);
      added.getCell(col).value = 'Без ID';
      const p = await excel.previewImport(tx, x.actor, x.reg.id, Buffer.from(await wb.xlsx.writeBuffer()), 'ДИКТ.xlsx');
      expect([p.summary.added, p.summary.updated, p.summary.errorRows]).toEqual([0, 1, 1]);

      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL });
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: await argon2Hasher.hash(PASSWORD) });
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: staff.login, password: PASSWORD } });
      const cookie = `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      const created = await app.inject({ method: 'POST', url: `/api/v1/registers/${x.reg.id}/records`, headers: { cookie, origin: TEST_PORTAL_URL }, payload: { values: { [x.vf.cve.id]: 'CVE-1' } } });
      expect([created.statusCode, (created.json() as { error: { code: string } }).error.code]).toEqual([409, 'VULN_CREATE_IN_NODE']);
    }));
});

describe('уязвимости: «Перенести» из «Без группы»', () => {
  async function setup(tx: Tx) {
    const x = await vulnRegister(tx);
    const t = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: 'Рабочие станции' } });
    const g = await groups.createGroup(tx, x.actor, { name: unique('Отдел платёжных карт'), kind: 'department', systemTypeIds: [t.id] });
    return { x, node: must(g.nodes[0]) };
  }

  it('выбранные переносятся; ключ, который в узле уже есть или повторяется среди выбранных, — отказ по строке; срок сохраняется', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const a = await legacyRecord(tx, x, { pkg: '7-Zip', cve: 'CVE-2025-0411', notified: '2026-10-01' });
      const twin = await legacyRecord(tx, x, { pkg: ' 7-zip ', cve: 'cve-2025-0411', notified: '2026-10-05' });
      const c = await legacyRecord(tx, x, { pkg: 'Chrome', cve: 'CVE-2024-0002', notified: '2026-10-01' });
      const noPkg = await legacyRecord(tx, x, { cve: 'CVE-2024-0003' });
      await seedVulnLegacy(tx);
      const dueA = await dueOf(tx, a.id);
      const res = await transferRecords(tx, x.actor, { recordIds: [a.id, twin.id, c.id, noPkg.id], nodeId: node.id });
      expect(res.moved.map((m) => m.number)).toEqual([a.number, c.number]);
      expect(res.rejected.map((r) => [r.number, r.reason])).toEqual([
        [twin.number, `В узле уже есть «7-zip · cve-2025-0411» (#${a.number})`],
        [noPkg.number, 'Нет пакета или идентификатора — ключ «Пакет + Идентификатор» не определить'],
      ]);
      const moved = await tx.vulnRecord.findUniqueOrThrow({ where: { recordId: a.id } });
      expect(moved).toMatchObject({ nodeId: node.id, keyNorm: '7-zip\u001fcve-2025-0411', legacy: true });
      expect(await dueOf(tx, a.id)).toBe(dueA);
      expect(await tx.auditLog.findFirst({ where: { action: 'vuln.record.transferred', entityId: a.id } })).toBeTruthy();
      expect(await tx.auditLog.findFirst({ where: { action: 'vuln.records.transferred', entityId: node.id } })).toBeTruthy();
      // Повторно из узла не переносится; в «Без группы» — нельзя.
      expect((await transferRecords(tx, x.actor, { recordIds: [a.id], nodeId: node.id })).rejected[0]?.reason).toBe('Переносятся только записи из «Без группы»');
      const legacy = await groups.legacyNode(tx);
      await expectCode(transferRecords(tx, x.actor, { recordIds: [twin.id], nodeId: legacy.id }), 'LEGACY_TARGET');

      // Удалённая запись освобождает ключ: теперь переносится вторая.
      await records.deleteRecord(tx, x.actor, a.id, (await tx.registerRecord.findUniqueOrThrow({ where: { id: a.id } })).version);
      expect((await tx.vulnRecord.findUniqueOrThrow({ where: { recordId: a.id } })).keyNorm).toBeNull();
      expect((await transferRecords(tx, x.actor, { recordIds: [twin.id], nodeId: node.id })).moved).toHaveLength(1);
    }));

  it('права: «Перенести» — records.edit', () =>
    inTx(async (tx) => {
      const { x, node } = await setup(tx);
      const r = await legacyRecord(tx, x, { pkg: 'Zoom', cve: 'CVE-2024-7777', notified: '2026-10-01' });
      await seedVulnLegacy(tx);
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL,
      });
      const hash = await argon2Hasher.hash(PASSWORD);
      const head = await makeUser(tx, ['ib_head'], { passwordHash: hash });
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return { cookie: `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`, origin: TEST_PORTAL_URL };
      };
      const payload = { recordIds: [r.id], nodeId: node.id };
      expect((await app.inject({ method: 'POST', url: '/api/v1/vulns/records/transfer', headers: await login(head.login), payload })).statusCode).toBe(403);
      const ok = await app.inject({ method: 'POST', url: '/api/v1/vulns/records/transfer', headers: await login(staff.login), payload });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ moved: [{ id: r.id }], rejected: [] });
    }));
});
