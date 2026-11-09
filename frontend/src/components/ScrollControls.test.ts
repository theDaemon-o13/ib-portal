import { describe, expect, it } from 'vitest';
import { isListPage } from './ScrollControls';

describe('кнопки «Обновить / вверх / вниз» (1.13.3)', () => {
  it('на страницах-списках и дашборде — да; монитор, вход, профиль — нет', () => {
    for (const p of ['/dashboard', '/tasks', '/registers/abc/records', '/vulns/x', '/assets', '/documents/work', '/evidence', '/awareness/letters', '/audit', '/settings/users', '/search'])
      expect(isListPage(p), p).toBe(true);
    for (const p of ['/monitor', '/login', '/profile', '/tasksx', '/'])
      expect(isListPage(p), p).toBe(false);
  });
});
