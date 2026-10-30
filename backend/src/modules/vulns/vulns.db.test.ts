import ExcelJS from 'exceljs';
import type { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { addDays, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { expectCode, inTx, lastAudit, must, type Tx } from '../../test/db.js';
import { makeRegister } from '../../test/registers-fixture.js';
import { SAMPLE, SAMPLE_NAME, sampleBook, toBuffer, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import * as excel from '../registers/excel.service.js';
import * as records from '../registers/records.service.js';
import * as structure from '../registers/structure.service.js';
import * as scan from './scan-import.service.js';

async function importSample(tx: Tx, x: VulnFixture, buffer: Buffer = SAMPLE, name = SAMPLE_NAME, input: scan.ApplyScanInput = {}) {
  const p = await scan.previewScan(tx, x.actor, x.reg.id, buffer, name);
  return { preview: p, applied: await scan.applyScan(tx, x.actor, p.id, input) };
}

async function recordsOf(tx: Tx, x: VulnFixture) {
  const rows = await tx.registerRecord.findMany({ where: { registerId: x.reg.id, deletedAt: null }, orderBy: { number: 'asc' } });
  return rows.map((r) => ({ ...r, values: r.values as Values }));
}

async function byCve(tx: Tx, x: VulnFixture, cve: string) {
  const r = (await recordsOf(tx, x)).find((v) => v.values[x.vf.cve.id] === cve);
  if (!r) throw new Error(`нет записи ${cve}`);
  return records.getRecord(tx, r.id);
}

/** Лист «Уязвимости» образца: номер строки по CVE и номер колонки по заголовку. */
function sheet(wb: ExcelJS.Workbook) {
  const ws = wb.getWorksheet('Уязвимости') as ExcelJS.Worksheet;
  const col = (h: string) => {
    let n = 0;
    ws.getRow(1).eachCell((c, i) => {
      if (c.value === h) n = i;
    });
    return n;
  };
  const rowOf = (cve: string) => {
    for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(col('CVE')).value === cve) return ws.getRow(r);
    throw new Error(`нет строки ${cve}`);
  };
  return { ws, col, rowOf };
}

describe('системный реестр уязвимостей', () => {
  it('создан seed: поля по процедуре, правила вычисления, системные правила п. 7.4', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      expect(x.reg.name).toBe('Реестр уязвимостей');
      expect(x.vf.cve.isTitle).toBe(true);
      expect(x.vf.status.isStatus).toBe(true);
      expect(x.vf.status.options.filter((o) => o.isClosed).map((o) => o.label)).toEqual(['Устранена', 'Риск принят']);
      expect(x.vf.score.calcRule).toMatchObject({ kind: 'vuln_score', cvssFieldId: x.vf.cvss.id });
      expect(x.vf.due.calcRule).toMatchObject({
        fromFieldId: x.vf.notified.id, byFieldId: x.vf.crit.id, overrideFieldId: x.vf.newDue.id,
        overrideWhenFilledFieldId: x.vf.measures.id, shiftToWorkday: true,
        days: { [x.opt('crit', 'critical')]: 14, [x.opt('crit', 'high')]: 30, [x.opt('crit', 'medium')]: 90, [x.opt('crit', 'low')]: 180 },
      });
      const rules = await tx.registerAutomation.findMany({ where: { registerId: x.reg.id }, orderBy: { systemKey: 'asc' } });
      expect(rules.map((r) => r.systemKey)).toEqual(['vuln.overdue_escalate', 'vuln.overdue_notify', 'vuln.remind_before_due']);
    }));

  it('системные поля и значения: переименовать можно; удалить, в архив, сменить тип — нет; свои поля добавлять можно', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const cvss = x.vf.cvss;
      await expectCode(structure.deleteField(tx, x.actor, cvss.id, cvss.version), 'SYSTEM_FIELD');
      await expectCode(structure.setFieldArchived(tx, x.actor, cvss.id, cvss.version, true), 'SYSTEM_FIELD');
      await expectCode(structure.previewTypeChange(tx, cvss.id, 'text'), 'SYSTEM_FIELD');
      await expectCode(structure.applyTypeChange(tx, x.actor, cvss.id, { version: cvss.version, to: 'text' }), 'SYSTEM_FIELD');
      const due = x.vf.due;
      await expectCode(structure.updateField(tx, x.actor, due.id, {
        version: due.version, calcRule: { fromFieldId: x.vf.notified.id, byFieldId: x.vf.crit.id, days: {}, overrideFieldId: null },
      }), 'SYSTEM_FIELD');
      await expectCode(structure.updateField(tx, x.actor, x.vf.desc.id, { version: x.vf.desc.version, isTitle: true }), 'SYSTEM_FIELD');
      const exploited = must(x.vf.exploit.options.find((o) => o.systemKey === 'exploited'));
      await expectCode(structure.deleteOption(tx, x.actor, exploited.id, exploited.version), 'SYSTEM_OPTION');
      await expectCode(structure.setOptionArchived(tx, x.actor, exploited.id, exploited.version, true), 'SYSTEM_OPTION');
      const fixed = must(x.vf.status.options.find((o) => o.systemKey === 'fixed'));
      await expectCode(structure.updateOption(tx, x.actor, fixed.id, { version: fixed.version, isClosed: false }), 'SYSTEM_OPTION');
      await expectCode(structure.setRegisterArchived(tx, x.actor, x.reg.id, x.reg.version, true), 'SYSTEM_REGISTER');
      // Разрешено: переименование поля и значения, своё поле.
      let reg = await structure.updateField(tx, x.actor, cvss.id, { version: cvss.version, label: 'CVSS v3' });
      expect(reg.fields.find((f) => f.id === cvss.id)?.label).toBe('CVSS v3');
      reg = await structure.updateOption(tx, x.actor, exploited.id, { version: exploited.version, label: 'Эксплуатируется в атаках' });
      reg = await structure.addField(tx, x.actor, x.reg.id, { label: 'Хост', type: 'text' });
      const own = must(reg.fields.find((f) => f.label === 'Хост'));
      expect(own.systemKey).toBeNull();
      await structure.deleteField(tx, x.actor, own.id, own.version);
    }));
});

