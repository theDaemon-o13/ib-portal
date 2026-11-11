// Сгенерировано из backend/src/lib/languages.ts (npm run openapi:export). Вручную не править.
export const LANGUAGES = [
  { code: 'ru', name: 'Русский', short: 'RU' },
  { code: 'tg', name: 'Таджикский', short: 'TJ' },
  { code: 'en', name: 'Английский', short: 'EN' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export type Language = (typeof LANGUAGES)[number];

/** Ключ языка учебного письма (ru / tj) → код списка. */
export const LETTER_LANG_TO_CODE = { ru: 'ru', tj: 'tg' } as const;
