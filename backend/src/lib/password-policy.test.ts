import { describe, expect, it } from 'vitest';
import {
  characterClasses,
  checkPasswordStrength,
  isRecentlyUsed,
  PASSWORD_HISTORY_DEPTH,
} from './password-policy.js';

describe('парольная политика', () => {
  it('принимает пароль из 12 символов с тремя классами', () => {
    expect(checkPasswordStrength('Abcdefghij12', 'user')).toEqual([]);
  });

  it('отклоняет пароль короче 12 символов', () => {
    expect(checkPasswordStrength('Abcdefgh12!', 'user')).toContain('too_short');
  });

  it('длина считается в символах, а не в байтах', () => {
    expect(checkPasswordStrength('Пароль123456', 'user')).toEqual([]);
  });

  it('требует минимум три класса символов из четырёх', () => {
    expect(checkPasswordStrength('abcdefghijkl', 'user')).toContain('too_few_classes');
    expect(checkPasswordStrength('abcdefgh1234', 'user')).toContain('too_few_classes');
    expect(checkPasswordStrength('abcdefgh123!', 'user')).toEqual([]);
    expect(checkPasswordStrength('ABCDEFGH123!', 'user')).toEqual([]);
  });

  it('считает кириллицу буквами нужного регистра', () => {
    expect(characterClasses('пП1')).toBe(3);
    expect(characterClasses('aA1!')).toBe(4);
  });

  it('запрещает пароль, содержащий логин', () => {
    expect(checkPasswordStrength('Masharipov2026!', 'masharipov')).toContain('contains_login');
  });

  it('проверяет повтор среди последних 5 паролей, но не глубже', async () => {
    const verify = async (hash: string, pw: string) => hash === `h:${pw}`;
    const hashes = ['h:p0', 'h:p1', 'h:p2', 'h:p3', 'h:p4', 'h:p5'];
    expect(PASSWORD_HISTORY_DEPTH).toBe(5);
    expect(await isRecentlyUsed('p0', hashes, verify)).toBe(true);
    expect(await isRecentlyUsed('p4', hashes, verify)).toBe(true);
    expect(await isRecentlyUsed('p5', hashes, verify)).toBe(false);
    expect(await isRecentlyUsed('new', hashes, verify)).toBe(false);
  });
});
