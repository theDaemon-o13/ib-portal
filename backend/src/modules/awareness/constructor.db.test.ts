// Доработки конструктора на реестрах «Осведомлённости» (релиз 1.8.0, docs/specs/awareness.md, 2.1–2.2, 3, 7.2, 7.4):
// производные значения, служебные поля, выбор связи в предпросмотре и при применении, предупреждения импорта.
// Люди и подразделения вымышленные. Каждый тест — в транзакции с откатом.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { Values } from '../../lib/register-values.js';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { loadRegister, type RegisterDef } from '../registers/definition.js';
import * as excel from '../registers/excel.service.js';
import * as records from '../registers/records.service.js';
import { AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY } from './definition.js';

async function setup(tx: Tx) {
  const user = await makeUser(tx, ['ib_staff']);
  const actor = await actorFor(tx, user.id);
  const emp = await loadRegister(tx, must(await tx.register.findUnique({ where: { systemKey: AWARENESS_EMPLOYEES_KEY } })).id);
  const res = await loadRegister(tx, must(await tx.register.findUnique({ where: { systemKey: AWARENESS_RESULTS_KEY } })).id);
  const F = (reg: RegisterDef, k: string) => must(reg.fields.find((f) => f.systemKey === k), k);
  const O = (reg: RegisterDef, k: string, key: string) => must(F(reg, k).options.find((o) => o.systemKey === key), `${k}.${key}`).id;
  const employee = async (values: Record<string, unknown>) => records.createRecord(tx, actor, emp.id, { values });
  return { actor, emp, res, F, O, employee };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Результат — запись отчёта: в тестах кладётся напрямую (форма служебные поля не принимает). */
async function result(tx: Tx, s: Setup, values: Values) {
  const number = await records.nextNumbers(tx, s.res.id, 1);
  return tx.registerRecord.create({ data: { registerId: s.res.id, number, values } });
}

describe('«Сотрудники»: производные значения', () => {
  it('ФИО делится на части, новая запись без статуса — «Работает»', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const rec = await s.employee({ [s.F(s.emp, 'tabNo').id]: '1001', [s.F(s.emp, 'fullName').id]: '  Иванов Иван Иванович ' });
      const v = rec.values;
      expect([v[s.F(s.emp, 'lastName').id], v[s.F(s.emp, 'firstName').id], v[s.F(s.emp, 'middleName').id]]).toEqual(['Иванов', 'Иван', 'Иванович']);
      expect(v[s.F(s.emp, 'status').id]).toBe(s.O(s.emp, 'status', 'working'));
    }));

  it('ФИО пустое, части заполнены — ФИО собирается; заполненные вручную части не перетираются; неделимое не делится', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const a = await s.employee({ [s.F(s.emp, 'lastName').id]: 'Петров', [s.F(s.emp, 'firstName').id]: 'Пётр', [s.F(s.emp, 'middleName').id]: 'Петрович' });
      expect(a.values[s.F(s.emp, 'fullName').id]).toBe('Петров Пётр Петрович');
      const b = await s.employee({ [s.F(s.emp, 'fullName').id]: 'Сидоров Сергей Сергеевич', [s.F(s.emp, 'lastName').id]: 'Сидоров-Тестов' });
      expect(b.values[s.F(s.emp, 'lastName').id]).toBe('Сидоров-Тестов');
      expect(b.values[s.F(s.emp, 'firstName').id]).toBeUndefined();
      const c = await s.employee({ [s.F(s.emp, 'fullName').id]: 'Ван Дер Тест Иван' });
      expect(c.values[s.F(s.emp, 'lastName').id]).toBeUndefined();
      // Статус из формы — как выбрали.
      const d = await s.employee({ [s.F(s.emp, 'fullName').id]: 'Кузнецов К К', [s.F(s.emp, 'status').id]: s.O(s.emp, 'status', 'fired') });
      expect(d.values[s.F(s.emp, 'status').id]).toBe(s.O(s.emp, 'status', 'fired'));
    }));
});

