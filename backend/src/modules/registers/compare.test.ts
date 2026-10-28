import { describe, expect, it } from 'vitest';
import { deptKey } from '../vulns/scan-parser.js';
import { scopeLabel } from './compare.service.js';

// Релиз 1.1.0, этап Б.2: отдел сравнивается без регистра, пробелов и «ё»; подпись области на экране.
describe('сравнение с реестром', () => {
  it('отдел: регистр, лишние пробелы и «ё» не важны', () => {
    expect(deptKey('  Отдел   ПЛАТЁЖНЫХ карт ')).toBe(deptKey('отдел платежных карт'));
    expect(deptKey('Отдел кредитования')).not.toBe(deptKey('Отдел платёжных карт'));
    expect(deptKey('   ')).toBe('');
  });

  it('подпись области: «отдел «…», система «…»»', () => {
    expect(scopeLabel([{ label: 'Отдел', values: ['Отдел платёжных карт'] }, { label: 'Система', values: ['АБС', 'ДБО'] }]))
      .toBe('отдел «Отдел платёжных карт», система «АБС», «ДБО»');
  });
});
