import { describe, expect, it } from 'vitest';
import { addMonthsIso, checkDocUrlPrefix, docStatus, isDocUrl } from './status.js';

describe('статус документа', () => {
  const today = '2026-10-27';
  it('без утверждённой версии: черновик на этапе автора, дальше — на согласовании', () => {
    expect(docStatus({ hasApproved: false, workingStage: 0, reviewDue: null }, today)).toBe('draft');
    expect(docStatus({ hasApproved: false, workingStage: 1, reviewDue: null }, today)).toBe('in_approval');
    expect(docStatus({ hasApproved: false, workingStage: 3, reviewDue: null }, today)).toBe('in_approval');
  });
  it('утверждён; новая версия в работе — на пересмотре', () => {
    expect(docStatus({ hasApproved: true, workingStage: null, reviewDue: '2027-10-27' }, today)).toBe('approved');
    expect(docStatus({ hasApproved: true, workingStage: 0, reviewDue: '2027-10-27' }, today)).toBe('in_review');
    expect(docStatus({ hasApproved: true, workingStage: 2, reviewDue: '2027-10-27' }, today)).toBe('in_review');
  });
  it('просрочка пересмотра важнее «на пересмотре»; в день пересмотра ещё не просрочен', () => {
    expect(docStatus({ hasApproved: true, workingStage: null, reviewDue: '2026-10-26' }, today)).toBe('review_overdue');
    expect(docStatus({ hasApproved: true, workingStage: 1, reviewDue: '2026-10-26' }, today)).toBe('review_overdue');
    expect(docStatus({ hasApproved: true, workingStage: null, reviewDue: today }, today)).toBe('approved');
  });
});

describe('дата пересмотра', () => {
  it('прибавляет месяцы; несуществующий день — последний день месяца', () => {
    expect(addMonthsIso('2026-10-27', 12)).toBe('2027-10-27');
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2027-01-31', 13)).toBe('2028-02-29');
    expect(addMonthsIso('2028-02-29', 12)).toBe('2029-02-28');
    expect(addMonthsIso('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonthsIso('2026-12-15', 1)).toBe('2027-01-15');
  });
});

describe('ссылка OnlyOffice', () => {
  it('только http(s) без пробелов', () => {
    expect(isDocUrl('https://office.example.local/doc/123?x=1')).toBe(true);
    expect(isDocUrl('http://10.0.0.5/products/files/doceditor.aspx?fileid=7')).toBe(true);
    expect(isDocUrl('javascript:alert(1)')).toBe(false);
    expect(isDocUrl('file:///etc/passwd')).toBe(false);
    expect(isDocUrl('https://office.local/a b')).toBe(false);
    expect(isDocUrl('office.local/doc')).toBe(false);
  });

  it('ONLYOFFICE_URL_PREFIX: тот же протокол, сервер и порт, путь с префикса', () => {
    const P = 'https://office.example.local/products/';
    expect(isDocUrl('https://office.example.local/products/files/doceditor.aspx?fileid=7', P)).toBe(true);
    expect(isDocUrl('https://OFFICE.example.local/products/x', P)).toBe(true);
    expect(isDocUrl('http://office.example.local/products/x', P)).toBe(false);
    expect(isDocUrl('https://office.example.local:8443/products/x', P)).toBe(false);
    expect(isDocUrl('https://office.example.local/other/x', P)).toBe(false);
    expect(isDocUrl('https://office.example.local.evil.tj/products/x', P)).toBe(false);
    expect(isDocUrl('https://office.example.local@evil.tj/products/x', P)).toBe(false);
    expect(isDocUrl('https://user@office.example.local/products/x', P)).toBe(false);
    // Пустой префикс — как раньше, любая http(s).
    expect(isDocUrl('http://10.0.0.5/x', '')).toBe(true);
  });

  it('префикс из .env проверяется при старте', () => {
    expect(checkDocUrlPrefix('')).toBeNull();
    expect(checkDocUrlPrefix('https://office.example.local/')).toBeNull();
    expect(checkDocUrlPrefix('ftp://office.example.local/')).toMatch(/http/);
    expect(checkDocUrlPrefix('https://office.example.local/?a=1')).toMatch(/параметров/);
    expect(checkDocUrlPrefix('office.example.local')).toMatch(/адрес/);
  });
});
