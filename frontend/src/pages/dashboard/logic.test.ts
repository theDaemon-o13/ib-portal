import { describe, expect, it } from 'vitest';
import { barWidth, dateRu, daysBox, daysText, groupOf, moveEntry, num, pageOf, patchEntry, rowsPerPage, sizeClass } from './logic';

describe('дни до срока', () => {
  it('просрочка, сегодня, ≤ 7 дней, позже, без срока', () => {
    expect(daysBox(-3)).toEqual({ value: '−3', caption: 'дн. просрочки', tone: 'over' });
    expect(daysBox(0)).toEqual({ value: '0', caption: 'срок сегодня', tone: 'soon' });
    expect(daysBox(7)).toMatchObject({ tone: 'soon' });
    expect(daysBox(8)).toMatchObject({ tone: '' });
    expect(daysBox(null)).toMatchObject({ value: '—', caption: 'без срока' });
    expect([daysText(-2), daysText(0), daysText(5)]).toEqual(['просрочено 2 дн.', 'сегодня', 'через 5 дн.']);
  });
});

describe('листание мониторинга', () => {
  it('страница по кругу в обе стороны', () => {
    const list = [1, 2, 3, 4, 5];
    expect(pageOf(list, 2, 0)).toEqual({ items: [1, 2], page: 0, pages: 3 });
    expect(pageOf(list, 2, 4)).toEqual({ items: [3, 4], page: 1, pages: 3 });
    expect(pageOf(list, 2, -1)).toEqual({ items: [5], page: 2, pages: 3 });
    expect(pageOf([], 2, 7)).toEqual({ items: [], page: 0, pages: 1 });
  });

  it('строк на странице — от размера экрана, не меньше четырёх', () => {
    expect(rowsPerPage(1080, 1920)).toBeGreaterThan(8);
    expect(rowsPerPage(300, 400)).toBe(4);
  });
});

describe('форматирование', () => {
  it('числа, даты, ширина полосы', () => {
    expect([num(3), num(7.25), num(null)]).toEqual(['3', '7,3', '—']);
    expect(dateRu('2026-10-27')).toBe('27.10.2026');
    expect(barWidth(5, [{ count: 10 }, { count: 5 }])).toBe(50);
    expect(barWidth(0, [])).toBe(0);
  });
});

describe('раскладка дашборда', () => {
  it('группа по ключу, ширина, перенос и правка элемента', () => {
    expect([groupOf('kpi:a'), groupOf('tile:1'), groupOf('widget:field:x')]).toEqual(['kpi', 'tile', 'widget']);
    expect([sizeClass('widget', 's'), sizeClass('widget', 'm'), sizeClass('widget', 'l'), sizeClass('tile', 'm'), sizeClass('kpi', 'l')]).toEqual(['w4', 'w6', 'w12', 'tile-m', '']);
    const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
    expect(moveEntry(items, 'c', 'a').map((i) => i.key)).toEqual(['c', 'a', 'b']);
    expect(moveEntry(items, 'a', 'c').map((i) => i.key)).toEqual(['b', 'c', 'a']);
    expect(moveEntry(items, 'a', 'нет').map((i) => i.key)).toEqual(['a', 'b', 'c']);
    expect(patchEntry([{ key: 'a', hidden: false }], 'a', { hidden: true })).toEqual([{ key: 'a', hidden: true }]);
  });
});
