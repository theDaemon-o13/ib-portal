import { describe, expect, it } from 'vitest';
import { cleanEmail, EMAIL_MAX } from './email.js';

describe('почта в справочных полях (1.13.6)', () => {
  it('обрезка пробелов, нижний регистр; пусто — нет адреса', () => {
    expect(cleanEmail('  Ivanov@Example.COM ')).toBe('ivanov@example.com');
    expect([cleanEmail(''), cleanEmail('   '), cleanEmail(undefined), cleanEmail(null)]).toEqual(['', '', '', '']);
  });
  it('неверный формат и слишком длинный — BAD_EMAIL', () => {
    for (const bad of ['ivanov', 'ivanov@', '@example.com', 'iv anov@example.com', 'ivanov@example', 'a@b@example.com', 'Иванов <ivanov@example.com>']) {
      expect(() => cleanEmail(bad), bad).toThrow(expect.objectContaining({ code: 'BAD_EMAIL' }));
    }
    expect(() => cleanEmail(`${'a'.repeat(EMAIL_MAX)}@example.com`)).toThrow(expect.objectContaining({ code: 'BAD_EMAIL' }));
  });
});
