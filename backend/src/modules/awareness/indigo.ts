// Разбор отчёта INDIGO «Статистика по баллам» (релиз 1.8.0, docs/specs/awareness.md, разделы 4.2–4.4, ADR-0037).
// Всё ищется по текстам, а не по номерам колонок и строк: формат известен по описанию, колонки сдвигаются.
// Ошибки называют, чего не нашлось. Результат — строки отчёта и сведения о полноте; в лист конвейера их переводит адаптер.
import { badRequest } from '../../lib/errors.js';
import { cellString, type SheetCell, type SheetData } from '../../lib/spreadsheetml.js';
import { parseNumberCell, parseSpent, parseTestDate } from './logic.js';

export const INDIGO_SHEET = 'Статистика по баллам';

/** Метки строк сводки (раздел 4.2): сравниваются без регистра, пробелов и «:». */
export const SUMMARY_LABELS = ['всего', 'верно', 'частично', 'неверно', 'пропущено', 'среднийбалл', 'максбалл', 'процент'] as const;
export type SummaryLabel = (typeof SUMMARY_LABELS)[number];

/** Числа строки сводки по группам вопросов: обычные, мультивыбор, итог. */
export interface SummaryGroups { regular: number | null; multi: number | null; total: number | null }

export interface IndigoRow {
  /** Номер строки в листе (с 1) — для сообщений. */
  line: number;
  /** Фамилия, имя, отчество через пробел, лишние пробелы убраны. */
  fio: string;
  /** Отчество есть: только такое ФИО сопоставляется автоматически (ADR-0038). */
  hasMiddleName: boolean;
  group: string;
  /** ГГГГ-ММ-ДД; null — ошибка строки. */
  date: string | null;
  spent: string | null;
  score: number | null;
  maxScore: number | null;
  /** Итоговый «Результат, %»; null — ошибка строки. */
  percent: number | null;
  regularPct: number | null;
  multiPct: number | null;
  /** Ошибки строки: строка не загружается. */
  errors: string[];
  /** Предупреждения строки: строка загружается. */
  warnings: string[];
}

export interface IndigoCompleteness {
  /** Строк в таблице (все, в том числе с ошибками). */
  rows: number;
  summaryTotal: number | null;
  summaryMax: number | null;
  summaryPercent: number | null;
  /** Средний «Результат, %» по строкам без ошибок, до 0,1. */
  rowsPercent: number | null;
  /** Строк с ошибками — в среднее не входят. */
  errorRows: number;
  /** Сверка «строки × МаксБалл = Всего»: true — сошлось, false — нет, null — не выполнена. */
  complete: boolean | null;
  /** Средние по сводке и по строкам расходятся больше чем на 0,5 п. п. */
  percentMismatch: boolean;
}

export interface IndigoReport {
  sheet: string;
  test: string;
  rows: IndigoRow[];
  summary: Partial<Record<SummaryLabel, SummaryGroups>>;
  completeness: IndigoCompleteness;
  /** Предупреждения отчёта целиком (полнота, данные после пустой строки). */
  warnings: string[];
}

const norm = (v: SheetCell | undefined) => cellString(v).toLowerCase();
const labelOf = (v: SheetCell | undefined) => norm(v).replace(/[\s:]/g, '');
const isEmptyRow = (r: SheetCell[] | undefined) => !r || r.every((c) => cellString(c) === '');
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Лист «Статистика по баллам» (без регистра и лишних пробелов); нет такого и лист один — он. */
export function findSheet(sheets: SheetData[]): SheetData {
  const want = INDIGO_SHEET.toLowerCase();
  const byName = sheets.find((s) => s.name.replace(/\s+/g, ' ').trim().toLowerCase() === want);
  if (byName) return byName;
  const [only] = sheets;
  if (sheets.length === 1 && only) return only;
  throw badRequest('INDIGO_NO_SHEET', `В книге нет листа «${INDIGO_SHEET}». Загрузите отчёт INDIGO «Статистика по баллам»`);
}

export interface HeaderColumns {
  row: number;
  no: number;
  last: number;
  first: number;
  middle: number | null;
  group: number | null;
  date: number;
  spent: number | null;
  /** Тройки «Б, М, %» слева направо: обычные вопросы, мультивыбор, итог. */
  triples: { b: number; m: number; p: number }[];
}

/**
 * Строка заголовков — первая, где есть ячейки «№» и «Фамилия». Тройка — «Б», за ним ближайшее «М», за ним ближайшее «%»;
 * пустые колонки между ними пропускаются. Нужны три тройки и колонки «Фамилия», «Имя», «Дата».
 */
