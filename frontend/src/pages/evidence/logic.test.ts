import { describe, expect, it } from 'vitest';
import { liveCheck, requirementText, resultText, validText } from './logic';

describe('доказательства: отображение', () => {
  it('требования и отметка при заполнении формы', () => {
    expect(requirementText({ checkKind: 'min', threshold: 12 })).toBe('не менее 12');
    expect(requirementText({ checkKind: 'yes', threshold: null })).toBe('да');
    expect(liveCheck({ checkKind: 'min', threshold: 12 }, '12')).toBe(true);
    expect(liveCheck({ checkKind: 'min', threshold: 12 }, '11')).toBe(false);
    expect(liveCheck({ checkKind: 'max', threshold: 90 }, '90,5')).toBe(false);
    expect(liveCheck({ checkKind: 'max', threshold: 90 }, '')).toBeNull();
    expect(liveCheck({ checkKind: 'yes', threshold: null }, 'нет')).toBe(false);
    expect(liveCheck({ checkKind: 'text', threshold: null }, 'GPO')).toBe(true);
  });

  it('срок действия и результат сверки', () => {
    expect(validText({ validUntil: null, daysLeft: null, status: 'accepted' })).toBe('бессрочно');
    expect(validText({ validUntil: '2026-11-10', daysLeft: 14, status: 'accepted' })).toBe('10.11.2026 · осталось 14 дн.');
    expect(validText({ validUntil: '2026-10-20', daysLeft: -7, status: 'accepted' })).toBe('20.10.2026 · истекло 7 дн. назад');
    expect(validText({ validUntil: '2027-10-27', daysLeft: 365, status: 'pending' })).toBe('27.10.2027');
    expect(resultText({ result: { passed: 5, total: 6, fails: ['MFA'] } })).toBe('5 из 6');
    expect(resultText({ result: null })).toBeNull();
  });
});
