import { describe, expect, it } from 'vitest';
import { homePath, safeReturnPath, visibleNav } from './nav';

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

describe('возврат после входа', () => {
  it('только внутренний путь портала', () => {
    expect(safeReturnPath('/registers')).toBe('/registers');
    expect(safeReturnPath('/evidence?ev=1')).toBe('/evidence?ev=1');
    for (const bad of [undefined, null, 42, '', 'registers', '/login', '//evil.example', '/\\evil.example', '/x\\y', 'https://evil.example', '/\u0000x']) {
      expect(safeReturnPath(bad), String(bad)).toBeNull();
    }
  });
});
