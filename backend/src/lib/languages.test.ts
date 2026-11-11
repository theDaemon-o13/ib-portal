import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { frontendLanguagesModule, LANGUAGE_CODES, LANGUAGES, languageByCode, languageCodeOf, LETTER_LANG_TO_CODE } from './languages.js';

describe('список языков (1.13.7)', () => {
  it('три языка: коды ISO 639-1, названия и метки', () => {
    expect(LANGUAGES.map((l) => [l.code, l.name, l.short])).toEqual([['ru', 'Русский', 'RU'], ['tg', 'Таджикский', 'TJ'], ['en', 'Английский', 'EN']]);
    expect(LANGUAGE_CODES).toEqual(['ru', 'tg', 'en']);
    expect(languageByCode('tg').name).toBe('Таджикский');
  });

  it('сопоставление старых строк: названия и псевдонимы без учёта регистра и пробелов; прочее — null', () => {
    const cases: [string, string | null][] = [
      ['Русский', 'ru'], ['русский', 'ru'], ['Russian', 'ru'], ['RU', 'ru'], ['rus', 'ru'], ['Рус', 'ru'],
      ['Таджикский', 'tg'], [' таджикский ', 'tg'], ['TJ', 'tg'], ['tg', 'tg'], ['Тоҷикӣ', 'tg'], ['Tajik', 'tg'],
      ['Английский', 'en'], ['EN', 'en'], ['eng', 'en'], ['English', 'en'],
      ['Узбекский', null], ['таджикский язык', null], ['', null],
    ];
    for (const [text, code] of cases) expect([text, languageCodeOf(text)]).toEqual([text, code]);
  });

  it('учебные письма: ключ tj → код tg (Content-Language), ru → ru', () => {
    expect(LETTER_LANG_TO_CODE).toEqual({ ru: 'ru', tj: 'tg' });
  });

  it('frontend получает тот же список: сгенерированный файл совпадает (npm run openapi:export)', () => {
    const file = readFileSync(new URL('../../../frontend/src/api/generated/languages.ts', import.meta.url), 'utf8');
    expect(file).toBe(frontendLanguagesModule());
  });
});
