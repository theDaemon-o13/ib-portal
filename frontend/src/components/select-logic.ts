// Логика выпадающего списка Select (1.13.4): клавиатура по WAI-ARIA APG (select-only combobox), поиск по буквам,
// фильтр длинных списков, размещение панели. Чистые функции — проверяются unit-тестами без браузера.

export interface SelOption { value: string; label: string; disabled: boolean }

/** Порог поля поиска в списке: больше стольких значений — поиск по вводу. */
export const SEARCH_THRESHOLD = 15;
/** Сколько пунктов пропускает PageUp / PageDown. */
export const PAGE = 10;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Ближайший доступный пункт от from в направлении step (±1); упёрлись в край — остаёмся на последнем доступном. */
export function move(opts: readonly SelOption[], from: number, step: number): number {
  if (!opts.length) return -1;
  const dir = step < 0 ? -1 : 1;
  let i = from;
  let last = opts[from] && !opts[from].disabled ? from : -1;
  for (let n = 0; n < Math.abs(step) || last === -1; n++) {
    let j = i + dir;
    while (j >= 0 && j < opts.length && opts[j]?.disabled) j += dir;
    if (j < 0 || j >= opts.length) break;
    i = j;
    last = j;
  }
  return last === -1 ? edge(opts, dir < 0 ? 'first' : 'last') : last;
}

/** Первый или последний доступный пункт. */
export function edge(opts: readonly SelOption[], which: 'first' | 'last'): number {
  const idx = opts.map((_, i) => i).filter((i) => !opts[i]?.disabled);
  if (!idx.length) return -1;
  return which === 'first' ? idx[0] ?? -1 : idx[idx.length - 1] ?? -1;
}

/** Поиск по буквам: следующий после from доступный пункт, подпись которого начинается с query (по кругу). */
export function typeahead(opts: readonly SelOption[], query: string, from: number): number {
  const q = norm(query);
  if (!q) return from;
  // Одна и та же буква подряд — листать совпадения; иначе — искать начиная с текущего.
  const same = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = same ? q[0] ?? '' : q;
  const start = same ? from + 1 : from;
  for (let n = 0; n < opts.length; n++) {
    const i = (Math.max(start, 0) + n) % opts.length;
    const o = opts[i];
    if (o && !o.disabled && norm(o.label).startsWith(needle)) return i;
  }
  return from;
}

/** Фильтр списка по вводу (подстрока, без регистра, «ё» = «е»): индексы исходного списка. */
export function filterIndexes(opts: readonly SelOption[], query: string): number[] {
  const q = norm(query);
  return opts.map((_, i) => i).filter((i) => !q || norm(opts[i]?.label ?? '').includes(q) || norm(opts[i]?.value ?? '') === q);
}

export type SelKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'PageDown' | 'PageUp' | 'Enter' | ' ' | 'Escape' | 'Tab' | 'AltArrowDown';

export interface SelState { open: boolean; active: number }
export type SelEffect = { kind: 'none' } | { kind: 'pick'; index: number } | { kind: 'close' };

/**
 * Клавиша → новое состояние и действие. selected — индекс текущего значения (−1 — нет).
 * Закрыт: ↓ ↑ Enter Пробел Alt+↓ — открыть на выбранном; Home/End — открыть на первом/последнем.
 * Открыт: ↑ ↓ PageUp/PageDown Home/End — перемещение; Enter/Пробел — выбрать; Esc, Tab — закрыть без изменения.
 */
export function onKey(opts: readonly SelOption[], s: SelState, key: SelKey, selected: number): { state: SelState; effect: SelEffect } {
  const none = { kind: 'none' } as const;
  if (!s.open) {
    if (key === 'Home' || key === 'End') return { state: { open: true, active: edge(opts, key === 'Home' ? 'first' : 'last') }, effect: none };
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ' || key === 'AltArrowDown') {
      const start = selected >= 0 && !opts[selected]?.disabled ? selected : edge(opts, 'first');
      return { state: { open: true, active: start }, effect: none };
    }
    return { state: s, effect: none };
  }
  switch (key) {
    case 'ArrowDown': return { state: { ...s, active: move(opts, s.active, 1) }, effect: none };
    case 'ArrowUp': return { state: { ...s, active: move(opts, s.active, -1) }, effect: none };
    case 'PageDown': return { state: { ...s, active: move(opts, s.active, PAGE) }, effect: none };
    case 'PageUp': return { state: { ...s, active: move(opts, s.active, -PAGE) }, effect: none };
    case 'Home': return { state: { ...s, active: edge(opts, 'first') }, effect: none };
    case 'End': return { state: { ...s, active: edge(opts, 'last') }, effect: none };
    case 'Enter':
    case ' ':
      return s.active >= 0 && !opts[s.active]?.disabled
        ? { state: { open: false, active: s.active }, effect: { kind: 'pick', index: s.active } }
        : { state: s, effect: none };
    case 'Escape':
    case 'Tab':
      return { state: { open: false, active: s.active }, effect: { kind: 'close' } };
    default:
      return { state: s, effect: none };
  }
}

/** Размещение панели: под полем, если внизу хватает места, иначе над ним; ширина — не уже поля, в пределах экрана. */
export function place(
  rect: { top: number; bottom: number; left: number; width: number },
  view: { width: number; height: number },
  want: number,
  margin = 8,
): { up: boolean; left: number; width: number; top?: number; bottom?: number; maxHeight: number } {
  const below = view.height - rect.bottom - margin;
  const above = rect.top - margin;
  const need = Math.min(want, 320);
  const up = below < Math.min(need, 200) && above > below;
  const width = Math.min(Math.max(rect.width, 200), view.width - margin * 2);
  const left = Math.min(Math.max(rect.left, margin), view.width - width - margin);
  const maxHeight = Math.max(120, Math.min(320, up ? above - 4 : below - 4));
  return up ? { up, left, width, bottom: view.height - rect.top + 4, maxHeight } : { up, left, width, top: rect.bottom + 4, maxHeight };
}
