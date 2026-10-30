// Одна кнопка «Импорт из Excel»: какой это файл — отчёт сканера или выгрузка реестра портала.
import type ExcelJS from 'exceljs';
import { badRequest } from '../../lib/errors.js';
import { cellPrimitive } from '../../lib/register-values.js';
import { HELP_SHEET, MAP_SHEET } from '../registers/excel.service.js';
import { headerMap, HEADER_SEARCH_ROWS, SCAN_HEADERS } from './scan-parser.js';

export type FileFormat = 'scan' | 'records';

const SHOW_COLUMNS = 12;

function headersOf(ws: ExcelJS.Worksheet, row: number): string[] {
  const out: string[] = [];
  ws.getRow(row).eachCell((cell) => {
    const v = cellPrimitive(cell.value);
    const s = v === null ? '' : String(v).trim();
    if (s) out.push(s);
  });
  return out;
}

/** Строка заголовков для сообщения об ошибке: первая из первых строк, где не меньше двух ячеек. */
function shownHeaders(ws: ExcelJS.Worksheet): string[] {
  for (let r = 1; r <= Math.min(HEADER_SEARCH_ROWS, ws.rowCount); r++) {
    const h = headersOf(ws, r);
    if (h.length >= 2) return h;
  }
  return headersOf(ws, 1);
}

/**
 * Выгрузка реестра — скрытый лист «_поля» или колонка ID в первой строке листа с данными;
 * у реестра с ключом импорта (этап 8) — ещё и колонка ключа (например, выгрузка Device Monitor).
 * Отчёт сканера — по содержимому (ADR-0029): лист с колонками «Пакет» и «CVE» или «Идентификатор», без колонки ID.
 * Иначе — ошибка с перечнем того, что ожидалось и что найдено.
 */
export function detectFormat(wb: ExcelJS.Workbook, importKeyLabel?: string): FileFormat {
  const sheets = wb.worksheets;
  const data = sheets.filter((ws) => ws.name !== MAP_SHEET && ws.name !== HELP_SHEET);
  if (wb.getWorksheet(MAP_SHEET) || data.some((ws) => headersOf(ws, 1).some((h) => h.toLowerCase() === 'id'))) return 'records';
  const key = importKeyLabel?.trim().toLowerCase();
  if (key && data.some((ws) => headersOf(ws, 1).some((h) => h.toLowerCase() === key))) return 'records';
  if (data.some((ws) => headerMap(ws))) return 'scan';

  const found = sheets.length
    ? sheets.map((ws) => {
      const h = shownHeaders(ws);
      const cols = h.length ? h.slice(0, SHOW_COLUMNS).map((x) => `«${x}»`).join(', ') + (h.length > SHOW_COLUMNS ? ` и ещё ${h.length - SHOW_COLUMNS}` : '') : 'пусто';
      return `«${ws.name}»: ${cols}`;
    }).join('; ')
    : 'листов нет';
  throw badRequest('UNKNOWN_FORMAT',
    `Не удалось распознать файл. Ожидался отчёт сканера (лист с колонками «${SCAN_HEADERS.pkg}» и «${SCAN_HEADERS.cve}» или «Идентификатор») `
    + `или выгрузка реестра (колонка «ID»${importKeyLabel ? ` или колонка ключа «${importKeyLabel}»` : ''} или скрытый лист «${MAP_SHEET}» — файл из кнопки «Экспорт в Excel»). В файле: ${found}.`);
}
