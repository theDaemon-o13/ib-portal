import { describe, expect, it } from 'vitest';
import { checkNotAfterYearEnd, compactSettings, endOfYear, lockedFields, lockingStatusIds, readSettings, TEXT_MAX, TEXT_MAX_MULTILINE, textLimit } from './field-settings.js';

describe('настройки поля: фиксация и дата (этап 8б)', () => {
  const fields = [
    { id: 'doc', label: 'Документ', settings: { lock: { statusOptionIds: ['active', 'expired'], mode: 'locked' as const } } },
    { id: 'dev', label: 'Устройства', settings: { lock: { statusOptionIds: ['active'], mode: 'reason' as const } } },
    { id: 'note', label: 'Примечание', settings: {} },
  ];

  it('поля, которые фиксирует текущий статус', () => {
    expect([...lockedFields(fields, 'active')]).toEqual([['doc', 'locked'], ['dev', 'reason']]);
    expect([...lockedFields(fields, 'expired')]).toEqual([['doc', 'locked']]);
    expect(lockedFields(fields, 'draft').size).toBe(0);
    expect(lockedFields(fields, undefined).size).toBe(0);
    expect([...lockingStatusIds(fields)].sort()).toEqual(['active', 'expired']);
  });

  it('чтение и сжатие: чужой формат — пусто, пустые разделы не хранятся', () => {
    expect(readSettings(null)).toEqual({});
    expect(readSettings({ lock: { statusOptionIds: ['a', 1], mode: 'x' } })).toEqual({ lock: { statusOptionIds: ['a'], mode: 'locked' } });
    expect(compactSettings({ lock: { statusOptionIds: [], mode: 'locked' }, date: {} })).toBeNull();
    expect(compactSettings({ date: { defaultEndOfYear: true, notAfterYearEndOfFieldId: null } })).toEqual({ date: { defaultEndOfYear: true } });
  });

  it('«не позже 31.12 года поля N»', () => {
    expect(endOfYear('2026-03-01')).toBe('2026-12-31');
    expect(checkNotAfterYearEnd('2026-12-31', '2026-03-01', 'Дата документа')).toBeNull();
    expect(checkNotAfterYearEnd('2027-01-01', '2026-03-01', 'Дата документа')).toBe('не позже 31.12.2026 (31.12 года «Дата документа»)');
    expect(checkNotAfterYearEnd('2027-01-01', undefined, 'Дата документа')).toBeNull();
  });
});

describe('многострочный текст (релиз 1.1.0)', () => {
  it('чтение и сжатие: хранится только multiline: true', () => {
    expect(readSettings({ text: { multiline: true } })).toEqual({ text: { multiline: true } });
    expect(readSettings({ text: { multiline: 'yes' } })).toEqual({});
    expect(compactSettings({ text: { multiline: false } })).toBeNull();
    expect(compactSettings({ text: { multiline: true }, lock: { statusOptionIds: ['a'], mode: 'reason' } }))
      .toEqual({ lock: { statusOptionIds: ['a'], mode: 'reason' }, text: { multiline: true } });
  });

  it('лимит: 20 000 у многострочного, 4000 у остальных', () => {
    expect(TEXT_MAX).toBe(4000);
    expect(TEXT_MAX_MULTILINE).toBe(20_000);
    expect(textLimit(undefined)).toBe(4000);
    expect(textLimit({})).toBe(4000);
    expect(textLimit({ text: { multiline: true } })).toBe(20_000);
  });
});