describe('«Результаты INDIGO»: служебные поля и «Сотрудник» в карточке', () => {
  it('служебное поле вручную — 409 AWARENESS_SERVICE_FIELD; «Сотрудник» — «Вручную», очистили — «Не сопоставлен»', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const emp = await s.employee({ [s.F(s.emp, 'fullName').id]: 'Иванов Иван Иванович', [s.F(s.emp, 'dept').id]: 'Отдел тестирования' });
      const r = await result(tx, s, {
        [s.F(s.res, 'attemptKey').id]: 'т | иванов иван иванович | 2026-10-01', [s.F(s.res, 'fullName').id]: 'Иванов Иван Иванович',
        [s.F(s.res, 'percent').id]: 70, [s.F(s.res, 'dept').id]: 'Группа А', [s.F(s.res, 'match').id]: s.O(s.res, 'match', 'none'),
      });
      await expectCode(records.updateRecord(tx, s.actor, r.id, { version: r.version, values: { [s.F(s.res, 'percent').id]: 99 } }), 'AWARENESS_SERVICE_FIELD');
      const linked = await records.updateRecord(tx, s.actor, r.id, { version: r.version, values: { [s.F(s.res, 'employee').id]: [emp.id] } });
      expect(linked.values[s.F(s.res, 'match').id]).toBe(s.O(s.res, 'match', 'manual'));
      // Подразделение при правке в карточке не меняется (раздел 3).
      expect(linked.values[s.F(s.res, 'dept').id]).toBe('Группа А');
      const cleared = await records.updateRecord(tx, s.actor, r.id, { version: linked.version, values: { [s.F(s.res, 'employee').id]: null } });
      expect(cleared.values[s.F(s.res, 'match').id]).toBe(s.O(s.res, 'match', 'none'));
    }));
});

/** Лист адаптера по названиям полей «Результатов» и сам адаптер с блоком выбора по строкам 2 и 3. */
async function adapterFor(s: Setup, rows: Record<string, string | number>[], choiceRows = [2, 3]): Promise<excel.ImportAdapter> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Импорт');
  const labels = ['Ключ попытки', 'ФИО', 'Подразделение', 'Результат, %', 'Сопоставление'];
  ws.addRow(labels);
  for (const r of rows) ws.addRow(labels.map((l) => r[l] ?? null));
  const managed = s.res.fields.filter((f) => f.managed).map((f) => f.id);
  return {
    wb, ws, managedWritable: managed, createOnly: [], missing: false, newOptions: [], newRecords: [], linkTokens: {}, source: { adapter: 'test' }, warnings: [], blocks: [],
    choices: {
      code: 'manual', title: 'Требуют ручного сопоставления', hint: null,
      fieldId: s.F(s.res, 'employee').id, registerId: s.emp.id,
      scope: { fieldId: s.F(s.emp, 'status').id, optionId: s.O(s.emp, 'status', 'working') },
      rows: choiceRows.map((row) => ({ row, title: `строка ${row}`, detail: '', reason: 'не найден', candidates: [] })),
      set: { [s.F(s.res, 'match').id]: s.O(s.res, 'match', 'manual') },
      copy: { [s.F(s.res, 'dept').id]: s.F(s.emp, 'dept').id },
    },
  };
}

const row = (key: string, fio: string, group: string) => ({ 'Ключ попытки': key, 'ФИО': fio, 'Подразделение': group, 'Результат, %': 70, 'Сопоставление': 'Не сопоставлен' });

