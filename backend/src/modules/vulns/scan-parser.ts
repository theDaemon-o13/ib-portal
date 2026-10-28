// Разбор отчёта сканера (.xlsx) без БД: лист уязвимостей, лист «Хосты», дата из имени файла.
// Лист уязвимостей распознаётся по заголовкам «Пакет» и «CVE»; колонки — по названию, в любом порядке.
import ExcelJS from 'exceljs';
import { badRequest } from '../../lib/errors.js';
import { cellPrimitive, formatDateRu, isIsoDate, parseNumberText, TEXT_MAX } from '../../lib/register-values.js';

export const SCAN_MAX_ROWS = 20_000;
export const HOSTS_SHEET = 'хосты';
/** Строки, среди которых ищется строка заголовков (над таблицей бывает шапка отчёта). */
const HEADER_SEARCH_ROWS = 10;

export type ScanColumn = 'pkg' | 'cve' | 'level' | 'cvss' | 'exploit' | 'vector' | 'fixVersion' | 'desc' | 'hits';

export const SCAN_HEADERS: Record<ScanColumn, string> = {
  pkg: 'Пакет',
  cve: 'CVE',
  level: 'Уровень',
  cvss: 'CVSS',
  exploit: 'Эксплойт',
  vector: 'Сетевой вектор',
  fixVersion: 'Обновить до версии',
  desc: 'Краткое описание',
  hits: 'Обнаружений',
};

export interface ScanRow {
  /** Номер строки на листе (для сообщений). */
  row: number;
  pkg: string;
  cve: string;
  level: string | null;
  cvss: number | null;
  exploit: string | null;
  vector: string | null;
  fixVersion: string | null;
  desc: string | null;
  hits: number | null;
}

export interface ScanHostRow {
  name: string;
  ip: string;
  os: string;
}

export interface ScanIssue {
  row: number;
  field: string | null;
  message: string;
}

export interface ParsedScan {
  sheet: string;
  /** Ячейка A1 листа «Хосты» — отдел. */
  department: string;
  hosts: ScanHostRow[];
  rows: ScanRow[];
  errors: ScanIssue[];
  warnings: string[];
  /** Дата отчёта из имени файла (ГГГГ-ММ-ДД) или null — тогда её вводят в предпросмотре. */
  reportDate: string | null;
}

export const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
/**
 * Отдел для сравнения (релиз 1.1.0): без регистра и лишних пробелов, «ё» = «е». Только для сравнения —
 * хранится и показывается так, как написано в отчёте.
 */
export const deptKey = (s: string) => norm(s).replace(/ё/g, 'е');

function text(cell: unknown): string | null {
  const v = cellPrimitive(cell);
  if (v === null) return null;
  const s = (v instanceof Date ? formatDateRu(v.toISOString().slice(0, 10)) : String(v)).trim();
  return s === '' ? null : s;
}

/** Дата отчёта в имени файла: «Отчёт 2026-10-15.xlsx» → 2026-10-15. */
export function reportDateFromFileName(fileName: string): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(fileName);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isIsoDate(iso) ? iso : null;
}

export function headerMap(ws: ExcelJS.Worksheet): { row: number; cols: Map<ScanColumn, number> } | null {
  for (let r = 1; r <= Math.min(HEADER_SEARCH_ROWS, ws.rowCount); r++) {
    const cols = new Map<ScanColumn, number>();
    ws.getRow(r).eachCell((cell, col) => {
      const h = text(cell.value);
      if (!h) return;
      const key = (Object.keys(SCAN_HEADERS) as ScanColumn[]).find((k) => norm(SCAN_HEADERS[k]) === norm(h));
      if (key && !cols.has(key)) cols.set(key, col);
    });
    if (cols.has('pkg') && cols.has('cve')) return { row: r, cols };
  }
  return null;
}

function parseHosts(ws: ExcelJS.Worksheet, warnings: string[]): { department: string; hosts: ScanHostRow[] } {
  let headerRow = 0;
  const cols = { name: 0, ip: 0, os: 0 };
  for (let r = 1; r <= Math.min(HEADER_SEARCH_ROWS, ws.rowCount) && !headerRow; r++) {
    ws.getRow(r).eachCell((cell, col) => {
      const h = norm(text(cell.value) ?? '');
      if (h === 'имя хоста') {
        headerRow = r;
        cols.name = col;
      } else if (h === 'ip-адрес' || h === 'ip адрес' || h === 'ip') cols.ip = col;
      else if (h === 'ос') cols.os = col;
    });
  }
  const a1 = text(ws.getCell('A1').value) ?? '';
  // A1 — отдел, если это не сама строка заголовков.
  const department = headerRow === 1 ? '' : a1.slice(0, 200);
  if (!headerRow) {
    warnings.push('На листе «Хосты» нет колонки «Имя хоста» — хосты не сохранятся');
    return { department, hosts: [] };
  }
  const hosts: ScanHostRow[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = text(row.getCell(cols.name).value);
    if (!name) continue;
    hosts.push({
      name: name.slice(0, 255),
      ip: cols.ip ? (text(row.getCell(cols.ip).value) ?? '').slice(0, 100) : '',
      os: cols.os ? (text(row.getCell(cols.os).value) ?? '').slice(0, 255) : '',
    });
  }
  return { department, hosts };
}

