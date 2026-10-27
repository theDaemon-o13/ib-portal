import { describe, expect, it } from 'vitest';
import { homePath, visibleNav } from './nav';

describe('меню по правам', () => {
  it('с ib.work видны все разделы', () => {
    expect(visibleNav(['ib.work']).map((i) => i.title)).toEqual([
      'Дашборд', 'Мониторинг', 'Конструктор реестров', 'Задачи', 'Документы', 'Доказательства', 'Настройки',
    ]);
    expect(homePath(['ib.work'])).toBe('/dashboard');
  });

  it('без ib.work виден только раздел «Документы»', () => {
    expect(visibleNav(['docs.approve.legal']).map((i) => i.title)).toEqual(['Документы']);
    expect(visibleNav([]).map((i) => i.title)).toEqual(['Документы']);
    expect(homePath([])).toBe('/documents');
  });

  it('настенный монитор видит только «Мониторинг»', () => {
    expect(visibleNav(['monitor.kiosk']).map((i) => i.title)).toEqual(['Мониторинг']);
    expect(homePath(['monitor.kiosk'])).toBe('/monitor');
  });
});