describe('импорт отчёта сканера по образцу', () => {
  it('предпросмотр ничего не меняет: 90 новых, 12 хостов, отдел, дата из имени файла, БДУ без CVSS — «Высокая»', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const p = await scan.previewScan(tx, x.actor, x.reg.id, SAMPLE, SAMPLE_NAME);
      const s = p.summary;
      expect([s.rows, s.created, s.merged, s.errorRows, s.inFileDuplicates]).toEqual([90, 90, 0, 0, 0]);
      expect([s.hostsCount, s.department, s.reportDate, s.sheet]).toEqual([12, 'Отдел платёжных карт', '2026-10-15', 'Уязвимости']);
      expect(s.hosts[0]).toEqual({ name: 'HOST-01', ip: '10.0.0.11', os: 'Windows 11' });
      expect(s.critCounts.reduce((n, c) => n + c.count, 0)).toBe(90);
      expect(s.items.find((i) => i.cve === 'BDU:2025-01793')).toMatchObject({ cvss: null, score: null, crit: 'Высокая' });
      // 9,8 × 1,00 × 0,95 = 9,31 → 9,4 — критическая.
      expect(s.items.find((i) => i.cve === 'CVE-2024-21413')).toMatchObject({ cvss: 9.8, score: 9.4, crit: 'Критическая' });
      expect(s.newOptions.find((o) => o.field === 'Пакет')?.values).toContain('RARLAB WinRAR');
      expect(await tx.registerRecord.count({ where: { registerId: x.reg.id } })).toBe(0);
      expect(await tx.scanReport.count()).toBe(0);
      expect((await lastAudit(tx)).action).toBe('register.scan.previewed');
    }));

  it('применение одной транзакцией: записи, оценка, критичность, срок от передачи в ДИКТ, отчёт с хостами', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const { applied } = await importSample(tx, x);
      expect(applied).toMatchObject({ created: 90, merged: 0, updated: 0, skipped: 0, label: 'Отдел платёжных карт · 15.10.2026' });
      await x.reload();
      expect(await tx.registerRecord.count({ where: { registerId: x.reg.id } })).toBe(90);
      const outlook = await byCve(tx, x, 'CVE-2024-21413');
      expect(outlook.calc[x.vf.score.id]).toBe(9.4);
      expect(outlook.display[x.vf.crit.id]).toBe('Критическая');
      expect(outlook.display[x.vf.status.id]).toBe('Открыта');
      expect(outlook.display[x.vf.fix.id]).toBe('Выпущено');
      expect(outlook.values[x.vf.notified.id]).toBe('2026-10-15');
      expect(outlook.calc[x.vf.due.id]).toBe('2026-10-29'); // + 14 дней, четверг
      expect(outlook.display[x.vf.report.id]).toBe('Отдел платёжных карт · 15.10.2026');
      expect(outlook.manualFieldIds).toEqual([]);
      const bdu = await byCve(tx, x, 'BDU:2025-01793');
      expect([bdu.calc[x.vf.score.id], bdu.display[x.vf.crit.id], bdu.values[x.vf.vector.id]]).toEqual([null, 'Высокая', undefined]);
      const report = await tx.scanReport.findUniqueOrThrow({ where: { id: applied.reportId }, include: { hosts: true } });
      expect([report.hostsCount, report.hosts.length, report.createdCount, report.department]).toEqual([12, 12, 90, 'Отдел платёжных карт']);
      expect((await lastAudit(tx)).action).toBe('register.scan.applied');
      const list = await scan.listScanReports(tx, x.reg.id, { includeArchived: false });
      expect(list[0]).toMatchObject({ label: applied.label, hostsCount: 12, reportDate: '2026-10-15', notifiedDate: '2026-10-15' });
    }));

  it('повторная загрузка того же отчёта: все строки — дубли, записи не создаются, отчёт получает номер', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      await importSample(tx, x);
      await x.reload();
      const { preview, applied } = await importSample(tx, x);
      expect([preview.summary.created, preview.summary.merged, preview.summary.mergedChanged]).toEqual([0, 90, 0]);
      expect([applied.created, applied.merged, applied.updated]).toEqual([0, 90, 0]);
      expect(applied.label).toBe('Отдел платёжных карт · 15.10.2026 (2)');
      expect(await tx.registerRecord.count({ where: { registerId: x.reg.id } })).toBe(90);
    }));

  it('дубли «CVE + пакет + отдел»: повторный отчёт — «Обнаружений» из нового отчёта, внутри файла — максимум; закрытая запись дублем не считается', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      await importSample(tx, x);
      await x.reload();
      const winrar = await byCve(tx, x, 'CVE-2025-6218'); // «Обнаружений» 11
      const zip = await byCve(tx, x, 'CVE-2025-0411'); // 14
      // 7-Zip закрыт: та же пара в новом отчёте — новая запись.
      await records.updateRecord(tx, x.actor, zip.id, { version: zip.version, values: { [x.vf.status.id]: x.opt('status', 'fixed') } });

      const wb = await sampleBook();
      const { ws, col, rowOf } = sheet(wb);
      rowOf('CVE-2025-6218').getCell(col('Обнаружений')).value = 20;
      rowOf('CVE-2023-40477').getCell(col('Обнаружений')).value = 3; // было 11 — повторный отчёт того же отдела: 3 (релиз 1.1.0)
      rowOf('CVE-2023-44487').getCell(col('Обнаружений')).value = null; // пусто — прежнее значение
      // Та же пара в файле дважды (регистр и пробелы не важны) — берётся максимум.
      ws.addRow(['rarlab  winrar', 'cve-2025-6218', 'Важная', 7.8, 'Есть, эксплуатируется', 'Локально', '7.12', 'дубль', 25]);
      ws.addRow(['Пакет без CVE', null, 'Важная', 5, 'Нет', 'Локально', '1.0', 'ошибка', 1]);
      const { preview, applied } = await importSample(tx, x, await toBuffer(wb), 'повтор 2026-10-22.xlsx');
      const s = preview.summary;
      expect([s.created, s.merged, s.mergedChanged, s.inFileDuplicates, s.errorRows]).toEqual([1, 89, 2, 1, 1]);
      expect(s.duplicates.find((d) => d.cve === 'CVE-2025-6218')).toMatchObject({ number: winrar.number, hitsBefore: 11, hitsAfter: 25 });
      expect(s.duplicates.find((d) => d.cve === 'CVE-2023-40477')).toMatchObject({ hitsBefore: 11, hitsAfter: 3 });
      const h44487 = s.duplicates.find((d) => d.cve === 'CVE-2023-44487');
      expect(h44487?.hitsAfter).toBe(h44487?.hitsBefore);
      expect(s.items.map((i) => i.cve)).toEqual(['CVE-2025-0411']);
      expect(s.errors[0]).toMatchObject({ field: 'CVE', message: expect.stringContaining('CVE или БДУ') });
      expect([applied.created, applied.updated]).toEqual([1, 2]);
      const after = await byCve(tx, x, 'CVE-2025-6218');
      expect([after.values[x.vf.hits.id], after.version]).toEqual([25, winrar.version + 1]);
      const history = await records.recordHistory(tx, winrar.id);
      expect(history[0]).toMatchObject({ via: 'scan_import', changes: [{ label: 'Обнаружений', from: '11', to: '25' }] });
      const zips = (await recordsOf(tx, x)).filter((r) => r.values[x.vf.cve.id] === 'CVE-2025-0411');
      expect(zips).toHaveLength(2);
      expect(zips[1]?.values[x.vf.notified.id]).toBe('2026-10-22');
    }));

  it('отдел из A1: в записи; отчёт другого отдела не сливается и не меняет «Обнаружений»; «ё» = «е», хранится как в отчёте', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      await importSample(tx, x);
      await x.reload();
      const a = await byCve(tx, x, 'CVE-2025-6218');
      const deptA = must(x.vf.department.options.find((o) => o.id === a.values[x.vf.department.id]));
      expect(deptA.label).toBe('Отдел платёжных карт');

      // Тот же отдел, написанный иначе (регистр, пробелы, «е» вместо «ё»), — тот же отдел: всё — дубли.
      const same = await sampleBook();
      must(same.getWorksheet('Хосты')).getCell('A1').value = '  отдел   ПЛАТЕЖНЫХ карт ';
      const p1 = await scan.previewScan(tx, x.actor, x.reg.id, await toBuffer(same), 'повтор 2026-10-22.xlsx');
      expect([p1.summary.created, p1.summary.merged]).toEqual([0, 90]);

      // Другой отдел: ни одного дубля, «Обнаружений» отдела А не меняется.
      const other = await sampleBook();
      must(other.getWorksheet('Хосты')).getCell('A1').value = 'Отдел кредитования';
      sheet(other).rowOf('CVE-2025-6218').getCell(sheet(other).col('Обнаружений')).value = 1;
      const { preview, applied } = await importSample(tx, x, await toBuffer(other), 'кредиты 2026-10-22.xlsx');
      expect([preview.summary.created, preview.summary.merged]).toEqual([90, 0]);
      expect(applied.created).toBe(90);
      expect((await records.getRecord(tx, a.id)).values[x.vf.hits.id]).toBe(a.values[x.vf.hits.id]);
      await x.reload();
      expect(x.vf.department.options.map((o) => o.label)).toEqual(['Отдел платёжных карт', 'Отдел кредитования']);
    }));

  it('отчёт без отдела в A1: без выбора отдела не загружается; с выбранным отделом повторная загрузка дублей не создаёт', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      await importSample(tx, x);
      const noDept = await sampleBook();
      must(noDept.getWorksheet('Хосты')).getCell('A1').value = null;
      const buffer = await toBuffer(noDept);

      const bare = await scan.previewScan(tx, x.actor, x.reg.id, buffer, 'без отдела 2026-11-15.xlsx');
      expect([bare.summary.department, bare.summary.departmentMissing]).toEqual(['', true]);
      await expectCode(scan.applyScan(tx, x.actor, bare.id, {}), 'DEPARTMENT_REQUIRED');

      // Выбран известный отдел (регистр и «е» не важны) — все строки отчёта совпадают с записями этого отдела.
      for (const round of [1, 2]) {
        const p = await scan.previewScan(tx, x.actor, x.reg.id, buffer, `без отдела 2026-11-1${round}.xlsx`, 'отдел платежных карт');
        expect([p.summary.departmentMissing, p.summary.created, p.summary.merged]).toEqual([false, 0, 90]);
        expect(p.summary.warnings.join(' ')).toContain('В отчёте не указан отдел');
        await scan.applyScan(tx, x.actor, p.id, {});
      }
      expect(await tx.registerRecord.count({ where: { registerId: x.reg.id, deletedAt: null } })).toBe(90);
      // Отдел из A1 важнее выбранного в окне.
      const withA1 = await scan.previewScan(tx, x.actor, x.reg.id, SAMPLE, SAMPLE_NAME, 'Другой отдел');
      expect(withA1.summary.department).toBe('Отдел платёжных карт');
    }));

  it('изменения после предпросмотра: дубль правили или пару завели вручную — не применяется ничего', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      await importSample(tx, x);
      await x.reload();
      const p = await scan.previewScan(tx, x.actor, x.reg.id, SAMPLE, SAMPLE_NAME);
      const one = await byCve(tx, x, 'CVE-2023-44487');
      await records.updateRecord(tx, x.actor, one.id, { version: one.version, values: { [x.vf.comment.id]: 'В работе у ДИКТ' } });
      await expectCode(scan.applyScan(tx, x.actor, p.id, {}), 'IMPORT_STALE');
      expect(await tx.scanReport.count()).toBe(1);

      // Новая пара, которую завели руками, пока смотрели предпросмотр.
      const wb = await sampleBook();
      sheet(wb).ws.addRow(['Новый пакет', 'CVE-2026-99999', 'Важная', 6.5, 'Нет', 'Локально', '2.0', 'новая', 1]);
      const p2 = await scan.previewScan(tx, x.actor, x.reg.id, await toBuffer(wb), SAMPLE_NAME);
      expect(p2.summary.created).toBe(1);
      const pkg = must((await structure.addOption(tx, x.actor, x.vf.pkg.id, { label: 'Новый пакет' })).fields.find((f) => f.id === x.vf.pkg.id));
      const pkgId = must(pkg.options.find((o) => o.label === 'Новый пакет')).id;
      // Запись без отдела в дублях отчётов не участвует (этап Б.2) — она не мешает.
      const manual = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.vf.cve.id]: 'CVE-2026-99999', [x.vf.pkg.id]: pkgId } });
      // С отделом отчёта — уже дубль: применение не проходит.
      await x.reload();
      const dept = must(x.vf.department.options[0]).id;
      await records.updateRecord(tx, x.actor, manual.id, { version: manual.version, values: { [x.vf.department.id]: dept } });
      await expectCode(scan.applyScan(tx, x.actor, p2.id, {}), 'IMPORT_STALE');
      expect(await tx.registerRecord.count({ where: { registerId: x.reg.id } })).toBe(91);
    }));

  it('нет даты в имени файла — вводится при применении; передача в ДИКТ не раньше отчёта', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const p = await scan.previewScan(tx, x.actor, x.reg.id, SAMPLE, 'отчёт сканера.xlsx');
      expect(p.summary.reportDate).toBeNull();
      expect(p.summary.warnings.join(' ')).toContain('укажите её перед применением');
      await expectCode(scan.applyScan(tx, x.actor, p.id, {}), 'REPORT_DATE_REQUIRED');
      await expectCode(scan.applyScan(tx, x.actor, p.id, { reportDate: '2026-10-20', notifiedDate: '2026-10-19' }), 'BAD_DATE');
      const r = await scan.applyScan(tx, x.actor, p.id, { reportDate: '2026-10-20', notifiedDate: '2026-10-21' });
      expect(r.label).toBe('Отдел платёжных карт · 20.10.2026');
      await x.reload();
      expect((await byCve(tx, x, 'CVE-2024-21413')).values[x.vf.notified.id]).toBe('2026-10-21');
    }));

  it('не тот реестр и не тот файл', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const other = await makeRegister(tx);
      await expectCode(scan.previewScan(tx, x.actor, other.reg.id, SAMPLE, SAMPLE_NAME), 'NOT_VULN_REGISTER');
      const plain = await excel.exportRegister(tx, other.reg.id);
      await expectCode(scan.previewScan(tx, x.actor, x.reg.id, plain.buffer, 'реестр.xlsx'), 'NOT_SCAN_REPORT');
      // Отчёт сканера не применяется маршрутом обычного импорта и наоборот.
      const p = await scan.previewScan(tx, x.actor, x.reg.id, SAMPLE, SAMPLE_NAME);
      await expectCode(excel.applyImport(tx, x.actor, p.id), 'NOT_FOUND');
    }));
});

