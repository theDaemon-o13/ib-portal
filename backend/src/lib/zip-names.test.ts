import { describe, expect, it } from 'vitest';
import { extOf, NAME_MAX, safePart, zipNames } from './zip-names.js';

describe('имена файлов в архиве выгрузки (этап 8б)', () => {
  it('«<№ документа>_<хост>.pdf»', () => {
    expect(zipNames([{ docNumber: '45-р', hosts: ['WS-BUH-014'], ext: 'pdf' }])).toEqual(['45-р_WS-BUH-014.pdf']);
  });

  it('несколько хостов — через «_»', () => {
    expect(zipNames([{ docNumber: '7', hosts: ['WS-1', 'WS-2', 'NB-3'], ext: 'pdf' }])).toEqual(['7_WS-1_WS-2_NB-3.pdf']);
  });

  it('длиннее 120 символов — «<№>_<хост1>_и_ещё_N»', () => {
    const hosts = Array.from({ length: 12 }, (_, i) => `WS-ACCOUNTING-${String(i).padStart(3, '0')}`);
    const [name] = zipNames([{ docNumber: '12', hosts, ext: 'pdf' }]);
    expect(name).toBe('12_WS-ACCOUNTING-000_и_ещё_11.pdf');
    expect((name as string).length - '.pdf'.length).toBeLessThanOrEqual(NAME_MAX);
  });

  it('недопустимые символы номера (12/45-р) заменяются на «-»', () => {
    expect(zipNames([{ docNumber: '12/45:р*', hosts: ['WS?1'], ext: 'pdf' }])).toEqual(['12-45-р-_WS-1.pdf']);
    expect(safePart('  ..a<b>"c"|d.. ')).toBe('a-b--c--d');
  });

  it('совпадающие имена — _2, _3; без номера — «без номера»', () => {
    expect(zipNames([
      { docNumber: '1', hosts: ['H'], ext: 'pdf' },
      { docNumber: '1', hosts: ['h'], ext: 'PDF' },
      { docNumber: '1', hosts: ['H'], ext: 'pdf' },
      { docNumber: '', hosts: [], ext: 'jpg' },
    ])).toEqual(['1_H.pdf', '1_h_2.pdf', '1_H_3.pdf', 'без номера.jpg']);
  });

  it('скан — со своим расширением', () => {
    expect(extOf('image/jpeg', 'scan.JPEG')).toBe('jpg');
    expect(extOf('application/pdf', 'x')).toBe('pdf');
    expect(extOf('application/octet-stream', 'a.tiff')).toBe('tiff');
  });
});
