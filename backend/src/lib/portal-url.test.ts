import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { parsePortalUrl, sameOrigin } from './portal-url.js';

describe('PORTAL_URL', () => {
  it('origin со схемой и портом; порт по умолчанию отбрасывается, как в Origin браузера', () => {
    expect(parsePortalUrl('https://ib-portal.bank.local', true)).toEqual({ origin: 'https://ib-portal.bank.local' });
    expect(parsePortalUrl('https://ib-portal.bank.local/', true)).toEqual({ origin: 'https://ib-portal.bank.local' });
    expect(parsePortalUrl('https://IB-Portal.bank.local:443', true)).toEqual({ origin: 'https://ib-portal.bank.local' });
    expect(parsePortalUrl('https://localhost:8443', true)).toEqual({ origin: 'https://localhost:8443' });
    expect(parsePortalUrl('http://localhost:5173', false)).toEqual({ origin: 'http://localhost:5173' });
  });

  it('пусто, не адрес, http в production, путь, параметры, учётные данные — ошибка', () => {
    for (const [v, prod] of [['', true], ['ib-portal.bank.local', true], ['http://ib-portal.bank.local', true], ['ftp://x', false],
      ['https://ib-portal.bank.local/portal', true], ['https://ib-portal.bank.local/?a=1', true], ['https://u:p@ib-portal.bank.local', true]] as const) {
      expect(parsePortalUrl(v, prod), v).toHaveProperty('error');
    }
  });

  it('Origin сравнивается с адресом портала целиком: схема, хост и порт', () => {
    expect(sameOrigin('https://ib-portal.bank.local', 'https://ib-portal.bank.local')).toBe(true);
    expect(sameOrigin('https://ib-portal.bank.local:443', 'https://ib-portal.bank.local')).toBe(true);
    expect(sameOrigin('https://ib-portal.bank.local:8443', 'https://ib-portal.bank.local')).toBe(false);
    expect(sameOrigin('http://ib-portal.bank.local', 'https://ib-portal.bank.local')).toBe(false);
    expect(sameOrigin('https://ib-portal.bank.local.evil', 'https://ib-portal.bank.local')).toBe(false);
    expect(sameOrigin('null', 'https://ib-portal.bank.local')).toBe(false);
  });

  it('backend не стартует без PORTAL_URL — с понятной ошибкой', () => {
    const env = { DATABASE_URL: 'postgresql://x@db/ibportal', SESSION_SECRET: 's'.repeat(64), NODE_ENV: 'production' };
    expect(() => loadConfig(env)).toThrow(/PORTAL_URL: не задан\. Укажите полный адрес/);
    expect(() => loadConfig({ ...env, PORTAL_URL: 'http://ib-portal.bank.local' })).toThrow(/PORTAL_URL: .*нужен адрес https/);
    expect(loadConfig({ ...env, PORTAL_URL: 'https://ib-portal.bank.local' }).PORTAL_URL).toBe('https://ib-portal.bank.local');
  });
});
