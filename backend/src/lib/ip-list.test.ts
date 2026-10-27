import { describe, expect, it } from 'vitest';
import { normalizeIp, parseIpList } from './ip-list.js';

describe('parseIpList', () => {
  it('адреса и подсети через запятую и пробел', () => {
    const l = parseIpList(' 10.1.2.3, 10.20.0.0/16 ;fd00::/8 ');
    expect(l.entries).toEqual(['10.1.2.3', '10.20.0.0/16', 'fd00::/8']);
    expect(l.has('10.1.2.3')).toBe(true);
    expect(l.has('10.1.2.4')).toBe(false);
    expect(l.has('10.20.255.1')).toBe(true);
    expect(l.has('fd00::1')).toBe(true);
  });

  it('IPv4 в виде ::ffff:… сравнивается как IPv4', () => {
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(parseIpList('10.1.2.3').has('::ffff:10.1.2.3')).toBe(true);
  });

  it('пустой список не содержит ничего', () => {
    const l = parseIpList('');
    expect(l.empty).toBe(true);
    expect(l.has('127.0.0.1')).toBe(false);
  });

  it('мусор и пустой адрес не проходят', () => {
    const l = parseIpList('10.0.0.0/8');
    expect(l.has(null)).toBe(false);
    expect(l.has('не адрес')).toBe(false);
  });

  it('ошибка в списке — при разборе, с понятным текстом', () => {
    expect(() => parseIpList('10.0.0.1, monitor-pc')).toThrow('«monitor-pc» — не IP-адрес и не подсеть');
    expect(() => parseIpList('10.0.0.0/33')).toThrow('неверная длина префикса');
  });
});
