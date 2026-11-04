// Книга Excel в виде листов со строками — общий вид для адаптеров импорта (релиз 1.6.0, ADR-0032).
// Источники: XML Spreadsheet 2003 (SpreadsheetML — так Kaspersky Security Center сохраняет отчёт «.xls») и .xlsx.
// Разбор XML безопасный: файл с DTD или объявлением сущностей отклоняется до разбора, внешние сущности не читаются.
import ExcelJS from 'exceljs';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { badRequest } from './errors.js';
import { cellPrimitive } from './register-values.js';

export type SheetCell = string | number | Date | null;
export interface SheetData {
  name: string;
  /** Строки по порядку, с пропусками (ss:Index) как пустыми строками; ячейки — с пропусками как null. */
  rows: SheetCell[][];
}

const SS_NS = 'urn:schemas-microsoft-com:office:spreadsheet';

/** Начало файла: XML-декларация (с BOM или без) и пространство имён SpreadsheetML в первых килобайтах. */
export function isSpreadsheetML(buf: Buffer): boolean {
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('<?xml') && head.includes(SS_NS);
}

/**
 * Двоичный Excel 97–2003 (BIFF8) — контейнер OLE: сигнатура D0 CF 11 E0 A1 B1 1A E1. Такие файлы портал не читает
 * (релиз 1.8.0, решение владельца: SheetJS не подключаем) — адаптер отказывает понятным сообщением.
 */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
export function isOle(buf: Buffer): boolean {
  return buf.length >= OLE_SIGNATURE.length && OLE_SIGNATURE.every((b, i) => buf[i] === b);
}

/** .xlsx — zip: сигнатура PK. */
export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);
const attr = (tag: SaxesTagPlain, name: string): string | undefined => {
  for (const [k, v] of Object.entries(tag.attributes)) if (local(k) === name) return v;
  return undefined;
};
const positive = (s: string | undefined): number | null => {
  const n = s === undefined ? NaN : Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function typed(text: string, type: string | undefined): SheetCell {
  if (type === 'Number') {
    const n = Number(text);
    return text.trim() === '' || !Number.isFinite(n) ? null : n;
  }
  if (type === 'DateTime') {
    // «2025-06-01T00:00:00.000» без зоны — дата в UTC, как ячейки дат exceljs.
    const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);
    return Number.isNaN(d.getTime()) ? (text.trim() || null) : d;
  }
  return text === '' ? null : text;
}

/**
 * XML Spreadsheet 2003 → листы. Ячейки ss:Data типов String, Number, DateTime; ss:Index — номер ячейки или строки
 * (пропуск), ss:MergeAcross — ячейка занимает ещё N колонок. Форматированный текст (html:Font внутри Data) — текстом.
 */
export function parseSpreadsheetML(buf: Buffer, maxRows: number): SheetData[] {
  const xml = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw badRequest('BAD_FILE', 'Файл содержит объявление DTD или сущностей — такие файлы не принимаются');
  }
  const parser = new SaxesParser();
  const sheets: SheetData[] = [];
  let sheet: SheetData | null = null;
  let row: SheetCell[] | null = null;
  let col = 0;
  let cellType: string | undefined;
  let cellCol = 0;
  let inData = false;
  let text = '';
  let failed: Error | null = null;
  let tooMany = false;

  parser.on('doctype', () => {
    failed = new Error('doctype');
  });
  parser.on('error', (e) => {
    failed = e;
  });
  parser.on('opentag', (tag) => {
    const name = local(tag.name);
    if (name === 'Worksheet') {
      sheet = { name: attr(tag, 'Name') ?? `Лист ${sheets.length + 1}`, rows: [] };
      sheets.push(sheet);
    } else if (name === 'Row' && sheet) {
      const index = positive(attr(tag, 'Index'));
      while (index !== null && sheet.rows.length < index - 1) sheet.rows.push([]);
      if (sheet.rows.length >= maxRows) tooMany = true;
      row = [];
      sheet.rows.push(row);
      col = 0;
    } else if (name === 'Cell' && row) {
      const index = positive(attr(tag, 'Index'));
      if (index !== null) col = index - 1;
      cellCol = col;
      col += 1 + (positive(attr(tag, 'MergeAcross')) ?? 0);
    } else if (name === 'Data' && row) {
      inData = true;
      text = '';
      cellType = attr(tag, 'Type');
    }
  });
  parser.on('text', (t) => {
    if (inData) text += t;
  });
  parser.on('cdata', (t) => {
    if (inData) text += t;
  });
  parser.on('closetag', (tag) => {
    const name = local(tag.name);
    if (name === 'Data' && row) {
      inData = false;
      while (row.length < cellCol) row.push(null);
      row[cellCol] = typed(text, cellType);
    } else if (name === 'Row') row = null;
    else if (name === 'Worksheet') sheet = null;
  });
  try {
    parser.write(xml).close();
  } catch {
    throw badRequest('BAD_FILE', 'Не удалось прочитать файл: XML повреждён');
  }
  if (failed) throw badRequest('BAD_FILE', 'Не удалось прочитать файл: XML повреждён');
  if (tooMany) throw badRequest('TOO_MANY_ROWS', `В листе больше ${maxRows} строк`);
  if (!sheets.length) throw badRequest('BAD_FILE', 'В файле нет листов');
  return sheets;
}

/** .xlsx → листы того же вида: видимые листы, значения ячеек как при импорте. */
export async function parseXlsxSheets(buf: Buffer, maxRows: number): Promise<SheetData[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    throw badRequest('BAD_FILE', 'Не удалось прочитать файл. Нужна книга Excel (.xlsx) или отчёт XML');
  }
  return wb.worksheets.filter((ws) => ws.state === 'visible').map((ws) => {
    if (ws.rowCount > maxRows) throw badRequest('TOO_MANY_ROWS', `В листе «${ws.name}» больше ${maxRows} строк`);
    const rows: SheetCell[][] = [];
    ws.eachRow({ includeEmpty: true }, (r, n) => {
      const cells: SheetCell[] = [];
      r.eachCell({ includeEmpty: true }, (c, i) => {
        // У объединённой ячейки значение только в первой.
        cells[i - 1] = c.isMerged && c.master !== c ? null : cellPrimitive(c.value);
      });
      rows[n - 1] = Array.from(cells, (v) => v ?? null);
    });
    return { name: ws.name, rows: Array.from(rows, (r) => r ?? []) };
  });
}

/** Любой из двух форматов по содержимому, не по расширению. */
export async function readSheets(buf: Buffer, maxRows: number): Promise<SheetData[]> {
  if (buf.length === 0) throw badRequest('BAD_FILE', 'Файл пустой');
  if (isSpreadsheetML(buf)) return parseSpreadsheetML(buf, maxRows);
  if (isZip(buf)) return parseXlsxSheets(buf, maxRows);
  throw badRequest('BAD_FILE', 'Формат не распознан: нужен отчёт XML Spreadsheet (.xls из KSC) или книга Excel (.xlsx)');
}

/** Текст ячейки: строка без лишних пробелов; число — как есть; дата — ГГГГ-ММ-ДД. */
export function cellString(v: SheetCell | undefined): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).replace(/\s+/g, ' ').trim();
}
