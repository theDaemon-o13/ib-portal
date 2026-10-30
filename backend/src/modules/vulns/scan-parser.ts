// Разбор отчёта сканера (.xlsx) без БД — по содержимому листов, а не по их названиям (релиз 1.5.0, ADR-0029).
// Лист хостов — где в первых 12 строках есть «Имя хоста»; строка над заголовком — охват скана.
// Листы находок — все листы с колонками «Пакет» и «CVE» (или «Идентификатор…»); несколько листов объединяются.
// Колонки — по названию, в любом порядке. «Оценка» из файла не читается: её считает портал (п. 7.1).
import ExcelJS from 'exceljs';
import { badRequest } from '../../lib/errors.js';
import { cellPrimitive, formatDateRu, isIsoDate, parseNumberText, TEXT_MAX } from '../../lib/register-values.js';

export const SCAN_MAX_ROWS = 20_000;
/** Строки, среди которых ищется строка заголовков (над таблицей бывает шапка отчёта). */
export const HEADER_SEARCH_ROWS = 12;

export type ScanColumn = 'pkg' | 'cve' | 'level' | 'cvss' | 'exploit' | 'vector' | 'fixVersion' | 'desc' | 'hits';

/** Подписи колонок для сообщений. */
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

/** Распознавание заголовка колонки находок: точное название или начало (нормализованные). */
const HEADER_MATCH: Record<ScanColumn, { exact: string[]; prefix?: string[] }> = {
  pkg: { exact: ['пакет'] },
  cve: { exact: ['cve'], prefix: ['идентификатор'] },
  level: { exact: ['уровень'] },
  cvss: { exact: ['cvss'] },
  exploit: { exact: ['эксплойт'] },
  vector: { exact: ['сетевой вектор'] },
  fixVersion: { exact: ['обновить до версии'], prefix: ['обновить до'] },
  desc: { exact: ['краткое описание', 'описание'] },
  hits: { exact: ['обнаружений'] },
};

export interface ScanRow {
  /** Лист и номер строки на нём (для сообщений). */
  sheet: string;
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
  sheet?: string;
  row: number;
  field: string | null;
  message: string;
}