export async function parseScanReport(buffer: Buffer, fileName: string): Promise<ParsedScan> {
  if (buffer.length === 0) throw badRequest('BAD_FILE', 'Файл пустой');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw badRequest('BAD_FILE', 'Не удалось прочитать файл. Нужна книга Excel (.xlsx)');
  }
  let found: { ws: ExcelJS.Worksheet; row: number; cols: Map<ScanColumn, number> } | null = null;
  for (const ws of wb.worksheets) {
    if (norm(ws.name) === HOSTS_SHEET) continue;
    const h = headerMap(ws);
    if (h) {
      found = { ws, ...h };
      break;
    }
  }
  if (!found) {
    throw badRequest('NOT_SCAN_REPORT', 'Это не отчёт сканера: нет листа с колонками «Пакет» и «CVE». Обычный файл реестра загружайте кнопкой «Импорт из Excel»');
  }
  const { ws, cols } = found;
  if (ws.rowCount - found.row > SCAN_MAX_ROWS) throw badRequest('TOO_MANY_ROWS', `В отчёте больше ${SCAN_MAX_ROWS} строк`);

  const warnings: string[] = [];
  const missing = (Object.keys(SCAN_HEADERS) as ScanColumn[]).filter((k) => !cols.has(k));
  if (missing.length) warnings.push(`Нет колонок: ${missing.map((k) => `«${SCAN_HEADERS[k]}»`).join(', ')} — эти поля останутся пустыми`);

  const rows: ScanRow[] = [];
  const errors: ScanIssue[] = [];
  for (let r = found.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k: ScanColumn) => (cols.has(k) ? row.getCell(cols.get(k) as number).value : null);
    const values = (Object.keys(SCAN_HEADERS) as ScanColumn[]).map((k) => text(get(k)));
    if (values.every((v) => v === null)) continue;
    const rowErrors: ScanIssue[] = [];
    const pkg = text(get('pkg'));
    const cve = text(get('cve'));
    if (!pkg) rowErrors.push({ row: r, field: SCAN_HEADERS.pkg, message: 'Не указан пакет' });
    if (!cve) rowErrors.push({ row: r, field: SCAN_HEADERS.cve, message: 'Не указан идентификатор уязвимости (CVE или БДУ)' });
    const num = (k: ScanColumn): number | null | 'bad' => {
      const v = cellPrimitive(get(k));
      if (v === null) return null;
      if (typeof v === 'number') return v;
      if (v instanceof Date) return 'bad';
      return parseNumberText(v) ?? 'bad';
    };
    const cvss = num('cvss');
    if (cvss === 'bad' || (typeof cvss === 'number' && (cvss < 0 || cvss > 10))) {
      rowErrors.push({ row: r, field: SCAN_HEADERS.cvss, message: `CVSS — число от 0 до 10, в файле «${text(get('cvss')) ?? ''}»` });
    }
    const hits = num('hits');
    if (hits === 'bad' || (typeof hits === 'number' && (!Number.isInteger(hits) || hits < 0))) {
      rowErrors.push({ row: r, field: SCAN_HEADERS.hits, message: `«Обнаружений» — целое число, в файле «${text(get('hits')) ?? ''}»` });
    }
    const long = (Object.keys(SCAN_HEADERS) as ScanColumn[]).find((k) => (text(get(k)) ?? '').length > TEXT_MAX);
    if (long) rowErrors.push({ row: r, field: SCAN_HEADERS[long], message: `Не длиннее ${TEXT_MAX} символов` });
    if (rowErrors.length) {
      errors.push(...rowErrors);
      continue;
    }
    rows.push({
      row: r,
      pkg: pkg as string,
      cve: cve as string,
      level: text(get('level')),
      cvss: typeof cvss === 'number' ? cvss : null,
      exploit: text(get('exploit')),
      vector: text(get('vector')),
      fixVersion: text(get('fixVersion')),
      desc: text(get('desc')),
      hits: typeof hits === 'number' ? hits : null,
    });
  }

  const hostsSheet = wb.worksheets.find((w) => norm(w.name) === HOSTS_SHEET);
  let department = '';
  let hosts: ScanHostRow[] = [];
  if (hostsSheet) ({ department, hosts } = parseHosts(hostsSheet, warnings));
  else warnings.push('В книге нет листа «Хосты» — отчёт сохранится без списка хостов');

  return { sheet: ws.name, department, hosts, rows, errors, warnings, reportDate: reportDateFromFileName(fileName) };
}

/** Ключ дубля: «CVE + пакет» без учёта регистра и лишних пробелов. */
export function dupKey(cve: string, pkg: string): string {
  return `${norm(cve)}\u0000${norm(pkg)}`;
}
