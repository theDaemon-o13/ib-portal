import { describe, expect, it } from 'vitest';
import { parseIpList } from './ip-list.js';
import { reportAddressLists } from './startup-report.js';

function capture() {
  const out: { level: 'info' | 'warn'; obj: Record<string, unknown>; msg: string }[] = [];
  return {
    out,
    log: {
      info: (obj: Record<string, unknown>, msg: string) => out.push({ level: 'info', obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) => out.push({ level: 'warn', obj, msg }),
    },
  };
}

describe('строки лога при старте: списки адресов (1.13.7)', () => {
  it('всё задано: одна строка info со списками, предупреждений нет', () => {
    const c = capture();
    reportAddressLists(c.log, { trustedProxies: parseIpList('172.31.250.6'), kiosk: parseIpList('10.20.30.40, 10.50.0.0/24'), admin: parseIpList('') });
    expect(c.out).toEqual([{
      level: 'info',
      obj: { event: 'startup.address_lists', trustedProxyIps: ['172.31.250.6'], monitorAllowedIps: ['10.20.30.40', '10.50.0.0/24'], adminAllowedIps: 'без ограничения' },
      msg: expect.stringContaining('MONITOR_ALLOWED_IPS'),
    }]);
  });

  it('MONITOR_ALLOWED_IPS пуста — warn «вход настенного монитора запрещён»; пустой TRUSTED_PROXY_IPS — тоже warn', () => {
    const c = capture();
    reportAddressLists(c.log, { trustedProxies: parseIpList(''), kiosk: parseIpList(''), admin: parseIpList('10.9.9.9') });
    expect(c.out.map((o) => [o.level, o.obj.event])).toEqual([
      ['info', 'startup.address_lists'], ['warn', 'startup.trusted_proxies_empty'], ['warn', 'startup.monitor_ips_empty'],
    ]);
    expect(c.out[2]?.msg).toMatch(/MONITOR_ALLOWED_IPS пуста — вход настенного монитора запрещён/);
    expect(c.out[0]?.obj.adminAllowedIps).toEqual(['10.9.9.9']);
  });
});
