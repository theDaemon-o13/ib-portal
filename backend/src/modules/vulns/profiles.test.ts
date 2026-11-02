import { describe, expect, it } from 'vitest';
import { detectProfile, scanFreshness } from './profiles.js';

const type = (label: string) => ({ id: `id-${label}`, label });
const TYPES = ['Windows', 'Linux', 'PostgreSQL', 'Website', 'Docker', 'БД', 'Рабочие станции'].map(type);
const label = (name: string, aliases = {}) => detectProfile(name, TYPES, aliases)?.label ?? null;

describe('профиль из имени файла', () => {
  it.each([
    ['Отчёт Windows за 2026_10_15.xlsx', 'Windows'],
    ['vuln-windows-2026-10-15.xlsx', 'Windows'],
    ['Scan_Linux_2026-11-01.xlsx', 'Linux'],
    ['scan-linux.xlsx', 'Linux'],
    ['SCANLINUX 2026.xlsx', 'Linux'],
    ['ХумоОнлайн_Linux_2026_10_15.xlsx', 'Linux'],
    ['Scan_PostgreSQL.xlsx', 'PostgreSQL'],
    ['скан БД 2026.xlsx', 'БД'],
    ['рабочие_станции_2026.xlsx', 'Рабочие станции'],
  ])('%s → %s', (name, expected) => {
    expect(label(name)).toBe(expected);
  });

  it('имя без профиля — null', () => {
    expect(label('Отчёт сканера 2026_10_15.xlsx')).toBeNull();
  });
  it('часть другого слова не считается', () => {
    expect(label('Windows11_2026.xlsx')).toBeNull();
    expect(label('Dockerfile_report.xlsx')).toBeNull();
    expect(label('БДИ_2026.xlsx')).toBeNull();
  });
  it('два профиля в имени — null, без угадывания', () => {
    expect(label('Scan_Windows_Linux_2026_10_15.xlsx')).toBeNull();
  });
  it('синонимы; синоним и название одного типа — не неоднозначность', () => {
    const aliases = { 'id-PostgreSQL': ['postgres', 'pg'] };
    expect(label('scan-pg-2026.xlsx', aliases)).toBe('PostgreSQL');
    expect(label('Postgres_2026.xlsx', aliases)).toBe('PostgreSQL');
    expect(label('PostgreSQL_pg_2026.xlsx', aliases)).toBe('PostgreSQL');
    expect(label('pg_Linux.xlsx', aliases)).toBeNull();
  });
  it('расширение файла — не слово имени', () => {
    expect(detectProfile('report.xlsx', [type('xlsx')])).toBeNull();
  });
  it('спецсимволы в названии типа не ломают поиск', () => {
    expect(detectProfile('Scan_C++_2026.xlsx', [type('C++')])?.label).toBe('C++');
  });
});

describe('регулярность сканирования', () => {
  it('порог включительно: 90 дней — ещё нет, 91 — превышен', () => {
    expect(scanFreshness('2026-08-04', '2026-11-02', 90)).toEqual({ ageDays: 90, stale: false });
    expect(scanFreshness('2026-08-03', '2026-11-02', 90)).toEqual({ ageDays: 91, stale: true });
  });
  it('сканов нет — порог превышен', () => {
    expect(scanFreshness(null, '2026-11-02', 90)).toEqual({ ageDays: null, stale: true });
  });
});
