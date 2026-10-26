import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { TEST_SECRET } from '../../test/helpers.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, type Tx } from '../../test/db.js';
import { makeRegister, type Fixture } from '../../test/registers-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as excel from './excel.service.js';
import * as records from './records.service.js';
import { XLSX_TYPE } from './routes.js';
import * as structure from './structure.service.js';

async function book(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}
async function save(wb: ExcelJS.Workbook) {
  return Buffer.from(await wb.xlsx.writeBuffer());
}
/** Номер колонки по заголовку на листе «Реестр». */
function col(ws: ExcelJS.Worksheet, header: string): number {
  let found = 0;
  ws.getRow(1).eachCell((c, n) => {
    if (String(c.value) === header) found = n;
  });
  if (!found) throw new Error(`нет колонки ${header}`);
  return found;
}
/** Строка листа по ID записи. */
function rowById(ws: ExcelJS.Worksheet, id: number): ExcelJS.Row {
  for (let n = 2; n <= ws.rowCount; n++) if (ws.getRow(n).getCell(1).value === id) return ws.getRow(n);
  throw new Error(`нет строки ${id}`);
}

async function seedRecords(tx: Tx, x: Fixture) {
  const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Динара Импортова' });
  const a = await records.createRecord(tx, x.actor, x.reg.id, {
    values: { [x.f.title]: 'CVE-A', [x.f.level]: x.opt('level', 'Высокий'), [x.f.score]: 7.5, [x.f.found]: '2026-10-01', [x.f.owner]: owner.id },
  });
  const b = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'CVE-B', [x.f.level]: x.opt('level', 'Средний') } });
  return { owner, a, b };
}

describe('экспорт', () => {
  it('лист «Реестр» с ID, сотрудник как «ФИО (логин)», даты, только чтение; служебный лист и «Справка»', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const { owner, a } = await seedRecords(tx, x);
      const { buffer, fileName } = await excel.exportRegister(tx, x.reg.id);
      expect(fileName).toMatch(/\.xlsx$/);
      const wb = await book(buffer);
      expect(wb.worksheets.map((w) => [w.name, w.state])).toEqual([['Реестр', 'visible'], ['_поля', 'veryHidden'], ['Справка', 'visible']]);
      const ws = wb.getWorksheet('Реестр') as ExcelJS.Worksheet;
      const r = rowById(ws, a.number);
      expect(r.getCell(col(ws, 'Ответственный')).value).toBe(`Динара Импортова (${owner.login})`);
      expect(r.getCell(col(ws, 'Уровень')).value).toBe('Высокий');
      expect(r.getCell(col(ws, 'Баллы')).value).toBe(7.5);
      expect((r.getCell(col(ws, 'Выявлено')).value as Date).toISOString().slice(0, 10)).toBe('2026-10-01');
      expect((r.getCell(col(ws, 'Срок устранения')).value as Date).toISOString().slice(0, 10)).toBe('2026-10-15');
      expect(col(ws, 'Решение ОУР: документ')).toBeGreaterThan(0);
      const help = wb.getWorksheet('Справка') as ExcelJS.Worksheet;
      const text = help.getSheetValues().flat().join(' ');
      expect(text).toContain('«ФИО (логин)»');
      expect(text).toContain('если такое имя у единственного сотрудника');
      expect(text).toContain('Пустая ячейка не меняет значение');
    }));
});

