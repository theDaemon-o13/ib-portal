import { describe, expect, it } from 'vitest';
import { homePath, safeReturnPath, visibleNav } from './nav';

describe('меню по правам', () => {
  it('с ib.work видны все разделы', () => {
    expect(visibleNav(['ib.work']).map((i) => i.title)).toEqual([
      'Дашборд', 'Мониторинг', 'Конструктор реестров', 'Уязвимости', 'Активы', 'Задачи', 'Документы', 'Доказательства', 'Настройки',
    ]);
    expect(homePath(['ib.work'])).toBe('/dashboard');
  });

  it('без ib.work виден только раздел «Документы»', () => {
    expect(visibleNav([]).map((i) => i.title)).toEqual(['Документы']);
    expect(homePath([])).toBe('/documents');
  });

  it('«Журнал» — только с правом «Журнал действий», ib.work для него не нужен (релиз 1.2.0)', () => {
    expect(visibleNav(['ib.work']).map((i) => i.title)).not.toContain('Журнал');
    expect(visibleNav(['ib.work', 'audit.view']).map((i) => i.title)).toContain('Журнал');
    expect(visibleNav(['audit.view', 'docs.approve.head']).map((i) => i.title)).toEqual(['Документы', 'Журнал']);
    expect(visibleNav(['monitor.kiosk', 'audit.view']).map((i) => i.title)).toEqual(['Мониторинг']);
  });

  it('«Самооценка» — только с правом «Самооценка», над «Настройками», ib.work не нужен (этап Д)', () => {
    expect(visibleNav(['ib.work', 'audit.view', 'users.manage']).map((i) => i.title)).not.toContain('Самооценка');
    expect(visibleNav(['assessment.manage']).map((i) => i.title)).toEqual(['Документы', 'Самооценка']);
    expect(visibleNav(['ib.work', 'assessment.manage']).map((i) => i.title).slice(-2)).toEqual(['Самооценка', 'Настройки']);
    expect(visibleNav(['monitor.kiosk', 'assessment.manage']).map((i) => i.title)).toEqual(['Мониторинг']);
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

describe('служебная учётная запись (1.8.0, ADR-0036)', () => {
  it('видит только «Настройки», стартовая — /settings', () => {
    const perms = ['settings.manage', 'users.manage'];
    expect(visibleNav(perms, true).map((i) => i.title)).toEqual(['Настройки']);
    expect(homePath(perms, true)).toBe('/settings');
  });
  it('«Настройки» видны и без ib.work — тем, кто ведёт настройки или пользователей; «Документы» — всем, кроме служебной', () => {
    expect(visibleNav(['settings.manage']).map((i) => i.title)).toEqual(['Документы', 'Настройки']);
    expect(visibleNav(['users.manage']).map((i) => i.title)).toContain('Настройки');
    expect(visibleNav([]).map((i) => i.title)).toEqual(['Документы']);
  });
});
