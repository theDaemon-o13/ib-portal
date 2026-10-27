// Дашборд и мониторинг: чистые функции без React (тесты — logic.test.ts).

/** «Обновлено в 14:05» из ISO-времени расчёта на сервере. */
export function timeOf(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}${withSeconds ? `:${p(d.getSeconds())}` : ''}`;
}

/** ГГГГ-ММ-ДД → ДД.ММ.ГГГГ. */
export function dateRu(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Число на плитке: целое — как есть, дробное — с запятой, нет данных — «—». */
export function num(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',');
}

/** Плашка дней до срока на мониторинге (как daysBox в прототипе). */
export function daysBox(days: number | null): { value: string; caption: string; tone: '' | 'over' | 'soon' } {
  if (days === null) return { value: '—', caption: 'без срока', tone: '' };
  if (days < 0) return { value: `−${-days}`, caption: 'дн. просрочки', tone: 'over' };
  return { value: String(days), caption: days === 0 ? 'срок сегодня' : 'дн. осталось', tone: days <= 7 ? 'soon' : '' };
}

/** «просрочено 3 дн.» / «сегодня» / «через 5 дн.» — ближайшие даты сроков. */
export function daysText(days: number): string {
  if (days < 0) return `просрочено ${-days} дн.`;
  if (days === 0) return 'сегодня';
  return `через ${days} дн.`;
}

/** Ширина полосы — доля от максимума строк, в процентах. */
export function barWidth(count: number, rows: readonly { count: number }[]): number {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (count / max) * 100;
}

/**
 * Сколько строк помещается на страницу мониторинга по высоте экрана (как в прототипе):
 * шрифт растёт с размером экрана, на строку — около трёх строк текста.
 */
export function rowsPerPage(height: number, width: number): number {
  const fs = Math.min(22, Math.max(12, height * 0.0125 + width * 0.0035));
  return Math.max(4, Math.floor((height * 0.66 - fs * 5) / (fs * 2.95)));
}

/** Страница списка по номеру шага листания: шаг идёт по кругу. */
export function pageOf<T>(items: readonly T[], perPage: number, step: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const page = ((step % pages) + pages) % pages;
  return { items: items.slice(page * perPage, page * perPage + perPage), page, pages };
}

export const MONITOR_FLIP_MS = 12_000;
export const MONITOR_REFRESH_MS = 60_000;
export const MONITOR_IDLE_MS = 3_500;