describe('импорт: предпросмотр', () => {
  it('добавится, изменится, по полям; пустая ячейка не меняет; сотрудник по логину; поле переименовано после выгрузки', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const { a, b } = await seedRecords(tx, x);
      const other = await makeUser(tx, ['ib_staff'], { fullName: 'Олег Новиков' });
      const wb = await book((await excel.exportRegister(tx, x.reg.id)).buffer);
      const ws = wb.getWorksheet('Реестр') as ExcelJS.Worksheet;
      rowById(ws, a.number).getCell(col(ws, 'Баллы')).value = '8,5';
      rowById(ws, a.number).getCell(col(ws, 'Ответственный')).value = `Кто угодно (${other.login})`;
      rowById(ws, a.number).getCell(col(ws, 'Уровень')).value = null; // пустая — не меняет
      rowById(ws, b.number).getCell(col(ws, 'Выявлено')).value = '15.10.2026';
      ws.addRow([null, 'CVE-NEW']).getCell(col(ws, 'Уровень')).value = 'низкий';
      // Переименование поля после выгрузки: колонки сопоставляются по id поля.
      const lv = (await x.reload()).fields.find((f) => f.id === x.f.level);
      await structure.updateField(tx, x.actor, x.f.level, { version: lv?.version ?? 0, label: 'Критичность' });

      const p = await excel.previewImport(tx, x.actor, x.reg.id, await save(wb), 'отчёт ДИКТ.xlsx');
      expect(p.summary).toMatchObject({ rows: 3, added: 1, updated: 2, unchanged: 0, errorRows: 0, errors: [] });
      expect(p.summary.fieldChanges.map((c) => [c.label, c.count])).toEqual([
        ['Наименование', 1], ['Критичность', 1], ['Баллы', 1], ['Выявлено', 1], ['Ответственный', 1],
      ]);
      // Предпросмотр ничего не меняет.
      expect((await records.getRecord(tx, a.id)).values[x.f.score]).toBe(7.5);
      expect((await lastAudit(tx)).action).toBe('register.import.previewed');
    }));

  it('ошибки по строкам: неизвестный и повторный ID, число, дата, список, сотрудник; без заголовка у новой', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const { a, b } = await seedRecords(tx, x);
      await makeUser(tx, ['ib_staff'], { fullName: 'Тёзка Один' });
      await makeUser(tx, ['ib_staff'], { fullName: 'Тёзка Один' });
      const wb = await book((await excel.exportRegister(tx, x.reg.id)).buffer);
      const ws = wb.getWorksheet('Реестр') as ExcelJS.Worksheet;
      const ra = rowById(ws, a.number);
      ra.getCell(col(ws, 'Баллы')).value = 'много';
      rowById(ws, b.number).getCell(col(ws, 'Выявлено')).value = '2026/10/15';
      const dup = ws.addRow([b.number, 'Дубль']);
      const unknown = ws.addRow([999, 'Нет такой']);
      ws.addRow([null, 'Новая']).getCell(col(ws, 'Уровень')).value = 'Неизвестный';
      ws.addRow([null, 'Новая 2']).getCell(col(ws, 'Ответственный')).value = 'Тёзка Один';
      ws.addRow([null, null, null, null, 5]); // нет заголовка
      const p = await excel.previewImport(tx, x.actor, x.reg.id, await save(wb), 'ошибки.xlsx');
      const msgs = p.summary.errors.map((e) => `${e.field}: ${e.message}`);
      expect(p.summary.added).toBe(0);
      expect(p.summary.errorRows).toBe(7);
      expect(msgs).toEqual(expect.arrayContaining([
        expect.stringContaining('«много» — не число'),
        expect.stringContaining('не дата'),
        expect.stringContaining(`ID ${b.number} уже встречается`),
        expect.stringContaining('Записи с ID 999 нет в реестре'),
        expect.stringContaining('нет такого значения в списке'),
        expect.stringContaining('Найдено несколько сотрудников «Тёзка Один»'),
        expect.stringContaining('Для новой записи заполните «Наименование»'),
      ]));
      expect(dup.number).toBeGreaterThan(0);
      expect(unknown.number).toBeGreaterThan(0);
    }));

  it('колонки «только чтение» не импортируются, изменения в них — предупреждение', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const { a } = await seedRecords(tx, x);
      const wb = await book((await excel.exportRegister(tx, x.reg.id)).buffer);
      const ws = wb.getWorksheet('Реестр') as ExcelJS.Worksheet;
      rowById(ws, a.number).getCell(col(ws, 'Срок устранения')).value = new Date('2030-01-01T00:00:00Z');
      rowById(ws, a.number).getCell(col(ws, 'Решение ОУР')).value = 'Принят';
      const p = await excel.previewImport(tx, x.actor, x.reg.id, await save(wb), 'ro.xlsx');
      expect(p.summary).toMatchObject({ updated: 0, unchanged: 2, errorRows: 0 });
      expect(p.summary.warnings.join(' ')).toContain('только для чтения» изменено значений: 2');
    }));

  it('файл без служебного листа сопоставляется по названиям; чужой реестр и не-xlsx — ошибка', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const { a } = await seedRecords(tx, x);
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Данные');
      ws.addRow(['ID', 'Наименование', 'Баллы', 'Лишняя колонка']);
      ws.addRow([a.number, 'CVE-A', 9]);
      const p = await excel.previewImport(tx, x.actor, x.reg.id, await save(wb), 'ручной.xlsx');
      expect(p.summary).toMatchObject({ updated: 1 });
      expect(p.summary.warnings.join(' ')).toContain('«Лишняя колонка»');

      const y = await makeRegister(tx, 'Другой реестр');
      const foreign = (await excel.exportRegister(tx, y.reg.id)).buffer;
      await expectCode(excel.previewImport(tx, x.actor, x.reg.id, foreign, 'чужой.xlsx'), 'WRONG_REGISTER');
      await expectCode(excel.previewImport(tx, x.actor, x.reg.id, Buffer.from('not an xlsx'), 'x.xlsx'), 'BAD_FILE');
      const noId = new ExcelJS.Workbook();
      noId.addWorksheet('Л').addRow(['Наименование']);
      await expectCode(excel.previewImport(tx, x.actor, x.reg.id, await save(noId), 'x.xlsx'), 'NO_ID_COLUMN');
    }));
});

