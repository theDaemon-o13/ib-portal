import { describe, expect, it } from 'vitest';
import { days, niceTicks, pct, presetOf, presetRange, sortItems, type StatsItem } from './stats';

describe('отчёт по выполненным задачам', () => {
  it('периоды: месяц, прошлый месяц целиком, квартал и год — по сегодня; подсветка кнопки', () => {
    expect(presetRange('month', '2026-11-03')).toEqual({ from: '2026-11-01', to: '2026-11-03' });
    expect(presetRange('prev', '2026-11-03')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('prev', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('quarter', '2026-11-03')).toEqual({ from: '2026-10-01', to: '2026-11-03' });
    expect(presetRange('year', '2026-11-03')).toEqual({ from: '2026-01-01', to: '2026-11-03' });
    expect(presetOf('2026-10-01', '2026-10-31', '2026-11-03')).toBe('prev');
    expect(presetOf('2026-10-02', '2026-10-31', '2026-11-03')).toBeNull();
  });
  it('шкала, доли и дни', () => {
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(43)).toEqual([0, 20, 40, 60]);
    expect([pct(3, 4), pct(0, 0)]).toEqual([75, null]);
    expect([days(1), days(3), days(11), days(21), days(2.5)]).toEqual(['1 день', '3 дня', '11 дней', '21 день', '2,5 дня']);
  });
  it('сортировка списка: пустые — в конце при любом направлении', () => {
    const it = (number: number, lateDays: number | null, assignee: string | null): StatsItem => ({
      id: String(number), number, title: `t${number}`, category: { id: 'c', value: 'Проект', color: null },
      assignee: assignee ? { id: assignee, fullName: assignee } : null, createdAt: '2026-11-01', startedAt: null, completedAt: '2026-11-02',
      dueDate: null, lateDays, leadDays: 1, closedBy: { how: 'self', fullName: null },
    });
    const xs = [it(1, 3, 'Борисов'), it(2, null, null), it(3, 0, 'Алиев')];
    expect(sortItems(xs, 'lateDays', 'desc').map((x) => x.number)).toEqual([1, 3, 2]);
    expect(sortItems(xs, 'lateDays', 'asc').map((x) => x.number)).toEqual([3, 1, 2]);
    expect(sortItems(xs, 'assignee', 'asc').map((x) => x.number)).toEqual([3, 1, 2]);
  });
});
