import { describe, expect, it } from 'vitest';
import { parseSpreadsheetML } from '../../lib/spreadsheetml.js';
import { basesReport, deploymentReport, kscOtherReport, versionsReport } from '../../test/asset-files.js';
import { detectReport, hostTypeOf, parseKscReport, summaryTotal } from './ksc.js';

const sheets = (buf: Buffer) => parseSpreadsheetML(buf, 30_000);
const RULES = {
  server: { products: ['для Windows Server'], groups: ['Servers'], namePatterns: ['SRV', 'SERVER', '^DC\\d'] },
  workstation: { namePatterns: ['(NB|PC|MAC)\\d*$'] },
};

describe('отчёты KSC', () => {
  it('тип отчёта по строке 2 Summary; ненужный и неизвестный — понятная ошибка', () => {
    expect(detectReport(sheets(deploymentReport([{ name: 'TEST-PC01NB' }]))).type).toBe('deployment');
    expect(detectReport(sheets(basesReport([], 'Отчет об используемых антивирусных базах'))).type).toBe('bases');
    expect(detectReport(sheets(versionsReport([]))).type).toBe('versions');
    expect(() => detectReport(sheets(kscOtherReport('Отчет о владельцах устройств')))).toThrow(/не нужен/);
    expect(() => detectReport(sheets(kscOtherReport('Отчет о реестре оборудования')))).toThrow(/не нужен/);
    expect(() => detectReport(sheets(kscOtherReport('Отчет об угрозах')))).toThrow(/Неизвестный отчёт KSC/);
  });

  it('развёртывание: покрытие, «Неизвестно» — пусто, сводка сходится с деталями', () => {
    const buf = deploymentReport([
      { name: 'TEST-PC01NB', agent: '15.0', product: 'Kaspersky Endpoint Security для Windows', version: '12.5' },
      { name: 'TEST-PC02NB', agent: '15.0' },
      { name: 'TEST-SRV01' },
    ]);
    expect(summaryTotal(sheets(buf)[0] as never)).toBe(3);
    const p = parseKscReport(sheets(buf));
    expect(p.missingAllowed).toBe(true);
    expect(p.devices.map((d) => [d.key, d.values.coverage])).toEqual([['test-pc01nb', 'Агент и защита'], ['test-pc02nb', 'Только агент'], ['test-srv01', 'Нет агента']]);
    expect(p.devices[2]?.values).toEqual({ kscGroup: 'Филиал 1', inKsc: 'Да', coverage: 'Нет агента' });
    // Покрытие совпадает со сводкой отчёта.
    const counts = (label: string) => p.devices.filter((d) => d.values.coverage === label).length;
    expect([counts('Агент и защита'), counts('Только агент'), counts('Нет агента')]).toEqual([1, 1, 1]);
  });

  it('обрезанный отчёт: итог сводки не сходится — блокировка; ровно 1000 строк без итога — предупреждение и без «Нет в файле»', () => {
    const devices = Array.from({ length: 5 }, (_, i) => ({ name: `TEST-PC${i}NB`, agent: '15' }));
    expect(() => parseKscReport(sheets(deploymentReport(devices, { summaryTotal: 9 })))).toThrow(/Отчёт обрезан: в сводке 9 устройств, в таблице 5/);
    const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `TEST-PC${i}NB`, program: 'Kaspersky Endpoint Security для Windows', connected: '2026-10-01' }));
    const p = parseKscReport(sheets(versionsReport(rows)));
    expect(p.missingAllowed).toBe(false);
    expect(p.warnings.join()).toMatch(/ровно 1000 строк/);
  });

  it('дубли: имя без домена и регистра, в хост — самая свежая запись, устаревшая — в списке дублей', () => {
    const p = parseKscReport(sheets(basesReport([
      { name: 'TEST-PC01NB', status: 'Обновлены более 7 дней назад', created: '2026-06-01', netbios: 'TEST-PC01NB' },
      { name: 'test-pc01nb.example.local', status: 'Актуальные', created: '2026-10-30', ip: '10.0.0.11', netbios: 'TEST-PC01NB' },
      { name: 'TEST-PC02NB', status: 'Актуальные', created: '2026-10-30', netbios: 'OTHER-NAME' },
    ])));
    expect(p.devices).toHaveLength(2);
    expect(p.devices[0]).toMatchObject({ key: 'test-pc01nb', name: 'test-pc01nb', values: { basesStatus: 'Актуальные', basesDate: '2026-10-30', ip: '10.0.0.11', domain: 'EXAMPLE' } });
    expect(p.duplicates).toEqual([{ key: 'test-pc01nb', kept: 'test-pc01nb.example.local', stale: ['TEST-PC01NB'] }]);
    expect(p.warnings.join()).toMatch(/NetBIOS-имя «OTHER-NAME»/);
  });

  it('версии программ: защита даёт даты, агент — версию, сервер администрирования пропускается', () => {
    const p = parseKscReport(sheets(versionsReport([
      { name: 'TEST-PC01NB', program: 'Агент администрирования Kaspersky Security Center', version: '15.1' },
      { name: 'TEST-PC01NB', program: 'Kaspersky Endpoint Security для Windows', version: '12.5', installed: '2025-01-10', visible: '2026-10-30', connected: '2026-09-01' },
      { name: 'TEST-SRV01', program: 'Сервер администрирования Kaspersky Security Center', version: '15' },
      { name: 'TEST-SRV02', program: 'Kaspersky Security для Windows Server', installed: '2025-02-01', visible: '2026-10-29', connected: '2026-10-29' },
      { name: 'TEST-PC03NB', program: 'Агент администрирования Kaspersky Security Center', version: '14.2', connected: '2026-10-01' },
    ])));
    const by = Object.fromEntries(p.devices.map((d) => [d.key, d.values]));
    expect(by['test-pc01nb']).toEqual({ seen: '2026-09-01', lastVisible: '2026-10-30', installedOn: '2025-01-10', agentVersion: '15.1' });
    expect(by['test-srv02']).toEqual({ seen: '2026-10-29', lastVisible: '2026-10-29', installedOn: '2025-02-01' });
    expect(by['test-pc03nb']).toEqual({ agentVersion: '14.2' });
    expect(by['test-srv01']).toBeUndefined();
    expect(p.missingAllowed).toBe(false);
  });

  it('тип нового хоста по правилам', () => {
    const t = (name: string, product = '', group = '') => hostTypeOf({ name, product, group }, RULES);
    expect(t('TEST-APP01', 'Kaspersky Security для Windows Server')).toBe('server');
    expect(t('TEST-APP01', '', 'servers')).toBe('server');
    expect(t('TEST-SRV01')).toBe('server');
    expect(t('DC01')).toBe('server');
    expect(t('TEST-PC01NB')).toBe('workstation');
    expect(t('TEST-MAC')).toBe('workstation');
    expect(t('TEST-PC12')).toBe('workstation');
    expect(t('PRINTER-01')).toBe('other');
  });
});
