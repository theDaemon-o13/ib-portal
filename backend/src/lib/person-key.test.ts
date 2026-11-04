import { describe, expect, it } from 'vitest';
import { normalizePersonText, personKey } from './person-key.js';

describe('тот же человек среди ответственных лиц (1.6.7)', () => {
  it('регистр и лишние пробелы не важны', () => {
    expect(normalizePersonText('  Иванов   И.И. ')).toBe('иванов и.и.');
    expect(personKey('Иванов И.И.', 'Технический директор')).toBe(personKey(' иванов  и.и.', 'ТЕХНИЧЕСКИЙ   директор '));
  });
  it('однофамилец с другой должностью — другой человек', () => {
    expect(personKey('Иванов И.И.', 'Технический директор')).not.toBe(personKey('Иванов И.И.', 'Главный бухгалтер'));
  });
  it('без должности — отдельный ключ, не совпадает с тем же ФИО с должностью', () => {
    expect(personKey('Иванов И.И.', '')).not.toBe(personKey('Иванов И.И.', 'Технический директор'));
    expect(personKey('Иванов И.И.', '')).toBe(personKey('иванов и.и.', '  '));
  });
});
