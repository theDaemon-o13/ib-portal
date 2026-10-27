// Ключ импорта (этап 8): уникальность в БД, импорт без колонки ID по ключу, «нет в файле».
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { expectCode, inTx, must, type Tx } from '../../test/db.js';
import { makeRegister, type Fixture } from '../../test/registers-fixture.js';
import { importKeyField } from './definition.js';
import * as excel from './excel.service.js';
import * as records from './records.service.js';
import * as structure from './structure.service.js';

/** Реестр с текстовым полем «Имя хоста», назначенным ключом импорта. */
async function withHostKey(tx: Tx) {
  const x = await makeRegister(tx);
  let reg = await structure.addField(tx, x.actor, x.reg.id, { label: 'Имя хоста', type: 'text' });
  const host = must(reg.fields.find((f) => f.label === 'Имя хоста')).id;
  reg = await structure.updateField(tx, x.actor, host, { version: must(reg.fields.find((f) => f.id === host)).version, isImportKey: true });
  await x.reload();
  return { x, host };
}

const create = (tx: Tx, x: Fixture, host: string, title: string, hostName: string, extra: Record<string, unknown> = {}) =>
  records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: title, [host]: hostName, ...extra } });

/** Книга «как из Device Monitor»: без ID и служебного листа, колонки по названиям полей. */
async function dmFile(rows: (string | number | null)[][], headers = ['Имя хоста', 'Наименование', 'Баллы']) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Устройства');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('ключ импорта: настройка поля и уникальность', () => {
  it('ключом может быть только текстовое поле; с повторами (без учёта регистра и пробелов) — отказ со списком', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const reg = await structure.addField(tx, x.actor, x.reg.id, { label: 'Имя хоста', type: 'text' });
      const host = must(reg.fields.find((f) => f.label === 'Имя хоста'));
      const score = must(reg.fields.find((f) => f.id === x.f.score));
      await expectCode(structure.updateField(tx, x.actor, score.id, { version: score.version, isImportKey: true }), 'IMPORT_KEY_TEXT');

      const a = await create(tx, x, host.id, 'Бухгалтерия', 'PC-01');
      const b = await create(tx, x, host.id, 'Касса', '  pc-01 ');
      await create(tx, x, host.id, 'Склад', 'PC-02');
      try {
        await structure.updateField(tx, x.actor, host.id, { version: host.version, isImportKey: true });
        throw new Error('ожидался отказ');
      } catch (err) {
        const e = err as { code?: string; message: string; details?: { duplicates: { numbers: number[] }[] } };
        expect(e.code).toBe('IMPORT_KEY_DUPLICATES');
        expect(e.message).toContain(`#${a.number}, #${b.number}`);
        expect(e.details?.duplicates).toEqual([{ value: expect.any(String), numbers: [a.number, b.number] }]);
      }
      // Повтор исправлен — ключ назначается, import_key заполнен у всех записей.
      await records.updateRecord(tx, x.actor, b.id, { version: b.version, values: { [host.id]: 'PC-03' } });
      await structure.updateField(tx, x.actor, host.id, { version: host.version, isImportKey: true });
      const keys = await tx.registerRecord.findMany({ where: { registerId: x.reg.id }, select: { importKey: true }, orderBy: { number: 'asc' } });
      expect(keys.map((k) => k.importKey)).toEqual(['pc-01', 'pc-03', 'pc-02']);
    }));

  it('запись с занятым ключом не создаётся и не правится; удалённая запись ключ освобождает; ключ нельзя архивировать', () =>
    inTx(async (tx) => {
      const { x, host } = await withHostKey(tx);
      const a = await create(tx, x, host, 'Бухгалтерия', 'PC-01');
      const b = await create(tx, x, host, 'Касса', 'PC-02');
      await expectCode(create(tx, x, host, 'Ещё', 'pc-01'), 'IMPORT_KEY_TAKEN');
      await expectCode(records.updateRecord(tx, x.actor, b.id, { version: b.version, values: { [host]: ' PC-01' } }), 'IMPORT_KEY_TAKEN');
      // Правка своей же записи (регистр) — не конфликт.
      await records.updateRecord(tx, x.actor, a.id, { version: a.version, values: { [host]: 'pc-01' } });
      await records.deleteRecord(tx, x.actor, b.id, b.version);
      await create(tx, x, host, 'Касса (новый ПК)', 'PC-02');

      const reg = await x.reload();
      const key = must(importKeyField(reg));
      await expectCode(structure.setFieldArchived(tx, x.actor, key.id, key.version, true), 'IMPORT_KEY_FIELD');
    }));

  it('уникальность держит сама БД: прямая запись дубля отклоняется индексом', () =>
    inTx(async (tx) => {
      const { x, host } = await withHostKey(tx);
      await create(tx, x, host, 'Бухгалтерия', 'PC-01');
      await expect(tx.$executeRaw`
        INSERT INTO register_records (register_id, number, "values", updated_at)
        VALUES (${x.reg.id}::uuid, 999, ${JSON.stringify({ [host]: 'PC-01 ' })}::jsonb, now())`)
        .rejects.toThrow(/23505.*import_key/s);
    }));
});

