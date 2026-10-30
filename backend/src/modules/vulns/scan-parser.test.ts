import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { detectFormat } from './import-detect.js';
import { mergeDuplicates, parseScanReport, reportDateFromFileName } from './scan-parser.js';

// Образец владельца: лист «Хосты» с охватом в первой строке, находки — на листе с произвольным названием.
const NAME = 'vuln-windows-2026-10-15.xlsx';
const SAMPLE = readFileSync(new URL(`../../../test/fixtures/${NAME}`, import.meta.url));

async function book(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(SAMPLE as unknown as ExcelJS.Buffer);
  return wb;
}
const toBuffer = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());
const findingsOf = (wb: ExcelJS.Workbook) => wb.worksheets.find((w) => w.name !== 'Хосты') as ExcelJS.Worksheet;
const HEADERS = ['Пакет', 'CVE', 'Уровень', 'CVSS', 'Эксплойт', 'Сетевой вектор', 'Обновить до версии', 'Краткое описание', 'Обнаружений'];

describe('разбор отчёта сканера по содержимому', () => {
  it('образец: 12 хостов, охват, 90 находок с одного листа, идентификатор не CVE, строка без CVSS, CVE у двух пакетов', async () => {
    const p = await parseScanReport(SAMPLE, NAME);
    expect([p.hosts.length, p.coverageTitle, p.hostsSheet, p.reportDate]).toEqual([12, 'Отдел платёжных карт', 'Хосты', '2026-10-15']);
    expect(p.sheets).toEqual([{ name: 'Критические, обн. стабильны', rows: 90 }]);
    expect([p.rows.length, p.errors, p.notes]).toEqual([90, [], []]);
    expect(p.hosts[0]).toEqual({ name: 'TEST-PC01NB', ip: '10.0.0.168', os: 'Windows 11' });
    expect(p.rows.filter((r) => !r.cve.startsWith('CVE-')).map((r) => r.cve)).toEqual(['BDU:2025-01793']);
    expect(p.rows.filter((r) => r.cvss === null).map((r) => r.cve)).toEqual(['BDU:2025-01793']);
    expect(p.rows.filter((r) => r.cve === 'CVE-2023-44487')).toHaveLength(2);
    expect(Math.max(...p.rows.map((r) => r.hits ?? 0))).toBe(22);
    expect(mergeDuplicates(p.rows).duplicates).toBe(0);
    // Колонка «Оценка» с формулой не читается.
    expect(p.rows[0]).not.toHaveProperty('score');
  });

  it('листы переименованы, охват не в A1, заголовок ниже, второй лист находок — объединяются', async () => {
    const wb = await book();
    const f = findingsOf(wb);
    const hosts = wb.getWorksheet('Хосты') as ExcelJS.Worksheet;
    hosts.name = 'Inventory';
    hosts.spliceRows(1, 0, ['Сканирование от октября'], []);
    expect(hosts.getRow(3).getCell(1).value).toBe('Отдел платёжных карт');
    f.name = 'Report';
    const more = wb.addWorksheet('Ещё');
    more.addRow(['Шапка отчёта']);
    more.addRow([]);
    more.addRow(['Идентификатор уязвимости', 'Пакет', 'Описание', 'Обновить до']);
    more.addRow(['CVE-2026-0001', 'Пакет Б', 'Описание Б', '1.2']);
    const p = await parseScanReport(await toBuffer(wb), NAME);
    expect([p.hostsSheet, p.coverageTitle, p.hosts.length]).toEqual(['Inventory', 'Отдел платёжных карт', 12]);
    expect(p.sheets).toEqual([{ name: 'Report', rows: 90 }, { name: 'Ещё', rows: 1 }]);
    expect(p.rows.at(-1)).toMatchObject({ sheet: 'Ещё', pkg: 'Пакет Б', cve: 'CVE-2026-0001', desc: 'Описание Б', fixVersion: '1.2', cvss: null });
    expect(p.warnings.join(' ')).toContain('Лист «Ещё»: нет колонок');
  });

  it('нет пакета или идентификатора — строка пропущена с сообщением; CVSS и «Обнаружений» не число — строка остаётся, значение пустое', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Находки');
    ws.addRow(HEADERS);
    ws.addRow(['Пакет А', 'CVE-1', 'Важная', 'н/д', 'Нет', 'Локально', '1.0', 'а', 'много']);
    ws.addRow([null, 'CVE-2', 'Важная', 5, 'Нет', 'Локально', '1.0', 'б', 1]);
    ws.addRow(['Пакет В', null, 'Важная', 5, 'Нет', 'Локально', '1.0', 'в', 1]);
    ws.addRow(['Пакет Г', 'CVE-4', 'Важная', 11, 'Нет', 'Локально', '1.0', 'г', 1.5]);
    ws.addRow([]);
    const p = await parseScanReport(await toBuffer(wb), 'без даты.xlsx');
    expect(p.rows.map((r) => [r.pkg, r.cvss, r.hits])).toEqual([['Пакет А', null, null], ['Пакет Г', null, null]]);
    expect(p.errors.map((e) => [e.sheet, e.row, e.field])).toEqual([['Находки', 3, 'Пакет'], ['Находки', 4, 'CVE']]);
    expect(p.notes.map((n) => [n.row, n.field])).toEqual([[2, 'CVSS'], [2, 'Обнаружений'], [5, 'CVSS'], [5, 'Обнаружений']]);
    expect(p.notes[0]?.message).toContain('«н/д»');
    expect([p.reportDate, p.hostsSheet, p.coverageTitle]).toEqual([null, null, '']);
    expect(p.warnings.join(' ')).toContain('нет листа с колонкой «Имя хоста»');
  });

  it('файл без находок — не отчёт сканера', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Лист').addRow(['Имя хоста', 'IP']);
    await expect(parseScanReport(await toBuffer(wb), NAME)).rejects.toMatchObject({ code: 'NOT_SCAN_REPORT' });
    await expect(parseScanReport(Buffer.alloc(0), NAME)).rejects.toMatchObject({ code: 'BAD_FILE' });
  });

  it('дата скана: «_», «-», «.»; неверная — нет', () => {
    for (const n of ['vuln_2026_10_15.xlsx', 'vuln 2026-10-15.xlsx', 'vuln.2026.10.15.xlsx']) expect(reportDateFromFileName(n)).toBe('2026-10-15');
    expect(reportDateFromFileName('vuln_2026_13_45.xlsx')).toBeNull();
    expect(reportDateFromFileName('vuln.xlsx')).toBeNull();
  });

  it('повтор ключа без регистра и лишних пробелов — одна строка, «Обнаружений» по максимуму; первая строка остаётся', () => {
    const row = (n: number, pkg: string, cve: string, hits: number | null) => ({
      sheet: 'Л', row: n, pkg, cve, level: null, cvss: null, exploit: null, vector: null, fixVersion: null, desc: null, hits,
    });
    const { unique, duplicates } = mergeDuplicates([row(2, 'OpenSSL', 'CVE-1', 3), row(3, ' openssl ', 'cve-1', 9), row(4, 'OpenSSL', 'CVE-1', null), row(5, 'OpenSSL', 'CVE-2', 1)]);
    expect(duplicates).toBe(2);
    expect(unique.map((r) => [r.row, r.hits])).toEqual([[2, 9], [5, 1]]);
  });

  it('тип файла: отчёт — по колонкам, выгрузка — по ID и скрытому листу, важнее колонок сканера', async () => {
    expect(detectFormat(await book())).toBe('scan');
    const noHosts = await book();
    noHosts.removeWorksheet((noHosts.getWorksheet('Хосты') as ExcelJS.Worksheet).id);
    expect(detectFormat(noHosts)).toBe('scan');
    const withId = new ExcelJS.Workbook();
    withId.addWorksheet('Реестр').addRow(['ID', 'Пакет', 'CVE']);
    expect(detectFormat(withId)).toBe('records');
    const plain = new ExcelJS.Workbook();
    plain.addWorksheet('Лист1').addRow(['Имя', 'Дата', 'Сумма']);
    expect(() => detectFormat(plain)).toThrowError(/Ожидался отчёт сканера.*«Лист1»: «Имя», «Дата», «Сумма»/);
  });
});