export function findHeader(rows: SheetCell[][]): HeaderColumns {
  const rowIndex = rows.findIndex((r) => r.some((c) => norm(c) === '№') && r.some((c) => norm(c) === 'фамилия'));
  if (rowIndex < 0) throw badRequest('INDIGO_NO_HEADER', 'Не найдена строка заголовков таблицы: нужны ячейки «№» и «Фамилия»');
  const cells = (rows[rowIndex] ?? []).map(norm);
  const col = (text: string) => {
    const i = cells.indexOf(text);
    return i < 0 ? null : i;
  };
  const triples: HeaderColumns['triples'] = [];
  for (let i = 0; i < cells.length && triples.length < 3; i++) {
    if (cells[i] !== 'б') continue;
    const m = cells.indexOf('м', i + 1);
    const p = m < 0 ? -1 : cells.indexOf('%', m + 1);
    if (m < 0 || p < 0) break;
    triples.push({ b: i, m, p });
    i = p;
  }
  const missing: string[] = [];
  const last = col('фамилия');
  const first = col('имя');
  const date = col('дата');
  if (first === null) missing.push('«Имя»');
  if (date === null) missing.push('«Дата»');
  if (triples.length < 3) missing.push(`три группы колонок «Б, М, %» (найдено: ${triples.length})`);
  if (missing.length || last === null || first === null || date === null) {
    throw badRequest('INDIGO_NO_COLUMNS', `В строке заголовков ${rowIndex + 1} нет: ${missing.join(', ')}`);
  }
  return {
    row: rowIndex, no: col('№') ?? 0, last, first, middle: col('отчество'), group: col('группа'), date, spent: col('затрачено'), triples,
  };
}

/**
 * Сводка над строкой заголовков — по меткам строк (раздел 4.2). Числа — ячейки правее метки, слева направо: обычные,
 * мультивыбор, итог. Если над сводкой есть строка «Обычные вопросы» / «Мультивыбор вопросы», числа относятся к группам
 * по колонкам этой строки; итог — группа правее мультивыбора.
 */
export function findSummary(rows: SheetCell[][], headerRow: number): Partial<Record<SummaryLabel, SummaryGroups>> {
  const out: Partial<Record<SummaryLabel, SummaryGroups>> = {};
  // Начала групп по строке подписей групп (если есть): колонки непустых ячеек, начиная с «Обычные вопросы».
  let starts: number[] | null = null;
  for (let r = 0; r < headerRow; r++) {
    const cells = (rows[r] ?? []).map(norm);
    const reg = cells.findIndex((c) => c.startsWith('обычные вопросы'));
    const multi = cells.findIndex((c) => c.startsWith('мультивыбор'));
    if (reg >= 0 && multi > reg) {
      starts = cells.map((c, i) => (c && i >= reg ? i : -1)).filter((i) => i >= 0);
      break;
    }
  }
  for (let r = 0; r < headerRow; r++) {
    const row = rows[r] ?? [];
    const at = row.findIndex((c) => (SUMMARY_LABELS as readonly string[]).includes(labelOf(c)));
    if (at < 0) continue;
    const label = labelOf(row[at]) as SummaryLabel;
    if (out[label]) continue;
    const nums: { col: number; v: number }[] = [];
    for (let c = at + 1; c < row.length; c++) {
      const v = parseNumberCell(row[c]);
      if (v !== null) nums.push({ col: c, v });
    }
    out[label] = starts ? byGroups(nums, starts) : { regular: nums[0]?.v ?? null, multi: nums[1]?.v ?? null, total: nums[2]?.v ?? null };
  }
  return out;
}

function byGroups(nums: { col: number; v: number }[], starts: number[]): SummaryGroups {
  const [s0 = 0, s1 = Infinity, s2] = starts;
  const inRange = (from: number, to: number) => nums.find((n) => n.col >= from && n.col < to)?.v ?? null;
  const multiCell = nums.find((n) => n.col >= s1 && n.col < (s2 ?? Infinity));
  // Подписи итога нет — итог: первое число правее числа мультивыбора.
  const total = s2 !== undefined ? inRange(s2, Infinity) : (multiCell ? nums.find((n) => n.col > multiCell.col)?.v ?? null : null);
  return { regular: inRange(s0, s1), multi: multiCell?.v ?? null, total };
}

