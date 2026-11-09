import { describe, expect, it } from 'vitest';
import { edge, filterIndexes, move, onKey, place, typeahead, type SelOption } from './select-logic';

const o = (label: string, disabled = false, value = label): SelOption => ({ value, label, disabled });
// 0 — заглушка «Выберите…» (недоступна), 1–4 — значения, 3 — недоступно.
const opts = [o('Выберите…', true, ''), o('Плановое'), o('Срочное'), o('Архивное', true), o('Ёлочное')];

describe('Select: навигация клавишами', () => {
  it('↓ ↑ пропускают недоступные, на краю — остаются', () => {
    expect(move(opts, 1, 1)).toBe(2);
    expect(move(opts, 2, 1)).toBe(4);
    expect(move(opts, 4, 1)).toBe(4);
    expect(move(opts, 1, -1)).toBe(1);
    expect(move(opts, -1, 1)).toBe(1);
  });
  it('Home / End — первый и последний доступный; PageDown — на 10 или до края', () => {
    expect([edge(opts, 'first'), edge(opts, 'last')]).toEqual([1, 4]);
    const many = Array.from({ length: 30 }, (_, i) => o(`п${i}`));
    expect(move(many, 0, 10)).toBe(10);
    expect(move(many, 25, 10)).toBe(29);
    expect(move(many, 5, -10)).toBe(0);
  });
  it('закрыт: ↓ / Enter / Пробел / Alt+↓ открывают на выбранном; без выбора — на первом доступном; Home/End — на краях', () => {
    const closed = { open: false, active: -1 };
    for (const k of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'AltArrowDown'] as const) {
      expect(onKey(opts, closed, k, 2).state).toEqual({ open: true, active: 2 });
    }
    expect(onKey(opts, closed, 'ArrowDown', 0).state).toEqual({ open: true, active: 1 });
    expect(onKey(opts, closed, 'End', 1).state).toEqual({ open: true, active: 4 });
    expect(onKey(opts, closed, 'Escape', 1)).toEqual({ state: closed, effect: { kind: 'none' } });
  });
  it('открыт: Enter и Пробел выбирают активный, недоступный — нет; Esc и Tab закрывают без выбора', () => {
    const s = { open: true, active: 2 };
    expect(onKey(opts, s, 'Enter', 1)).toEqual({ state: { open: false, active: 2 }, effect: { kind: 'pick', index: 2 } });
    expect(onKey(opts, s, ' ', 1).effect).toEqual({ kind: 'pick', index: 2 });
    expect(onKey(opts, { open: true, active: 3 }, 'Enter', 1).effect).toEqual({ kind: 'none' });
    expect(onKey(opts, s, 'Escape', 1)).toEqual({ state: { open: false, active: 2 }, effect: { kind: 'close' } });
    expect(onKey(opts, s, 'Tab', 1).effect).toEqual({ kind: 'close' });
    expect(onKey(opts, s, 'ArrowDown', 1).state.active).toBe(4);
    expect(onKey(opts, s, 'Home', 1).state.active).toBe(1);
  });
});

describe('Select: поиск по буквам и фильтр', () => {
  it('по началу подписи, без регистра, «ё» = «е», по кругу; повтор буквы листает совпадения; недоступные пропускаются', () => {
    expect(typeahead(opts, 'с', 1)).toBe(2);
    expect(typeahead(opts, 'ЕЛ', 1)).toBe(4);
    expect(typeahead(opts, 'а', 1)).toBe(1); // «Архивное» недоступно — остаёмся
    const p = [o('Почта'), o('Проект'), o('Реестр'), o('Пароли')];
    expect(typeahead(p, 'п', 0)).toBe(0);
    expect(typeahead(p, 'пп', 0)).toBe(1);
    expect(typeahead(p, 'пп', 1)).toBe(3);
    expect(typeahead(p, 'пп', 3)).toBe(0);
    expect(typeahead(p, 'про', 0)).toBe(1);
  });
  it('фильтр длинного списка — подстрока, без регистра и «ё»', () => {
    const p = [o('Сотрудник Ёлкин'), o('Начальник ИБ'), o('Сотрудник SOC')];
    expect(filterIndexes(p, 'елк')).toEqual([0]);
    expect(filterIndexes(p, 'СОТРУД')).toEqual([0, 2]);
    expect(filterIndexes(p, '')).toEqual([0, 1, 2]);
  });
});

describe('Select: размещение панели', () => {
  const view = { width: 1440, height: 900 };
  it('внизу хватает места — под полем; не хватает — над ним; ширина не уже поля и в пределах экрана', () => {
    expect(place({ top: 100, bottom: 136, left: 300, width: 240 }, view, 300)).toEqual({ up: false, left: 300, width: 240, top: 140, maxHeight: 320 });
    const up = place({ top: 800, bottom: 836, left: 300, width: 240 }, view, 300);
    expect([up.up, up.bottom, up.maxHeight]).toEqual([true, 104, 320]);
    expect(place({ top: 100, bottom: 136, left: 1400, width: 120 }, view, 100).left).toBe(1440 - 200 - 8);
    expect(place({ top: 100, bottom: 136, left: 10, width: 400 }, { width: 375, height: 812 }, 100).width).toBe(375 - 16);
  });
});
