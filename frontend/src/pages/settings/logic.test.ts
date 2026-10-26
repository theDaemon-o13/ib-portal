import { describe, expect, it } from 'vitest';
import { formatCalendarDay, initials, needsThreshold, parseKeywords, requirementText, toggleWeekend } from './logic';

describe('логика настроек', () => {
  it('требование поля шаблона', () => {
    expect(requirementText('min', 12)).toBe('не менее 12');
    expect(requirementText('max', 7.5)).toBe('не более 7,5');
    expect(requirementText('yes', null)).toBe('да');
    expect(requirementText('text', null)).toBe('заполняется');
    expect(needsThreshold('min')).toBe(true);
    expect(needsThreshold('yes')).toBe(false);
  });

  it('ключевые слова правил почты нормализуются как на backend', () => {
    expect(parseKeywords(' VPN, шлюз,, vpn , Шлюз')).toEqual(['vpn', 'шлюз']);
    expect(parseKeywords('  ')).toEqual([]);
  });

  it('выходные дни недели: в неделе остаётся хотя бы один рабочий день', () => {
    expect(toggleWeekend([6, 7], 6)).toEqual([7]);
    expect(toggleWeekend([7], 6)).toEqual([6, 7]);
    expect(toggleWeekend([1, 2, 3, 4, 5, 6], 7)).toBeNull();
  });

  it('форматирование', () => {
    expect(formatCalendarDay('2026-03-21')).toBe('21.03.2026, сб');
    expect(formatCalendarDay('2026-11-06')).toBe('06.11.2026, пт');
    expect(initials('Дев Администратор')).toBe('ДА');
  });
});