describe('выбор связи в предпросмотре импорта (7.2)', () => {
  it('выбранная строка — связь, «Вручную», подразделение из сотрудника; невыбранная — как в файле; итог в сводке', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const ivanov = await s.employee({ [s.F(s.emp, 'fullName').id]: 'Иванов Иван Иванович', [s.F(s.emp, 'dept').id]: 'Отдел тестирования' });
      const pre = await excel.previewImport(tx, s.actor, s.res.id, Buffer.alloc(0), 'отчёт.xlsx', await adapterFor(s, [row('k1', 'Иванов Иван', 'Группа А'), row('k2', 'Петров Пётр', 'Группа Б')]));
      expect(pre.summary.errors).toEqual([]);
      expect(pre.summary.choices?.rows.map((r) => r.row)).toEqual([2, 3]);
      await excel.applyImport(tx, s.actor, pre.id, { choices: { 2: ivanov.id, 3: null } });
      const recs = await tx.registerRecord.findMany({ where: { registerId: s.res.id, deletedAt: null }, orderBy: { number: 'asc' } });
      const [a, b] = recs.map((r) => r.values as Values);
      expect(a?.[s.F(s.res, 'employee').id]).toEqual([ivanov.id]);
      expect(a?.[s.F(s.res, 'match').id]).toBe(s.O(s.res, 'match', 'manual'));
      expect(a?.[s.F(s.res, 'dept').id]).toBe('Отдел тестирования');
      expect(b?.[s.F(s.res, 'employee').id]).toBeUndefined();
      expect(b?.[s.F(s.res, 'match').id]).toBe(s.O(s.res, 'match', 'none'));
      expect(b?.[s.F(s.res, 'dept').id]).toBe('Группа Б');
      const imp = await tx.registerImport.findUniqueOrThrow({ where: { id: pre.id } });
      expect((imp.summary as { choicesApplied?: unknown }).choicesApplied).toEqual({ chosen: 1, left: 1 });
    }));

  it('у сотрудника пустое подразделение — остаётся из файла', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const e = await s.employee({ [s.F(s.emp, 'fullName').id]: 'Иванов Иван Иванович' });
      const pre = await excel.previewImport(tx, s.actor, s.res.id, Buffer.alloc(0), 'отчёт.xlsx', await adapterFor(s, [row('k1', 'Иванов Иван', 'Группа А')], [2]));
      await excel.applyImport(tx, s.actor, pre.id, { choices: { 2: e.id } });
      const [rec] = await tx.registerRecord.findMany({ where: { registerId: s.res.id, deletedAt: null } });
      expect((rec?.values as Values)[s.F(s.res, 'dept').id]).toBe('Группа А');
    }));

  it('без choices — как раньше; строка не из блока — 400; уволенный после предпросмотра — IMPORT_STALE, ничего не создано', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const e = await s.employee({ [s.F(s.emp, 'fullName').id]: 'Иванов Иван Иванович' });
      const file = [row('k1', 'Иванов Иван', 'Группа А'), row('k2', 'Петров Пётр', 'Группа Б')];
      const plain = await excel.previewImport(tx, s.actor, s.res.id, Buffer.alloc(0), 'отчёт.xlsx', await adapterFor(s, file));
      await expectCode(excel.applyImport(tx, s.actor, plain.id, { choices: { 7: e.id } }), 'BAD_CHOICES');
      await expectCode(excel.applyImport(tx, s.actor, plain.id, { choices: { 2: s.res.id } }), 'BAD_CHOICES');
      // Сотрудника уволили между предпросмотром и применением.
      const cur = await tx.registerRecord.findUniqueOrThrow({ where: { id: e.id } });
      await records.updateRecord(tx, s.actor, e.id, { version: cur.version, values: { [s.F(s.emp, 'status').id]: s.O(s.emp, 'status', 'fired') } });
      await expectCode(excel.applyImport(tx, s.actor, plain.id, { choices: { 2: e.id } }), 'IMPORT_STALE');
      expect(await tx.registerRecord.count({ where: { registerId: s.res.id, deletedAt: null } })).toBe(0);
      const res = await excel.applyImport(tx, s.actor, plain.id);
      expect(res.added).toBe(2);
    }));

  it('строка с ошибкой или найденная запись в блок выбора не попадает', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await result(tx, s, { [s.F(s.res, 'attemptKey').id]: 'k2', [s.F(s.res, 'fullName').id]: 'Петров Пётр' });
      const pre = await excel.previewImport(tx, s.actor, s.res.id, Buffer.alloc(0), 'отчёт.xlsx', await adapterFor(s, [row('', 'Без ключа', 'А'), row('k2', 'Петров Пётр', 'Б')]));
      expect(pre.summary.choices).toBeUndefined();
    }));
});

