// Лимиты размера учебных писем (1.9.0, ответ владельца 10): app_settings awareness.letters, «Параметры портала»,
// меняет супер-администратор. Письмо уходит на 1500+ ящиков, каждая копия лежит на почтовом сервере.
import { z } from 'zod';
import { DEFAULT_LETTER_LIMITS, type LetterLimits } from './sanitize.js';

export const AWARENESS_LETTERS_KEY = 'awareness.letters';

const kb = (name: string, min: number, max: number) => z
  .number({ error: `${name}: нужно целое число КБ` })
  .int(`${name}: целое число КБ`)
  .min(min, `${name}: не меньше ${min} КБ`)
  .max(max, `${name}: не больше ${max} КБ`);

export const LetterLimitsSchema = z
  .strictObject({
    maxImageKb: kb('maxImageKb', 16, 10_240),
    maxLetterKb: kb('maxLetterKb', 64, 20_480),
    warnLetterKb: kb('warnLetterKb', 16, 20_480),
  })
  .refine((l) => l.maxImageKb <= l.maxLetterKb, { message: 'Изображение не может быть больше письма: maxImageKb ≤ maxLetterKb' })
  .refine((l) => l.warnLetterKb <= l.maxLetterKb, { message: 'Предупреждение — не позже лимита: warnLetterKb ≤ maxLetterKb' });

export const DEFAULT_LETTERS_SETTINGS: LetterLimits = { ...DEFAULT_LETTER_LIMITS };
