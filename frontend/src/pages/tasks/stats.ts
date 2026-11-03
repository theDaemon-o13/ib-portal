// Отчёт по выполненным задачам (1.6.4): периоды, шкалы и сортировка списка без React — проверяются юнит-тестами.
import type { TaskStats } from '../../api/tasks';

export const PRESETS = [
  { key: 'month', title: 'Этот месяц' },
  { key: 'prev', title: 'Прошлый месяц' },
  { key: 'quarter', title: 'Квартал' },
  { key: 'year', title: 'Год' },
] as const;
export type Preset = (typeof PRESETS)[number]['key'];

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** Период по кнопке: с первого дня (месяца, квартала, года) по сегодня; прошлый месяц — целиком. */
export function presetRange(p: Preset, today: string): { from: string; to: string } {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1];
  if (p === 'prev') return { from: iso(y, m - 1, 1), to: iso(y, m, 0) };
  if (p === 'quarter') return { from: iso(y, m - (m % 3), 1), to: today };
  if (p === 'year') return { from: iso(y, 0, 1), to: today };
  return { from: iso(y, m, 1), to: today };
}

/** Какая кнопка периода совпадает с выбранными датами (подсветка). */
export function presetOf(from: string, to: string, today: string): Preset | null {
  return PRESETS.find((p) => { const r = presetRange(p.key, today); return r.from === from && r.to === to; })?.key ?? null;
}

/** Доля в процентах без дробной части; из нуля — null («—»). */
export const pct = (part: number, total: number): number | null => (total ? Math.round((part / total) * 100) : null);

/** Шкала оси счёта: «круглый» максимум и 3–5 делений (1, 2, 5 × 10ⁿ), шаг не меньше 1 — задач половинками не бывает. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= raw) ?? pow * 10);
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Math.round(i * step * 1000) / 1000);
}

/** «02.11» — подпись недели по понедельнику. */
export const shortDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

/** Дни с числом: 1 день, 2 дня, 5 дней, 2,5 дня. */
export function days(n: number): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  // Дробное (среднее) — «2,5 дня».
  const word = !Number.isInteger(n) ? 'дня' : a > 10 && a < 20 ? 'дней' : b === 1 ? 'день' : b >= 2 && b <= 4 ? 'дня' : 'дней';
  return `${String(n).replace('.', ',')} ${word}`;
}

export type StatsItem = TaskStats['items'][number];
export const SORT_KEYS = ['number', 'title', 'category', 'assignee', 'startedAt', 'completedAt', 'dueDate', 'lateDays', 'leadDays'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** Значение для сортировки; пустые — в конце при любом направлении. */
function keyOf(i: StatsItem, k: SortKey): string | number | null {
  if (k === 'category') return i.category.value;
  if (k === 'assignee') return i.assignee?.fullName ?? null;
  return i[k];
}

export function sortItems(items: readonly StatsItem[], k: SortKey, dir: 'asc' | 'desc'): StatsItem[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = keyOf(a, k);
    const y = keyOf(b, k);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru');
    return c * sign || b.number - a.number;
  });
}

export const CLOSED_BY: Record<StatsItem['closedBy']['how'], string> = {
  accepted: 'принял(а)',
  self: 'сам(а), без проверки',
  system: 'система: документ перешёл дальше',
  override: 'смена статуса',
};