describe('импорт: применение', () => {
  it('одной транзакцией: изменения, новые записи с номерами, история и журнал; повторно — нельзя', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const { a, b } = await seedRecords(tx, x);
      const wb = await book((await excel.exportRegister(tx, x.reg.id)).buffer);
      const ws = wb.getWorksheet('Реестр') as ExcelJS.Worksheet;
      rowById(ws, a.number).getCell(col(ws, 'Баллы')).value = 9;
      ws.addRow([null, 'CVE-NEW']);
      ws.addRow([777, 'Ошибка — пропускается']);
      const p = await excel.previewImport(tx, x.actor, x.reg.id, await save(wb), 'итог.xlsx');
      const res = await excel.applyImport(tx, x.actor, p.id);
      expect(res).toEqual({ added: 1, updated: 1, skipped: 1 });
      expect((await records.getRecord(tx, a.id)).values[x.f.score]).toBe(9);
      expect((await records.getRecord(tx, b.id)).version).toBe(b.version);
      const list = await records.listRecords(tx, x.reg.id, { limit: 10, q: 'cve-new' });
      expect(list.items[0]).toMatchObject({ number: 3, display: { [x.f.status]: 'Новый' } });
      expect((await lastAudit(tx)).diff).toMatchObject({ summary: expect.stringContaining('добавлено 1, изменено 1, пропущено строк с ошибками 1') });
      expect((await records.recordHistory(tx, a.id))[0]).toMatchObject({ via: 'import', changes: [{ label: 'Баллы', from: '7,5', to: '9' }] });
      await expectCode(excel.applyImport(tx, x.actor, p.id), 'IMPORT_NOT_PENDING');
    }));

  it('если запись изменилась после предпросмотра — не применяется ничего', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const { a, b } = await seedRecords(tx, x);
      const wb = await book((await excel.exportRegister(tx, x.reg.id)).buffer);
      const ws = wb.getWorksheet('Реестр') as ExcelJS.Worksheet;
      rowById(ws, a.number).getCell(col(ws, 'Баллы')).value = 1;
      rowById(ws, b.number).getCell(col(ws, 'Баллы')).value = 2;
      const p = await excel.previewImport(tx, x.actor, x.reg.id, await save(wb), 'stale.xlsx');
      await records.updateRecord(tx, x.actor, b.id, { version: b.version, values: { [x.f.title]: 'CVE-B изм.' } });
      await expectCode(excel.applyImport(tx, x.actor, p.id), 'IMPORT_STALE');
      expect((await records.getRecord(tx, a.id)).values[x.f.score]).toBe(7.5);
    }));

  it('применить может только загрузивший; отмена', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      await seedRecords(tx, x);
      const p = await excel.previewImport(tx, x.actor, x.reg.id, (await excel.exportRegister(tx, x.reg.id)).buffer, 'x.xlsx');
      const stranger = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      await expectCode(excel.applyImport(tx, stranger, p.id), 'IMPORT_OTHER_USER');
      await excel.cancelImport(tx, x.actor, p.id);
      expect((await excel.getImport(tx, p.id)).status).toBe('cancelled');
      await expectCode(excel.applyImport(tx, x.actor, p.id), 'IMPORT_NOT_PENDING');
    }));
});

describe('реестры по HTTP: права на маршрутах, загрузка и выгрузка файла', () => {
  it('сотрудник ИБ: записи да, структура нет, удаление нет; администратор — всё', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Http-Reg-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const x = await makeRegister(tx);
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const A = await login(admin.login);
      const S = await login(staff.login);
      const base = `/api/v1/registers/${x.reg.id}`;
      expect((await app.inject({ method: 'POST', url: `${base}/fields`, headers: { cookie: S }, payload: { label: 'Х', type: 'text' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `${base}/fields`, headers: { cookie: A }, payload: { label: 'Х', type: 'text' } })).statusCode).toBe(200);
      const created = await app.inject({ method: 'POST', url: `${base}/records`, headers: { cookie: S }, payload: { values: { [x.f.title]: 'От сотрудника' } } });
      expect(created.statusCode).toBe(201);
      const rec = created.json() as { id: string; version: number };
      const del = { method: 'POST' as const, url: `/api/v1/register-records/${rec.id}/delete`, payload: { version: rec.version } };
      expect((await app.inject({ ...del, headers: { cookie: S } })).statusCode).toBe(403);
      expect((await app.inject({ ...del, headers: { cookie: A } })).statusCode).toBe(204);

      const exp = await app.inject({ url: `${base}/export`, headers: { cookie: S } });
      expect(exp.statusCode).toBe(200);
      expect(exp.headers['content-type']).toContain('spreadsheetml');
      expect(String(exp.headers['content-disposition'])).toContain("filename*=UTF-8''");
      const imp = await app.inject({
        method: 'POST', url: `${base}/imports`,
        headers: { cookie: S, 'content-type': XLSX_TYPE, 'x-file-name': encodeURIComponent('файл ДИКТ.xlsx') },
        payload: exp.rawPayload,
      });
      expect(imp.statusCode).toBe(201);
      expect(imp.json().summary.fileName).toBe('файл ДИКТ.xlsx');
      const lawyer = await makeUser(tx, ['legal'], { passwordHash: hash });
      const L = await login(lawyer.login);
      expect((await app.inject({ url: `${base}/records`, headers: { cookie: L } })).statusCode).toBe(403);
    }));
});
