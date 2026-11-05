import { describe, expect, it } from 'vitest';
import { DEFAULT_LETTERS_SETTINGS, LetterLimitsSchema } from './settings.js';

describe('лимиты размера писем', () => {
  it('значения по умолчанию проходят; изображение больше письма и предупреждение позже лимита — нет', () => {
    expect(LetterLimitsSchema.safeParse(DEFAULT_LETTERS_SETTINGS).success).toBe(true);
    expect(LetterLimitsSchema.safeParse({ maxImageKb: 4096, maxLetterKb: 2048, warnLetterKb: 1024 }).success).toBe(false);
    expect(LetterLimitsSchema.safeParse({ maxImageKb: 1024, maxLetterKb: 2048, warnLetterKb: 3000 }).success).toBe(false);
  });

  it('только целые КБ в пределах; лишние поля — ошибка', () => {
    expect(LetterLimitsSchema.safeParse({ ...DEFAULT_LETTERS_SETTINGS, maxImageKb: 10.5 }).success).toBe(false);
    expect(LetterLimitsSchema.safeParse({ ...DEFAULT_LETTERS_SETTINGS, maxLetterKb: 30_000 }).success).toBe(false);
    expect(LetterLimitsSchema.safeParse({ ...DEFAULT_LETTERS_SETTINGS, extra: 1 }).success).toBe(false);
    const bad = LetterLimitsSchema.safeParse({ maxImageKb: 4096, maxLetterKb: 2048, warnLetterKb: 1024 });
    expect(bad.success ? '' : bad.error.issues[0]?.message).toMatch(/maxImageKb ≤ maxLetterKb/);
  });
});
