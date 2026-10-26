import { describe, expect, it } from 'vitest';
import { checkPasswordStrength, characterClasses } from './password-policy.js';
import { generateTemporaryPassword, TEMP_PASSWORD_LENGTH } from './temp-password.js';

describe('временный пароль', () => {
  it('всегда соответствует парольной политике и содержит все четыре класса', () => {
    for (let i = 0; i < 2000; i++) {
      const pw = generateTemporaryPassword();
      expect(pw).toHaveLength(TEMP_PASSWORD_LENGTH);
      expect(characterClasses(pw)).toBe(4);
      expect(checkPasswordStrength(pw, 'some.user')).toEqual([]);
    }
  });

  it('не повторяется', () => {
    const set = new Set(Array.from({ length: 1000 }, generateTemporaryPassword));
    expect(set.size).toBe(1000);
  });
});