export interface ParsedScan {
  /** Листы находок и число строк с каждого. */
  sheets: { name: string; rows: number }[];
  /** Первый лист находок (для сообщений прежнего формата). */
  sheet: string;
  /** Охват скана — строка над заголовком листа хостов («Отдел платёжных карт»); пусто, если её нет. */
  coverageTitle: string;
  /** То же, что coverageTitle: так называлось до 1.5.0 (ячейка A1 листа «Хосты»). */
  department: string;
  hostsSheet: string | null;
  hosts: ScanHostRow[];
  rows: ScanRow[];
  /** Строки, пропущенные целиком (нет пакета или идентификатора, слишком длинный текст). */
  errors: ScanIssue[];
  /** Строки, которые загрузятся, но со значением, заменённым на пустое (CVSS или «Обнаружений» не число). */
  notes: ScanIssue[];
  warnings: string[];
  /** Дата скана из имени файла (ГГГГ_ММ_ДД, ГГГГ-ММ-ДД, ГГГГ.ММ.ДД) или null — тогда её вводят в предпросмотре. */
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

/** Дата скана в имени файла: «Отчёт_Windows_2026_10_15.xlsx», «… 2026-10-15», «… 2026.10.15» → 2026-10-15. */
export function reportDateFromFileName(fileName: string): string | null {
  const m = /(\d{4})[_\-.](\d{2})[_\-.](\d{2})/.exec(fileName);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isIsoDate(iso) ? iso : null;
}

function columnOf(header: string): ScanColumn | undefined {
  const h = norm(header);
  return (Object.keys(HEADER_MATCH) as ScanColumn[]).find((k) => HEADER_MATCH[k].exact.includes(h) || (HEADER_MATCH[k].prefix ?? []).some((p) => h.startsWith(p)));
}

/** Строка заголовков листа находок: есть «Пакет» и «CVE» / «Идентификатор». */
export function headerMap(ws: ExcelJS.Worksheet): { row: number; cols: Map<ScanColumn, number> } | null {
  for (let r = 1; r <= Math.min(HEADER_SEARCH_ROWS, ws.rowCount); r++) {
    const cols = new Map<ScanColumn, number>();
    ws.getRow(r).eachCell((cell, col) => {
      const h = text(cell.value);
      const key = h ? columnOf(h) : undefined;
      if (key && !cols.has(key)) cols.set(key, col);
    });
    if (cols.has('pkg') && cols.has('cve')) return { row: r, cols };
  }
  return null;
}

/** Строка заголовков листа хостов: колонка «Имя хоста». */
export function hostsHeader(ws: ExcelJS.Worksheet): { row: number; name: number; ip: number; os: number } | null {
  for (let r = 1; r <= Math.min(HEADER_SEARCH_ROWS, ws.rowCount); r++) {
    const found = { row: r, name: 0, ip: 0, os: 0 };
    ws.getRow(r).eachCell((cell, col) => {
      const h = norm(text(cell.value) ?? '');
      if (h === 'имя хоста') found.name = col;
      else if (h.startsWith('ip') && !found.ip) found.ip = col;
      else if ((h === 'ос' || h.startsWith('операц')) && !found.os) found.os = col;
    });
    if (found.name) return found;
  }
  return null;
}

function parseHosts(ws: ExcelJS.Worksheet, h: NonNullable<ReturnType<typeof hostsHeader>>): { coverageTitle: string; hosts: ScanHostRow[] } {
  // Охват — ближайшая непустая строка над заголовком: первая непустая ячейка.
  let coverageTitle = '';
  for (let r = h.row - 1; r >= 1 && !coverageTitle; r--) {
    ws.getRow(r).eachCell((cell) => {
      if (!coverageTitle) coverageTitle = (text(cell.value) ?? '').slice(0, 200);
    });
  }
  const hosts: ScanHostRow[] = [];
  for (let r = h.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = text(row.getCell(h.name).value);
    if (!name) continue;
    hosts.push({
      name: name.slice(0, 255),
      ip: h.ip ? (text(row.getCell(h.ip).value) ?? '').slice(0, 100) : '',
      os: h.os ? (text(row.getCell(h.os).value) ?? '').slice(0, 255) : '',
    });
  }
  return { coverageTitle, hosts };
}

export async function readScanWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  if (buffer.length === 0) throw badRequest('BAD_FILE', 'Файл пустой');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw badRequest('BAD_FILE', 'Не удалось прочитать файл. Нужна книга Excel (.xlsx)');
  }
  return wb;
}