describe('критичность: ручная правка не перетирается пересчётом', () => {
  it('форма, обычный импорт Excel, «Считать автоматически», очистка поля', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const v = (crit: string) => x.opt('crit', crit);
      const created = await records.createRecord(tx, x.actor, x.reg.id, {
        values: { [x.vf.cve.id]: 'CVE-2026-0101', [x.vf.cvss.id]: 7.5, [x.vf.exploit.id]: x.opt('exploit', 'exploited'), [x.vf.fix.id]: x.opt('fix', 'not_released') },
      });
      expect(created.values[x.vf.crit.id]).toBe(v('high'));
      expect(created.calc[x.vf.score.id]).toBe(7.5);

      // CVSS вырос — критичность пересчиталась.
      let r = await records.updateRecord(tx, x.actor, created.id, { version: created.version, values: { [x.vf.cvss.id]: 9.1 } });
      expect(r.values[x.vf.crit.id]).toBe(v('critical'));
      expect((await records.recordHistory(tx, r.id))[0]?.changes.map((c) => c.label)).toEqual(['CVSS', 'Критичность']);

      // Сотрудник ИБ понизил вручную (система недоступна из интернета) — пересчёт её не трогает.
      r = await records.updateRecord(tx, x.actor, r.id, { version: r.version, values: { [x.vf.crit.id]: v('medium') } });
      expect(r.manualFieldIds).toEqual([x.vf.crit.id]);
      r = await records.updateRecord(tx, x.actor, r.id, { version: r.version, values: { [x.vf.cvss.id]: 9.8 } });
      expect(r.values[x.vf.crit.id]).toBe(v('medium'));

      // Обычный импорт Excel меняет CVSS — ручная критичность остаётся.
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await excel.exportRegister(tx, x.reg.id)).buffer as unknown as ExcelJS.Buffer);
      const ws = wb.getWorksheet('Реестр') as ExcelJS.Worksheet;
      let cvssCol = 0;
      ws.getRow(1).eachCell((c, n) => {
        if (c.value === 'CVSS') cvssCol = n;
      });
      ws.getRow(2).getCell(cvssCol).value = 3.1;
      const p = await excel.previewImport(tx, x.actor, x.reg.id, Buffer.from(await wb.xlsx.writeBuffer()), 'дикт.xlsx');
      expect(p.summary.updated).toBe(1);
      await excel.applyImport(tx, x.actor, p.id);
      r = await records.getRecord(tx, r.id);
      expect([r.values[x.vf.cvss.id], r.values[x.vf.crit.id]]).toEqual([3.1, v('medium')]);

      // «Считать автоматически» — по Оценке 3,1 × 1 × 1 = 3,1 → низкая.
      r = await records.resetToAuto(tx, x.actor, r.id, x.vf.crit.id, r.version);
      expect([r.values[x.vf.crit.id], r.manualFieldIds]).toEqual([v('low'), []]);
      await expectCode(records.resetToAuto(tx, x.actor, r.id, x.vf.cvss.id, r.version), 'NOT_DERIVED');

      // Очистить критичность в форме — тоже вернуть расчёт.
      r = await records.updateRecord(tx, x.actor, r.id, { version: r.version, values: { [x.vf.crit.id]: v('critical') } });
      r = await records.updateRecord(tx, x.actor, r.id, { version: r.version, values: { [x.vf.crit.id]: null } });
      expect([r.values[x.vf.crit.id], r.manualFieldIds]).toEqual([v('low'), []]);
    }));

  it('нет CVSS — «Высокая»; эксплойт и исправление меняют Оценку', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      let r = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.vf.cve.id]: 'BDU:2026-00001' } });
      expect([r.calc[x.vf.score.id], r.values[x.vf.crit.id]]).toEqual([null, x.opt('crit', 'high')]);
      r = await records.updateRecord(tx, x.actor, r.id, { version: r.version, values: { [x.vf.cvss.id]: 9.8, [x.vf.exploit.id]: x.opt('exploit', 'none') } });
      expect([r.calc[x.vf.score.id], r.values[x.vf.crit.id]]).toEqual([9, x.opt('crit', 'critical')]); // 8,918 → 9,0
      r = await records.updateRecord(tx, x.actor, r.id, { version: r.version, values: { [x.vf.fix.id]: x.opt('fix', 'released') } });
      expect([r.calc[x.vf.score.id], r.values[x.vf.crit.id]]).toEqual([8.5, x.opt('crit', 'high')]); // 8,4721 → 8,5
    }));
});

