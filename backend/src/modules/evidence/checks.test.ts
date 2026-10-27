import { describe, expect, it } from 'vitest';
import { buildChecks, checksSummary, type TemplateField } from './checks.js';
import { evidenceState } from './status.js';

const F: TemplateField[] = [
  { id: 'len', label: 'Длина', checkKind: 'min', threshold: 12 },
  { id: 'age', label: 'Срок', checkKind: 'max', threshold: 90 },
  { id: 'mfa', label: 'MFA', checkKind: 'yes', threshold: null },
  { id: 'note', label: 'Где настроено', checkKind: 'text', threshold: null },
];

describe('сверка формы подтверждения', () => {
  it('«не менее», «не более», «да/нет», «текст»; числа с запятой', () => {
    const { checks, problems } = buildChecks(F, { len: '12', age: '90,0', mfa: 'нет', note: ' GPO Default Domain ' });
    expect(problems).toEqual([]);
    expect(checks.map((c) => [c.requirement, c.value, c.ok])).toEqual([
      ['не менее 12', '12', true],
      ['не более 90', '90', true],
      ['да', 'нет', false],
      ['заполнено', 'GPO Default Domain', true],
    ]);
    expect(checksSummary(checks)).toEqual({ passed: 3, total: 4, fails: ['MFA'] });
    expect(buildChecks(F, { len: 11, age: 91, mfa: true, note: 'x' }).checks.map((c) => c.ok)).toEqual([false, false, true, true]);
  });

  it('незаполненное и нечисловое — ошибки ввода, а не «не соответствует»', () => {
    const { problems } = buildChecks(F, { len: 'двенадцать', mfa: 'может быть' });
    expect(problems.map((p) => p.fieldId)).toEqual(['len', 'age', 'mfa', 'note']);
  });
});

describe('состояние доказательства', () => {
  it('на проверке, принято, истекает (≤ 30 дней), истекло, отклонено; бессрочное не истекает', () => {
    const today = '2026-10-27';
    expect(evidenceState('pending', '2026-10-01', today)).toBe('pending');
    expect(evidenceState('rejected', null, today)).toBe('rejected');
    expect(evidenceState('accepted', null, today)).toBe('accepted');
    expect(evidenceState('accepted', '2026-11-27', today)).toBe('accepted');
    expect(evidenceState('accepted', '2026-11-26', today)).toBe('expiring');
    expect(evidenceState('accepted', '2026-10-27', today)).toBe('expiring');
    expect(evidenceState('accepted', '2026-10-26', today)).toBe('expired');
  });
});
