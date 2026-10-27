import { describe, expect, it } from 'vitest';
import { critKeyOf, DUE_DAYS, exploitFactor, fixFactor, fixKeyFromText, vulnScore } from './vuln-score.js';

describe('оценка уязвимости (п. 7.1)', () => {
  it('Кэ: 1,00 — эксплуатируется; 0,94 — есть; 0,91 — остальное', () => {
    expect(exploitFactor('exploited')).toBe(1);
    expect(exploitFactor('exists')).toBe(0.94);
    expect(exploitFactor('none')).toBe(0.91);
    expect(exploitFactor('nodata')).toBe(0.91);
    expect(exploitFactor(null)).toBe(0.91);
  });

  it('Ки: 0,95 — исправление выпущено; 1,00 — нет или неизвестно', () => {
    expect(fixFactor('released')).toBe(0.95);
    expect(fixFactor('not_released')).toBe(1);
    expect(fixFactor(null)).toBe(1);
  });

  it('Оценка = CVSS × Кэ × Ки, округление вверх до 0,1', () => {
    expect(vulnScore(9.8, 'exploited', 'not_released')).toBe(9.8);
    expect(vulnScore(9.8, 'none', 'not_released')).toBe(9); // 8,918 → 9,0
    expect(vulnScore(8.6, 'exploited', 'released')).toBe(8.2); // 8,17 → 8,2
    expect(vulnScore(7.8, 'exists', 'released')).toBe(7); // 6,9654 → 7,0
    expect(vulnScore(5.5, 'none', 'released')).toBe(4.8); // 4,75475 → 4,8
  });

  it('целые произведения не уходят вверх из-за погрешности float', () => {
    expect(vulnScore(7, 'exploited', 'not_released')).toBe(7);
    expect(vulnScore(7, 'exists', 'not_released')).toBe(6.6); // 6,579999… → 6,58 → 6,6
    expect(vulnScore(10, 'exploited', 'released')).toBe(9.5);
    expect(vulnScore(0, 'exploited', 'released')).toBe(0);
  });

  it('нет CVSS — Оценка пустая', () => {
    expect(vulnScore(null, 'exploited', 'released')).toBeNull();
    expect(vulnScore(undefined, 'none', null)).toBeNull();
    expect(vulnScore(Number.NaN, 'none', null)).toBeNull();
  });
});

describe('критичность по Оценке (правило 2)', () => {
  it('границы 9,0 / 7,0 / 4,0 включаются в старшую категорию', () => {
    expect(critKeyOf(10)).toBe('critical');
    expect(critKeyOf(9)).toBe('critical');
    expect(critKeyOf(8.9)).toBe('high');
    expect(critKeyOf(7)).toBe('high');
    expect(critKeyOf(6.9)).toBe('medium');
    expect(critKeyOf(4)).toBe('medium');
    expect(critKeyOf(3.9)).toBe('low');
    expect(critKeyOf(0)).toBe('low');
  });

  it('нет Оценки (нет CVSS) — «Высокая»', () => {
    expect(critKeyOf(null)).toBe('high');
    expect(critKeyOf(vulnScore(null, 'exploited', 'released'))).toBe('high');
  });

  it('граница после множителей: 9,8 без эксплойта даёт ровно 9,0 — критическая', () => {
    expect(critKeyOf(vulnScore(9.8, 'none', 'not_released'))).toBe('critical');
    expect(critKeyOf(vulnScore(7.8, 'exists', 'released'))).toBe('high');
    expect(critKeyOf(vulnScore(4.4, 'none', 'released'))).toBe('low'); // 3,8038 → 3,9
  });
});

describe('сроки устранения (п. 7.2)', () => {
  it('календарные дни по критичности', () => {
    expect(DUE_DAYS).toEqual({ critical: 14, high: 30, medium: 90, low: 180 });
  });
});

describe('исправление по колонке «Обновить до версии»', () => {
  it('версия указана — выпущено; пусто или «не выпущено» — нет', () => {
    expect(fixKeyFromText('26.001.21411 или новее')).toBe('released');
    expect(fixKeyFromText('Последняя версия 7-Zip')).toBe('released');
    expect(fixKeyFromText('')).toBe('not_released');
    expect(fixKeyFromText(null)).toBe('not_released');
    expect(fixKeyFromText('Исправление не выпущено')).toBe('not_released');
  });
});
