import { describe, expect, it } from 'vitest';
import { languageOptions, optionLabel, presetCode } from './translation-languages';

describe('язык перевода из списка (1.13.7)', () => {
  const rows = [
    { id: 'a', language: 'Таджикский', code: 'tg' as const },
    { id: 'b', language: 'english', code: 'en' as const },
    { id: 'c', language: 'Узбекский', code: null },
  ];

  it('три варианта; занятые — с текстом строки, в том числе старой; несопоставленная строку не занимает', () => {
    const o = languageOptions(rows);
    expect(o.map((x) => [x.code, x.takenBy])).toEqual([['ru', null], ['tg', 'Таджикский'], ['en', 'english']]);
    expect(o.map(optionLabel)).toEqual(['Русский', 'Таджикский — уже добавлен', 'Английский — уже добавлен («english»)']);
  });

  it('при правке язык самой строки свободен', () => {
    expect(languageOptions(rows, 'a').find((x) => x.code === 'tg')?.takenBy).toBeNull();
  });

  it('выбор при открытии правки — только если текст ровно название из списка; старая строка — без выбора', () => {
    expect(presetCode({ language: 'Таджикский', code: 'tg' })).toBe('tg');
    expect(presetCode({ language: 'english', code: 'en' })).toBe('');
    expect(presetCode({ language: 'TJ', code: 'tg' })).toBe('');
    expect(presetCode({ language: 'Узбекский', code: null })).toBe('');
  });
});