describe('предупреждения импорта «Сотрудников» (2.1, 2.2)', () => {
  async function hrFile(rows: (string | null)[][], header: string[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('HR');
    ws.addRow(header);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('неразделённые ФИО и уволенные в файле без колонки «Статус» — предупреждения; статус не меняется', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.employee({ [s.F(s.emp, 'tabNo').id]: 'T-1', [s.F(s.emp, 'fullName').id]: 'Иванов Иван Иванович', [s.F(s.emp, 'status').id]: s.O(s.emp, 'status', 'fired') });
      const buf = await hrFile([['T-1', 'Иванов Иван Иванович', 'Отдел тестирования'], ['T-2', 'Ван Дер Тест Иван', 'Отдел проверки']], ['Табельный номер', 'ФИО', 'Подразделение']);
      const pre = await excel.previewImport(tx, s.actor, s.emp.id, buf, 'hr.xlsx');
      expect(pre.summary.errors).toEqual([]);
      expect(pre.summary.warnings.some((w) => w.startsWith('ФИО не разделено на фамилию, имя и отчество: 1 строк') && w.includes('«Ван Дер Тест Иван»'))).toBe(true);
      expect(pre.summary.warnings.some((w) => w.startsWith('В файле есть уволенные: 1') && w.includes('Иванов Иван Иванович (T-1)'))).toBe(true);
      await excel.applyImport(tx, s.actor, pre.id);
      const fired = must(await tx.registerRecord.findFirst({ where: { registerId: s.emp.id, importKey: 't-1' } }));
      expect((fired.values as Values)[s.F(s.emp, 'status').id]).toBe(s.O(s.emp, 'status', 'fired'));
      // Новая запись из файла — «Работает», ФИО разделено там, где делится.
      const fresh = must(await tx.registerRecord.findFirst({ where: { registerId: s.emp.id, importKey: 't-2' } }));
      expect((fresh.values as Values)[s.F(s.emp, 'status').id]).toBe(s.O(s.emp, 'status', 'working'));
    }));

  it('колонка «Статус» в файле — без предупреждения, статус из файла', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.employee({ [s.F(s.emp, 'tabNo').id]: 'T-1', [s.F(s.emp, 'fullName').id]: 'Иванов Иван Иванович', [s.F(s.emp, 'status').id]: s.O(s.emp, 'status', 'fired') });
      const buf = await hrFile([['T-1', 'Иванов Иван Иванович', 'Работает']], ['Табельный номер', 'ФИО', 'Статус']);
      const pre = await excel.previewImport(tx, s.actor, s.emp.id, buf, 'hr.xlsx');
      expect(pre.summary.warnings.some((w) => w.startsWith('В файле есть уволенные'))).toBe(false);
      expect(pre.summary.updated).toBe(1);
    }));

  it('новая строка только с фамилией и именем — ФИО собирается, ошибки «заполните ФИО» нет', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const buf = await hrFile([['T-9', 'Петров', 'Пётр', 'Петрович']], ['Табельный номер', 'Фамилия', 'Имя', 'Отчество']);
      const pre = await excel.previewImport(tx, s.actor, s.emp.id, buf, 'hr.xlsx');
      expect(pre.summary.errors).toEqual([]);
      await excel.applyImport(tx, s.actor, pre.id);
      const rec = must(await tx.registerRecord.findFirst({ where: { registerId: s.emp.id, importKey: 't-9' } }));
      expect((rec.values as Values)[s.F(s.emp, 'fullName').id]).toBe('Петров Пётр Петрович');
    }));
});
