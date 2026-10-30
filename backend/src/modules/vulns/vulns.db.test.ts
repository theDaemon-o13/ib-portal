import ExcelJS from 'exceljs';
import type { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { addDays, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { expectCode, inTx, must } from '../../test/db.js';
import { vulnRegister } from '../../test/vulns-fixture.js';
import * as excel from '../registers/excel.service.js';
import * as records from '../registers/records.service.js';
import * as structure from '../registers/structure.service.js';

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