/** Строка данных (раздел 4.3). */
function parseRow(row: SheetCell[], line: number, h: HeaderColumns): IndigoRow {
  const text = (c: number | null) => (c === null ? '' : cellString(row[c]));
  const last = text(h.last);
  const first = text(h.first);
  const middle = text(h.middle);
  const fio = [last, first, middle].filter(Boolean).join(' ');
  const [regular, multi, total] = h.triples;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!last && !first) errors.push('Нет ФИО');
  const dateCell = row[h.date];
  const date = parseTestDate(dateCell);
  if (date === null) errors.push(cellString(dateCell) ? `Дата «${cellString(dateCell)}» не распознана` : 'Нет даты');
  const percent = total ? parseNumberCell(row[total.p]) : null;
  if (percent === null) errors.push(cellString(total ? row[total.p] : null) ? `«Результат, %» не число: «${cellString(total ? row[total.p] : null)}»` : 'Нет «Результата, %»');
  const spent = h.spent === null ? { text: null, warning: false } : parseSpent(row[h.spent]);
  if (spent.warning) warnings.push(`Затраченное время «${spent.text}» не в формате ЧЧ:ММ:СС — сохранено как есть`);
  return {
    line, fio, hasMiddleName: middle !== '', group: text(h.group), date, spent: spent.text,
    score: total ? parseNumberCell(row[total.b]) : null,
    maxScore: total ? parseNumberCell(row[total.m]) : null,
    percent,
    regularPct: regular ? parseNumberCell(row[regular.p]) : null,
    multiPct: multi ? parseNumberCell(row[multi.p]) : null,
    errors, warnings,
  };
}

/** Проверка полноты (раздел 4.4): строки × МаксБалл итога = Всего итога; средний процент сводки и строк. */
export function completenessOf(rows: IndigoRow[], summary: IndigoReport['summary']): { completeness: IndigoCompleteness; warnings: string[] } {
  const warnings: string[] = [];
  const total = summary.всего?.total ?? null;
  const max = summary.максбалл?.total ?? null;
  const summaryPercent = summary.процент?.total ?? null;
  const ok = rows.filter((r) => !r.errors.length && r.percent !== null);
  const rowsPercent = ok.length ? round1(ok.reduce((s, r) => s + (r.percent ?? 0), 0) / ok.length) : null;
  let complete: boolean | null = null;
  if (total === null || max === null) {
    warnings.push('Сводка не найдена — полнота не проверена');
  } else if (max === 0) {
    warnings.push('В сводке «МаксБалл» равен 0 — полнота не проверена');
  } else {
    complete = rows.length * max === total;
    if (!complete) {
      const attempts = Math.round((total / max) * 10) / 10;
      warnings.push(`Отчёт может быть неполным: по сводке ${total} ответов (это ${String(attempts).replace('.', ',')} попыток), в таблице ${rows.length} строк`);
    }
  }
  const percentMismatch = summaryPercent !== null && rowsPercent !== null && Math.abs(summaryPercent - rowsPercent) > 0.5;
  return {
    completeness: {
      rows: rows.length, summaryTotal: total, summaryMax: max, summaryPercent, rowsPercent,
      errorRows: rows.length - ok.length, complete, percentMismatch,
    },
    warnings,
  };
}

/** Отчёт INDIGO из листов книги. Ошибка формата — 400 с тем, чего не нашлось; ошибки строк — в самих строках. */
export function parseIndigoReport(sheets: SheetData[]): IndigoReport {
  const sheet = findSheet(sheets);
  const rows = sheet.rows;
  const test = (rows[0] ?? []).map(cellString).find(Boolean) ?? '';
  if (!test) throw badRequest('INDIGO_NO_TEST', 'В первой строке нет названия теста');
  const h = findHeader(rows);
  const summary = findSummary(rows, h.row);
  const warnings: string[] = [];
  const data: IndigoRow[] = [];
  let r = h.row + 1;
  for (; r < rows.length && !isEmptyRow(rows[r]); r++) data.push(parseRow(rows[r] ?? [], r + 1, h));
  if (rows.slice(r + 1).some((row) => !isEmptyRow(row))) {
    warnings.push(`После пустой строки ${r + 1} есть ещё данные — они не загружены`);
  }
  if (!data.length) throw badRequest('INDIGO_NO_ROWS', 'Под строкой заголовков нет ни одной строки с результатами');
  const c = completenessOf(data, summary);
  return { sheet: sheet.name, test, rows: data, summary, completeness: c.completeness, warnings: [...warnings, ...c.warnings] };
}
