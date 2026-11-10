import { describe, expect, it } from 'vitest';
import { msKey, removeValue, selectAllFound, selectableFound, toggleValue } from './multi-select-logic';
import type { SelOption } from './select-logic';

const o = (value: string, disabled = false): SelOption => ({ value, label: value, disabled });
// 1 — «уже добавлен» (недоступен).
const opts = [o('Иванов И.И.'), o('Петрова П.П.', true), o('Сидоров С.С.'), o('Тестова Т.Т.')];

describe('MultiSelect: клавиатура', () => {
  it('поиск: ↓ — в список на первый доступный; Enter — готово; Esc — закрыть; Пробел остаётся в поле', () => {
    expect(msKey(opts, 'search', -1, 'ArrowDown')).toEqual({ active: 0, effect: { kind: 'focus', zone: 'list' } });
    expect(msKey(opts, 'search', 2, 'ArrowDown')).toEqual({ active: 2, effect: { kind: 'focus', zone: 'list' } });
    expect(msKey(opts, 'search', 0, 'Enter').effect).toEqual({ kind: 'confirm' });
    expect(msKey(opts, 'search', 0, 'Escape').effect).toEqual({ kind: 'close' });
    expect(msKey(opts, 'search', 0, ' ').effect).toEqual({ kind: 'none' });
    expect(msKey([], 'search', -1, 'ArrowDown')).toEqual({ active: -1, effect: { kind: 'none' } });
  });

  it('список: ↑ ↓ пропускают «уже добавлен», ↑ на первом — в поиск; Home / End; Пробел отмечает, недоступный — нет', () => {
    expect(msKey(opts, 'list', 0, 'ArrowDown').active).toBe(2);
    expect(msKey(opts, 'list', 3, 'ArrowDown').active).toBe(3);
    expect(msKey(opts, 'list', 2, 'ArrowUp').active).toBe(0);
    expect(msKey(opts, 'list', 0, 'ArrowUp').effect).toEqual({ kind: 'focus', zone: 'search' });
    expect([msKey(opts, 'list', 2, 'Home').active, msKey(opts, 'list', 0, 'End').active]).toEqual([0, 3]);
    expect(msKey(opts, 'list', 2, ' ').effect).toEqual({ kind: 'toggle', index: 2 });
    expect(msKey(opts, 'list', 1, ' ').effect).toEqual({ kind: 'none' });
    expect(msKey(opts, 'list', 2, 'Enter').effect).toEqual({ kind: 'confirm' });
    expect(msKey(opts, 'list', 2, 'Escape').effect).toEqual({ kind: 'close' });
  });
});

describe('MultiSelect: отметки и чипы', () => {
  it('отметить и снять; «уже добавлен» не отмечается; сверх лимита новое не отмечается', () => {
    let sel = toggleValue([], opts[0]);
    sel = toggleValue(sel, opts[2]);
    expect(sel).toEqual(['Иванов И.И.', 'Сидоров С.С.']);
    expect(toggleValue(sel, opts[1])).toEqual(sel);
    expect(toggleValue(sel, opts[0])).toEqual(['Сидоров С.С.']);
    expect(toggleValue(sel, opts[3], 2)).toEqual(sel);
    expect(toggleValue(sel, opts[0], 2)).toEqual(['Сидоров С.С.']);
  });

  it('снять чип — убирает только его', () => {
    expect(removeValue(['Иванов И.И.', 'Сидоров С.С.'], 'Иванов И.И.')).toEqual(['Сидоров С.С.']);
    expect(removeValue(['Иванов И.И.'], 'Нет такого')).toEqual(['Иванов И.И.']);
  });

  it('«Выбрать всех найденных» — только доступные и ещё не отмеченные, в пределах лимита', () => {
    expect(selectableFound(opts, ['Сидоров С.С.']).map((x) => x.value)).toEqual(['Иванов И.И.', 'Тестова Т.Т.']);
    expect(selectAllFound(['Сидоров С.С.'], opts)).toEqual(['Сидоров С.С.', 'Иванов И.И.', 'Тестова Т.Т.']);
    expect(selectAllFound(['Сидоров С.С.'], opts, 2)).toEqual(['Сидоров С.С.', 'Иванов И.И.']);
    expect(selectAllFound(['Сидоров С.С.', 'Иванов И.И.'], opts, 2)).toEqual(['Сидоров С.С.', 'Иванов И.И.']);
  });
});
