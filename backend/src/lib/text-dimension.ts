// Текстовое поле с ролью «измерение» (релиз 1.8.0, docs/specs/awareness.md, раздел 7.1): значения группируются и
// фильтруются после нормализации — без регистра, лишних пробелов и «ё»/«е». Одно правило в коде и в SQL: число полосы
// виджета и total списка по её ссылке совпадают. Неразрывный пробел — тоже пробел.
import { Prisma } from '../generated/prisma/client.js';

/** Сколько значений в виджете отдельными полосами; остальные — «Остальные: N». */
export const TEXT_DIMENSION_TOP = 12;
/** Длина значения фильтра f= по тексту. */
export const TEXT_FILTER_MAX = 500;

export function normalizeDimensionText(s: string): string {
  return s.replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
}

/** То же в SQL для выражения-текста (значение поля записи). */
export function normalizedTextSql(expr: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`translate(lower(btrim(regexp_replace(${expr}, '[[:space:]\u00a0]+', ' ', 'g'))), 'ё', 'е')`;
}

export interface TextDimensionRow { key: string; label: string; count: number }

/**
 * Полосы виджета по текстовому измерению из пар «исходное значение → число записей»: группировка по нормализованному
 * значению, подпись — самое частое написание (при равенстве — первое по алфавиту), 12 самых частых, затем «Остальные».
 */
export function textDimensionRows(raw: readonly { value: string; count: number }[], top = TEXT_DIMENSION_TOP): { rows: TextDimensionRow[]; others: number; othersValues: number } {
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const { value, count } of raw) {
    const key = normalizeDimensionText(value);
    if (!key) continue;
    const g = groups.get(key) ?? { count: 0, spellings: new Map<string, number>() };
    g.count += count;
    const shown = value.replace(/[\s\u00a0]+/g, ' ').trim();
    g.spellings.set(shown, (g.spellings.get(shown) ?? 0) + count);
    groups.set(key, g);
  }
  const all = [...groups.entries()].map(([key, g]) => {
    const [label = key] = [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru')).map(([s]) => s);
    return { key, label, count: g.count };
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru'));
  const rest = all.slice(top);
  return { rows: all.slice(0, top), others: rest.reduce((s, r) => s + r.count, 0), othersValues: rest.length };
}