describe('импорт по ключу без колонки ID', () => {
  it('найдена — обновление, нет — новая; сопоставление каждой строки; «нет в файле» без закрытых и архивных', () =>
    inTx(async (tx) => {
      const { x, host } = await withHostKey(tx);
      const a = await create(tx, x, host, 'Бухгалтерия', 'PC-01', { [x.f.score]: 1 });
      const b = await create(tx, x, host, 'Касса', 'PC-02', { [x.f.score]: 2 });
      const gone = await create(tx, x, host, 'Списан', 'PC-OLD');
      const closed = await create(tx, x, host, 'Выведен', 'PC-CLOSED', { [x.f.status]: x.opt('status', 'Закрыт') });
      const arch = await create(tx, x, host, 'Архив', 'PC-ARCH');
      await records.setRecordArchived(tx, x.actor, arch.id, arch.version, true);

      const file = await dmFile([
        ['pc-01', 'Бухгалтерия', 5], // регистр другой — та же запись; Баллы 1 → 5
        ['PC-02', 'Касса', 2], // без изменений
        ['PC-NEW', 'Новый ПК', 3], // новая
      ]);
      const p = await excel.previewImport(tx, x.actor, x.reg.id, file, 'dm.xlsx');
      expect(p.summary).toMatchObject({
        matchBy: 'key', keyField: { id: host, label: 'Имя хоста' }, rows: 3, added: 1, updated: 1, unchanged: 1, errorRows: 0,
      });
      expect(p.summary.matches).toEqual([
        { row: 2, key: 'pc-01', number: a.number, action: 'update' },
        { row: 3, key: 'PC-02', number: b.number, action: 'unchanged' },
        { row: 4, key: 'PC-NEW', number: null, action: 'add' },
      ]);
      expect(p.summary.missing).toEqual([{ id: gone.id, number: gone.number, key: 'PC-OLD', title: 'Списан' }]);
      expect(p.summary.missingTotal).toBe(1);
      expect(closed.closed).toBe(true);

      const res = await excel.applyImport(tx, x.actor, p.id);
      expect(res).toEqual({ added: 1, updated: 1, skipped: 0 });
      // «Нет в файле» портал не меняет.
      expect((await records.getRecord(tx, gone.id)).archived).toBe(false);

      // Повторный импорт того же файла — ноль изменений.
      const again = await excel.previewImport(tx, x.actor, x.reg.id, file, 'dm.xlsx');
      expect(again.summary).toMatchObject({ added: 0, updated: 0, unchanged: 3, errorRows: 0 });
      expect(again.summary.matches.map((m) => m.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    }));

  it('повтор ключа в файле — ошибка во всех таких строках; пустой ключ и архивная запись — ошибка строки', () =>
    inTx(async (tx) => {
      const { x, host } = await withHostKey(tx);
      const arch = await create(tx, x, host, 'Архив', 'PC-ARCH');
      await records.setRecordArchived(tx, x.actor, arch.id, arch.version, true);
      const file = await dmFile([
        ['PC-05', 'Первый', 1],
        [' pc-05', 'Второй', 2],
        [null, 'Без хоста', 3],
        ['PC-ARCH', 'Архив', 4],
        ['PC-06', 'Нормальный', 5],
      ]);
      const p = await excel.previewImport(tx, x.actor, x.reg.id, file, 'dm.xlsx');
      expect(p.summary).toMatchObject({ added: 1, updated: 0, errorRows: 4 });
      const msg = (row: number) => p.summary.errors.filter((e) => e.row === row).map((e) => e.message).join(' | ');
      expect(msg(2)).toContain('встречается в строках 2, 3');
      expect(msg(3)).toContain('встречается в строках 2, 3');
      expect(msg(4)).toContain('Заполните «Имя хоста»');
      expect(msg(5)).toContain('в архиве');
      expect(p.summary.matches.map((m) => m.action)).toEqual(['error', 'error', 'error', 'error', 'add']);
    }));

  it('запись с тем же ключом появилась после предпросмотра — не применяется ничего', () =>
    inTx(async (tx) => {
      const { x, host } = await withHostKey(tx);
      const p = await excel.previewImport(tx, x.actor, x.reg.id, await dmFile([['PC-10', 'Новый', 1], ['PC-11', 'Ещё', 1]]), 'dm.xlsx');
      expect(p.summary.added).toBe(2);
      await create(tx, x, host, 'Заведён вручную', 'pc-10');
      await expectCode(excel.applyImport(tx, x.actor, p.id), 'IMPORT_STALE');
      expect(await tx.registerRecord.count({ where: { registerId: x.reg.id, deletedAt: null } })).toBe(1);
    }));

  it('импорт по ID: новое значение ключа, занятое другой записью или другой строкой, — ошибка строки', () =>
    inTx(async (tx) => {
      const { x, host } = await withHostKey(tx);
      const a = await create(tx, x, host, 'Бухгалтерия', 'PC-01');
      const b = await create(tx, x, host, 'Касса', 'PC-02');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Реестр');
      ws.addRow(['ID', 'Имя хоста', 'Наименование']);
      ws.addRow([b.number, 'pc-01', null]); // занят записью a
      ws.addRow([null, 'PC-20', 'Новый']);
      ws.addRow([null, 'pc-20 ', 'Ещё новый']); // повтор строки выше
      const p = await excel.previewImport(tx, x.actor, x.reg.id, Buffer.from(await wb.xlsx.writeBuffer()), 'id.xlsx');
      expect(p.summary).toMatchObject({ matchBy: 'id', added: 1, errorRows: 2 });
      const byRow = new Map(p.summary.errors.map((e) => [e.row, e.message]));
      expect(byRow.get(2)).toContain(`уже есть в записи #${a.number}`);
      expect(byRow.get(4)).toContain('уже встречается в строке 3');
    }));

  it('без колонки ID и без колонки ключа — понятная ошибка', () =>
    inTx(async (tx) => {
      const { x } = await withHostKey(tx);
      await expectCode(excel.previewImport(tx, x.actor, x.reg.id, await dmFile([['Что-то', 1]], ['Наименование', 'Баллы']), 'x.xlsx'), 'NO_ID_COLUMN');
    }));
});
