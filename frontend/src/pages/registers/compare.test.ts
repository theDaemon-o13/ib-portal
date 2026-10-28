import { describe, expect, it } from 'vitest';
import { changesOf, plural, setForPicked } from './compare';

describe('статус отсутствующим', () => {
  it('один статус отмеченным, свой — в строке; отправляются только изменения', () => {
    let choices = new Map<string, string>([['a', 'fixed']]);
    choices = setForPicked(choices, new Set(['b', 'c']), 'accepted');
    choices.set('d', '');
    const current = new Map<string, string | null>([['a', 'open'], ['b', 'open'], ['c', 'accepted'], ['d', 'open']]);
    expect(changesOf(choices, current)).toEqual([
      { recordId: 'a', optionId: 'fixed' },
      { recordId: 'b', optionId: 'accepted' },
    ]);
  });

  it('окончания', () => {
    expect([1, 3, 5, 21].map((n) => plural(n, 'запись', 'записи', 'записей'))).toEqual(['1 запись', '3 записи', '5 записей', '21 запись']);
  });
});
