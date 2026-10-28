import { describe, expect, it } from 'vitest';
import type { MonitorSlide } from '../../api/dashboard';
import { emptyText, pagesOf, stepsOf } from './slides';

const items = (n: number) => ({ kind: 'items' as const, items: Array.from({ length: n }, (_, i) => ({ kind: 'task' as const, id: String(i), title: 't', sub: '', due: '2026-01-01', days: 0 })) });
const slide = (data: MonitorSlide['data'], empty = false, skipEmpty = false) => ({ data, empty, skipEmpty });

describe('слайды мониторинга', () => {
  it('страницы: длинный список — несколько страниц, KPI и пустой — одна', () => {
    expect(pagesOf(slide(items(25)), 10)).toBe(3);
    expect(pagesOf(slide({ kind: 'kpis', items: [] }), 10)).toBe(1);
    expect(pagesOf(slide(items(0), true), 10)).toBe(1);
  });

  it('шаги по порядку; пустой с «пропускать» — пропускается, без — показывается', () => {
    const steps = stepsOf([slide(items(15)), slide(items(0), true, true), slide(items(0), true, false), slide({ kind: 'kpis', items: [] })], 10);
    expect(steps).toEqual([{ slide: 0, page: 0 }, { slide: 0, page: 1 }, { slide: 2, page: 0 }, { slide: 3, page: 0 }]);
    expect(stepsOf([slide(items(0), true, true)], 10)).toEqual([]);
  });

  it('тексты пустых слайдов — по виду и сроку', () => {
    expect(emptyText({ kind: 'tasks', filter: { period: 'overdue' } })).toBe('Нет просроченных задач');
    expect(emptyText({ kind: 'tasks', filter: { period: 'within', days: 3 } })).toBe('Нет задач со сроком в ближайшие 3 дн.');
    expect(emptyText({ kind: 'vulns', filter: {} })).toBe('Открытых уязвимостей нет');
    expect(emptyText({ kind: 'documents', filter: { period: 'overdue' } })).toBe('Нет документов с просроченным пересмотром');
  });
});
