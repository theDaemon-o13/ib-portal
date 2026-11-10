// Логика списка с множественным выбором MultiSelect (1.13.5): клавиатура по WAI-ARIA APG (listbox с
// aria-multiselectable), отметка и снятие, «Выбрать всех найденных». Чистые функции — проверяются unit-тестами.
//
// Две зоны фокуса: поле поиска и список. Пробел в поле поиска — пробел (ФИО ищут с пробелами: «Иванов И»), отмечают
// пробелом в списке. Отметка применяется сразу: Enter — «готово» (закрыть с выбором), Esc — закрыть; отмеченное
// не теряется.
import { edge, move, type SelOption } from './select-logic';

export type MsZone = 'search' | 'list';
export type MsKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | ' ' | 'Enter' | 'Escape';
export type MsEffect =
  | { kind: 'none' }
  | { kind: 'toggle'; index: number }
  | { kind: 'confirm' }
  | { kind: 'close' }
  | { kind: 'focus'; zone: MsZone };

/**
 * Клавиша → новый активный пункт и действие. opts — видимые (отфильтрованные) пункты, active — индекс в них (−1 — нет).
 * Поиск: ↓ — в список (на активный или первый доступный), Enter — готово, Esc — закрыть.
 * Список: ↑ ↓ Home End — по доступным, ↑ на первом доступном — в поиск; Пробел — отметить или снять; Enter — готово; Esc — закрыть.
 */
export function msKey(opts: readonly SelOption[], zone: MsZone, active: number, key: MsKey): { active: number; effect: MsEffect } {
  const none = { kind: 'none' } as const;
  if (key === 'Enter') return { active, effect: { kind: 'confirm' } };
  if (key === 'Escape') return { active, effect: { kind: 'close' } };
  if (zone === 'search') {
    if (key === 'ArrowDown') {
      const at = active >= 0 && !opts[active]?.disabled ? active : edge(opts, 'first');
      return { active: at, effect: at >= 0 ? { kind: 'focus', zone: 'list' } : none };
    }
    return { active, effect: none };
  }
  switch (key) {
    case 'ArrowDown': return { active: move(opts, active, 1), effect: none };
    case 'ArrowUp': {
      const first = edge(opts, 'first');
      if (active <= first) return { active, effect: { kind: 'focus', zone: 'search' } };
      return { active: move(opts, active, -1), effect: none };
    }
    case 'Home': return { active: edge(opts, 'first'), effect: none };
    case 'End': return { active: edge(opts, 'last'), effect: none };
    case ' ': return { active, effect: active >= 0 && !opts[active]?.disabled ? { kind: 'toggle', index: active } : none };
    default: return { active, effect: none };
  }
}

/** Отметить или снять значение. Недоступное не меняется; сверх max новое не отмечается. */
export function toggleValue(selected: readonly string[], opt: SelOption | undefined, max = Infinity): string[] {
  if (!opt || opt.disabled) return [...selected];
  if (selected.includes(opt.value)) return selected.filter((v) => v !== opt.value);
  if (selected.length >= max) return [...selected];
  return [...selected, opt.value];
}

/** Снять чип. */
export function removeValue(selected: readonly string[], value: string): string[] {
  return selected.filter((v) => v !== value);
}

/** Сколько ещё можно отметить «Выбрать всех найденных»: доступные и не отмеченные среди видимых. */
export function selectableFound(opts: readonly SelOption[], selected: readonly string[]): SelOption[] {
  return opts.filter((o) => !o.disabled && !selected.includes(o.value));
}

/** «Выбрать всех найденных»: добавить доступные видимые, не больше чем до max всего. */
export function selectAllFound(selected: readonly string[], opts: readonly SelOption[], max = Infinity): string[] {
  const room = Math.max(0, max - selected.length);
  return [...selected, ...selectableFound(opts, selected).slice(0, room).map((o) => o.value)];
}
