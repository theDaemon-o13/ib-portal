import { describe, expect, it } from 'vitest';
import { badge, tabTitle, whenLabel } from './notifications';

describe('уведомления: подписи', () => {
  it('заголовок вкладки и значок', () => {
    expect([tabTitle(0), tabTitle(3), tabTitle(120)]).toEqual(['Портал ИБ', '(3) Портал ИБ', '(99+) Портал ИБ']);
    expect([badge(7), badge(100)]).toEqual(['7', '99+']);
  });

  it('когда: только что, минуты, сегодня, вчера, дата', () => {
    const now = new Date(2026, 9, 29, 15, 0);
    expect(whenLabel(new Date(2026, 9, 29, 14, 59, 30).toISOString(), now)).toBe('только что');
    expect(whenLabel(new Date(2026, 9, 29, 14, 55).toISOString(), now)).toBe('5 мин назад');
    expect(whenLabel(new Date(2026, 9, 29, 9, 5).toISOString(), now)).toBe('сегодня, 09:05');
    expect(whenLabel(new Date(2026, 9, 28, 14, 20).toISOString(), now)).toBe('вчера, 14:20');
    expect(whenLabel(new Date(2026, 9, 20, 8, 0).toISOString(), now)).toBe('20.10.2026, 08:00');
  });
});
