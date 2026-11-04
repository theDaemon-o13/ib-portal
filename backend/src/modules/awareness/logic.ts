// Осведомлённость (релиз 1.8.0, docs/specs/awareness.md): чистая логика без БД — ФИО, ключ попытки, оценка по порогам,
// разбор даты, времени и процента из отчёта INDIGO, выбор лучшей попытки дня. Одна нормализация ФИО для адаптера,
// ключа попытки и пересчёта по сотрудникам (ADR-0038).
import type { SheetCell } from '../../lib/spreadsheetml.js';
import { normalizeDimensionText } from '../../lib/text-dimension.js';
import { parseDateText, parseNumberText } from '../../lib/register-values.js';
import type { GradeSettings } from './grades.js';

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** ФИО для сравнения: без регистра, лишние пробелы схлопываются, по краям убираются, «ё» → «е» — то же правило, что у текстового измерения. */
export function normalizeFio(s: string): string {
  return normalizeDimensionText(s);
}

export interface FioParts {
  lastName: string;
  firstName: string;
  middleName: string;
}

/** Последнее слово отчества из двух слов: «Алиевич оглы» — не составная фамилия (раздел 2.2). */
export const PATRONYMIC_SUFFIXES: readonly string[] = ['оглы', 'кызы', 'угли', 'кизи', 'зода'];

/**
 * ФИО одной строкой → фамилия, имя, отчество (раздел 2.2): ровно три части; четыре — если последняя «оглы», «кызы»,
 * «угли», «кизи» или «зода» (отчество из двух последних). Иначе null: ФИО остаётся целиком, части пустые.
 * Двойная фамилия через дефис — одна часть.
 */
export function splitFio(full: string): FioParts | null {
  const parts = collapse(full).split(' ').filter(Boolean);
  const [last = '', first = '', middle = '', tail = ''] = parts;
  if (parts.length === 3) return { lastName: last, firstName: first, middleName: middle };
  if (parts.length === 4 && PATRONYMIC_SUFFIXES.includes(tail.toLowerCase())) {
    return { lastName: last, firstName: first, middleName: `${middle} ${tail}` };
  }
  return null;
}

/** Обратный случай: «Фамилия Имя Отчество» через пробел из заполненных частей. */
export function joinFio(p: Partial<FioParts>): string {
  return [p.lastName, p.firstName, p.middleName].map((s) => collapse(s ?? '')).filter(Boolean).join(' ');
}

/**
 * Ключ попытки (раздел 3.1): «<тест> | <нормализованное ФИО> | <ГГГГ-ММ-ДД>». Пересдача в другой день — другой ключ.
 * Конвейер дополнительно сравнивает ключи без регистра (register_import_key).
 */
export function attemptKey(test: string, fio: string, isoDate: string): string {
  return `${collapse(test)} | ${normalizeFio(fio)} | ${isoDate}`;
}

export const GRADES = ['excellent', 'good', 'satisfactory', 'fail'] as const;
export type Grade = (typeof GRADES)[number];
export const GRADE_LABELS: Record<Grade, string> = {
  excellent: 'Отлично', good: 'Хорошо', satisfactory: 'Удовлетворительно', fail: 'Провал',
};

/** Оценка по порогам (раздел 3.2). Процент сравнивается как есть, без округления: 89,9 при пороге 90 — «Хорошо». */
export function gradeOf(percent: number, g: GradeSettings): Grade {
  if (percent >= g.excellent) return 'excellent';
  if (percent >= g.good) return 'good';
  if (percent >= g.satisfactory) return 'satisfactory';
  return 'fail';
}

/** «На пересдачу»: процент ниже отдельного порога retakeBelow. */
export function needsRetake(percent: number, g: GradeSettings): boolean {
  return percent < g.retakeBelow;
}

/**
 * Дата теста (раздел 4.3): текст ДД.ММ.ГГГГ (или ГГГГ-ММ-ДД) либо ячейка-дата Excel — при пересохранении в .xlsx
 * Excel может превратить текст в дату. Несуществующая (31.02) или нераспознанная — null (ошибка строки).
 */
export function parseTestDate(cell: SheetCell | undefined): string | null {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell.toISOString().slice(0, 10);
  if (typeof cell === 'string') return parseDateText(cell);
  return null;
}

/** Начало отсчёта времени Excel: ячейка «время» в exceljs — дата от 30.12.1899 (UTC). */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
/** Время Excel больше 10 суток — уже не «затрачено», а дата: такое значение не переводится. */
const MAX_SPENT_SECONDS = 10 * 86_400;

const hms = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
};

/**
 * «Затрачено» (раздел 4.3): текст ЧЧ:ММ:СС — как есть; время Excel (доля суток или ячейка-время) — в ЧЧ:ММ:СС;
 * другое — сохраняется текстом, warning: true (предупреждение в предпросмотре).
 */
export function parseSpent(cell: SheetCell | undefined): { text: string | null; warning: boolean } {
  if (cell === null || cell === undefined) return { text: null, warning: false };
  if (typeof cell === 'number') {
    if (Number.isFinite(cell) && cell >= 0 && cell * 86_400 < MAX_SPENT_SECONDS) return { text: hms(Math.round(cell * 86_400)), warning: false };
    return { text: String(cell), warning: true };
  }
  if (cell instanceof Date) {
    const seconds = Math.round((cell.getTime() - EXCEL_EPOCH_MS) / 1000);
    if (seconds >= 0 && seconds < MAX_SPENT_SECONDS) return { text: hms(seconds), warning: false };
    return { text: Number.isNaN(cell.getTime()) ? null : cell.toISOString(), warning: true };
  }
  const t = collapse(cell);
  if (!t) return { text: null, warning: false };
  return { text: t, warning: !/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(t) };
}

/** Число из ячейки отчёта: число как есть; текст — запятая или точка, знак «%» отбрасывается. Иначе null. */
export function parseNumberCell(cell: SheetCell | undefined): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  if (typeof cell === 'string') return parseNumberText(cell.replace(/%/g, ''));
  return null;
}

/**
 * Повторы в один день (решение владельца 3): по ключу попытки остаётся попытка с большим «Результатом, %», при равном —
 * первая по порядку в файле. Остальные — repeats (блок предпросмотра «Повторы в один день»). Порядок kept — как в файле.
 * Ключи сравниваются без регистра, как register_import_key().
 */
export function pickBestOfDay<T extends { key: string; percent: number }>(rows: readonly T[]): { kept: T[]; repeats: T[] } {
  const best = new Map<string, number>();
  rows.forEach((r, i) => {
    const k = r.key.toLowerCase();
    const cur = best.get(k);
    if (cur === undefined || r.percent > (rows[cur]?.percent ?? -Infinity)) best.set(k, i);
  });
  const kept: T[] = [];
  const repeats: T[] = [];
  rows.forEach((r, i) => (best.get(r.key.toLowerCase()) === i ? kept : repeats).push(r));
  return { kept, repeats };
}
