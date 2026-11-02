import { describe, expect, it } from 'vitest';
import { parseXlsxSheets } from '../../lib/spreadsheetml.js';
import { serviceRegistry } from '../../test/asset-files.js';
import { componentKey, normalizeOs, parseServiceRegistry, productOf, splitAddress, translateCategory } from './service-registry.js';

const OS = { 'Linux Centos 7': 'CentOS 7', 'CentOS Linux 7 (Core)': 'CentOS 7', 'Linux/Debian 11': 'Debian 11' };

describe('реестр сервисов', () => {
  it('перевод старой шкалы', () => {
    expect(translateCategory('Business Operatinal')).toEqual({ value: 'Operational', known: true });
    expect(translateCategory('business operational')).toEqual({ value: 'Operational', known: true });
    expect(translateCategory('Office Productivity')).toEqual({ value: 'Non-Critical', known: true });
    expect(translateCategory('Mission Critical')).toEqual({ value: 'Mission Critical', known: true });
    expect(translateCategory('')).toEqual({ value: '', known: true });
    expect(translateCategory('Очень важно')).toEqual({ value: '', known: false });
  });

  it('IP:порт и неполный адрес', () => {
    expect(splitAddress('10.0.0.5:8080')).toEqual({ ip: '10.0.0.5', port: '8080', complete: true });
    expect(splitAddress('10.0.0.5')).toEqual({ ip: '10.0.0.5', port: '', complete: true });
    expect(splitAddress('10.0.5:443')).toEqual({ ip: '10.0.5', port: '443', complete: false });
  });

  it('нормализация ОС, продукт по команде, ключ компонента', () => {
    expect(normalizeOs('  centos linux 7 (core) ', OS)).toBe('CentOS 7');
    expect(normalizeOs('Windows Server 2019', OS)).toBe('Windows Server 2019');
    expect(productOf('Команда А', { 'команда а': 'Продукт А' })).toBe('Продукт А');
    expect(productOf('Команда Б', {})).toBe('Команда Б');
    expect(componentKey(' Notification ', 'Продукт А')).toBe('notification / продукт а');
  });

  it('файл формы: заголовки в строке 6, «Класификация» — среда и статус, предупреждения', async () => {
    const buf = await serviceRegistry([
      { name: 'notification', category: 'Business Operatinal', address: '10.0.0.5:8080', os: 'Linux Centos 7', classification: 'В эксплуатации', team: 'Команда А', owner: 'Иванов И.' },
      { name: 'notification', category: 'Mission Critical', address: '10.0.5', classification: 'Тест', team: 'Команда Б' },
      { name: 'db', category: 'Что-то', classification: 'Непонятно' },
    ]);
    const p = parseServiceRegistry(await parseXlsxSheets(buf, 100), { teams: { 'Команда А': 'Продукт А' }, os: OS });
    expect([p.sheet, p.headerRow]).toEqual(['Список активов', 6]);
    expect(p.rows[0]).toMatchObject({
      row: 7, component: 'notification', product: 'Продукт А', category: 'Operational', ip: '10.0.0.5', port: '8080', os: 'CentOS 7', osSource: 'Linux Centos 7',
      env: 'Prod', status: 'Работает', owner: 'Иванов И.', key: 'notification / продукт а',
    });
    expect(p.rows[1]).toMatchObject({ product: 'Команда Б', env: 'Test', ipComplete: false, key: 'notification / команда б' });
    expect(p.warnings.join('\n')).toMatch(/Неизвестные значения «Важность\/Критичность».*Что-то/);
    expect(p.warnings.join('\n')).toMatch(/«Класификация».*Непонятно/);
    expect(p.warnings.join('\n')).toMatch(/Неполный IP-адрес.*строки 8/);
    expect(p.warnings.join('\n')).toMatch(/Без команды.*строки 9/);
  });
});