export async function parseScanReport(buffer: Buffer, fileName: string): Promise<ParsedScan> {
  const wb = await readScanWorkbook(buffer);
  const hostsWs = wb.worksheets.map((ws) => ({ ws, h: hostsHeader(ws) })).find((x) => x.h);
  const finding = wb.worksheets
    .filter((ws) => ws !== hostsWs?.ws)
    .map((ws) => ({ ws, h: headerMap(ws) }))
    .filter((x): x is { ws: ExcelJS.Worksheet; h: NonNullable<ReturnType<typeof headerMap>> } => !!x.h);
  if (!finding.length) {
    throw badRequest('NOT_SCAN_REPORT', 'Это не отчёт сканера: нет листа с колонками «Пакет» и «CVE» (или «Идентификатор»). Выгрузку реестра загружайте кнопкой «Импорт из Excel» на странице «Реестры»');
  }
  const total = finding.reduce((n, f) => n + Math.max(0, f.ws.rowCount - f.h.row), 0);
  if (total > SCAN_MAX_ROWS) throw badRequest('TOO_MANY_ROWS', `В отчёте больше ${SCAN_MAX_ROWS} строк`);

  const warnings: string[] = [];
  const rows: ScanRow[] = [];
  const errors: ScanIssue[] = [];
  const notes: ScanIssue[] = [];
  const sheets: ParsedScan['sheets'] = [];
  for (const { ws, h } of finding) {
    const { cols } = h;
    const missing = (Object.keys(SCAN_HEADERS) as ScanColumn[]).filter((k) => !cols.has(k));
    if (missing.length) warnings.push(`Лист «${ws.name}»: нет колонок ${missing.map((k) => `«${SCAN_HEADERS[k]}»`).join(', ')} — эти поля останутся пустыми`);
    let count = 0;
    for (let r = h.row + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (k: ScanColumn) => (cols.has(k) ? row.getCell(cols.get(k) as number).value : null);
      if ((Object.keys(SCAN_HEADERS) as ScanColumn[]).every((k) => text(get(k)) === null)) continue;
      const at = { sheet: ws.name, row: r };
      const pkg = text(get('pkg'));
      const cve = text(get('cve'));
      if (!pkg || !cve) {
        errors.push({ ...at, field: !pkg ? SCAN_HEADERS.pkg : SCAN_HEADERS.cve, message: !pkg ? 'Нет пакета — строка пропущена' : 'Нет идентификатора (CVE или БДУ) — строка пропущена' });
        continue;
      }
      const long = (Object.keys(SCAN_HEADERS) as ScanColumn[]).find((k) => (text(get(k)) ?? '').length > TEXT_MAX);
      if (long) {
        errors.push({ ...at, field: SCAN_HEADERS[long], message: `Не длиннее ${TEXT_MAX} символов — строка пропущена` });
        continue;
      }
      const num = (k: ScanColumn): number | null | 'bad' => {
        const v = cellPrimitive(get(k));
        if (v === null) return null;
        if (typeof v === 'number') return v;
        if (v instanceof Date) return 'bad';
        return parseNumberText(v) ?? 'bad';
      };
      let cvss = num('cvss');
      if (cvss === 'bad' || (typeof cvss === 'number' && (cvss < 0 || cvss > 10))) {
        notes.push({ ...at, field: SCAN_HEADERS.cvss, message: `CVSS «${text(get('cvss')) ?? ''}» не число от 0 до 10 — считается пустым` });
        cvss = null;
      }
      let hits = num('hits');
      if (hits === 'bad' || (typeof hits === 'number' && (!Number.isInteger(hits) || hits < 0))) {
        notes.push({ ...at, field: SCAN_HEADERS.hits, message: `«Обнаружений» «${text(get('hits')) ?? ''}» не целое число — считается пустым` });
        hits = null;
      }
      rows.push({
        ...at, pkg, cve,
        level: text(get('level')),
        cvss,
        exploit: text(get('exploit')),
        vector: text(get('vector')),
        fixVersion: text(get('fixVersion')),
        desc: text(get('desc')),
        hits,
      });
      count++;
    }
    sheets.push({ name: ws.name, rows: count });
  }

  let coverageTitle = '';
  let hosts: ScanHostRow[] = [];
  if (hostsWs?.h) ({ coverageTitle, hosts } = parseHosts(hostsWs.ws, hostsWs.h));
  else warnings.push('В книге нет листа с колонкой «Имя хоста» — охват скана не сохранится');

  return {
    sheets, sheet: finding[0]?.ws.name ?? '', coverageTitle, department: coverageTitle, hostsSheet: hostsWs?.ws.name ?? null,
    hosts, rows, errors, notes, warnings, reportDate: reportDateFromFileName(fileName),
  };
}

/** Ключ дубля: «CVE + пакет» без учёта регистра и лишних пробелов (сравнение строк файла между собой). */
export function dupKey(cve: string, pkg: string): string {
  return `${norm(cve)}\u0000${norm(pkg)}`;
}

/** Повтор ключа в файле — одна строка, «Обнаружений» — большее (первая строка остаётся, её номер — в сообщениях). */
export function mergeDuplicates(rows: readonly ScanRow[]): { unique: ScanRow[]; duplicates: number } {
  const byKey = new Map<string, ScanRow>();
  let duplicates = 0;
  for (const r of rows) {
    const key = dupKey(r.cve, r.pkg);
    const first = byKey.get(key);
    if (!first) {
      byKey.set(key, { ...r });
      continue;
    }
    duplicates++;
    if (r.hits !== null && (first.hits === null || r.hits > first.hits)) first.hits = r.hits;
  }
  return { unique: [...byKey.values()], duplicates };
}