describe('контроль сроков в таблице', () => {
  it('дней до срока, просрочено / ≤ 7 / в срок / закрыто; сортировка «срочное сначала»; п. 7.3 — срок ИБ', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const today = todayIso();
      // «Уведомлено ДИКТ» с 1.5.0 ставит передача ИКТ (служебное поле) — записи создаются напрямую, как её результат.
      const mk = async (cve: string, notified: string, crit: string, extra: Values = {}) => {
        const values: Values = { [x.vf.cve.id]: cve, [x.vf.status.id]: x.opt('status', 'open'), [x.vf.crit.id]: x.opt('crit', crit), ...extra };
        if (notified) values[x.vf.notified.id] = notified;
        const number = await records.nextNumbers(tx, x.reg.id, 1);
        return tx.registerRecord.create({ data: { registerId: x.reg.id, number, values: values as Prisma.InputJsonValue } });
      };
      await mk('OK', today, 'low'); // + 180
      await mk('OVER', addDays(today, -200), 'low');
      await mk('CLOSED', addDays(today, -200), 'low', { [x.vf.status.id]: x.opt('status', 'fixed') });
      // Решение ИБ (п. 7.3): срок — явная дата через 3 дня, только при заполненных мерах.
      await mk('IB', addDays(today, -200), 'low', { [x.vf.measures.id]: 'Изоляция сегмента', [x.vf.newDue.id]: addDays(today, 3) });
      await mk('NODATE', '', 'low'); // пустая дата — поле не заполнено, срока нет
      const page = await records.listRecords(tx, x.reg.id, { limit: 10, sort: 'deadline' });
      const rows = page.items.map((r) => [r.values[x.vf.cve.id], r.deadline?.state]);
      expect(rows).toEqual([['OVER', 'overdue'], ['IB', 'soon'], ['OK', 'ok'], ['CLOSED', 'closed'], ['NODATE', 'none']]);
      const ib = must(page.items.find((r) => r.values[x.vf.cve.id] === 'IB'));
      expect(ib.deadline).toEqual({ date: addDays(today, 3), daysLeft: 3, state: 'soon' });
      const over = must(page.items[0]);
      expect(must(over.deadline).daysLeft).toBeLessThan(0);
      // Колонка «Дней до срока» в выгрузке; при импорте она пропускается молча.
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await excel.exportRegister(tx, x.reg.id)).buffer as unknown as ExcelJS.Buffer);
      const header = (wb.getWorksheet('Реестр') as ExcelJS.Worksheet).getRow(1).values as unknown[];
      expect(header).toContain('Дней до срока');
      const p = await excel.previewImport(tx, x.actor, x.reg.id, Buffer.from(await wb.xlsx.writeBuffer()), 'обратно.xlsx');
      expect([p.summary.updated, p.summary.errorRows, p.summary.warnings]).toEqual([0, 0, []]);
    }));
});
