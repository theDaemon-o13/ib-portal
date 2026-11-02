import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { cellString, isSpreadsheetML, parseSpreadsheetML, readSheets } from './spreadsheetml.js';

const book = (body: string, prolog = '') => Buffer.from(
  `\uFEFF<?xml version="1.0"?>${prolog}<?mso-application progid="Excel.Sheet"?>`
  + `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40">${body}</Workbook>`,
);

describe('SpreadsheetML', () => {
  it('распознаётся по содержимому', () => {
    expect(isSpreadsheetML(book(''))).toBe(true);
    expect(isSpreadsheetML(Buffer.from('<?xml version="1.0"?><root/>'))).toBe(false);
  });

  it('ss:Index, ss:MergeAcross, типы ячеек, пропуск строк, форматированный текст', () => {
    const sheets = parseSpreadsheetML(book(`
      <Worksheet ss:Name="Summary"><Table>
        <Row><Cell ss:MergeAcross="2"><Data ss:Type="String">Kaspersky Security Center</Data></Cell><Cell><Data ss:Type="Number">7</Data></Cell></Row>
        <Row ss:Index="3"><Cell ss:Index="2"><Data ss:Type="DateTime">2026-10-01T00:00:00.000</Data></Cell></Row>
        <Row><Cell><ss:Data ss:Type="String"><html:B>жирный</html:B> текст</ss:Data></Cell></Row>
      </Table></Worksheet>
      <Worksheet ss:Name="Details"><Table><Row><Cell><Data ss:Type="String">Устройство</Data></Cell></Row></Table></Worksheet>`), 100);
    expect(sheets.map((s) => s.name)).toEqual(['Summary', 'Details']);
    const rows = sheets[0]?.rows ?? [];
    expect(rows[0]?.[0]).toBe('Kaspersky Security Center');
    expect(rows[0]?.[3]).toBe(7); // MergeAcross="2" занял колонки 2 и 3
    expect(rows[1]).toEqual([]);
    expect(rows[2]?.[0]).toBeNull();
    expect((rows[2]?.[1] as Date).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(cellString(rows[3]?.[0])).toBe('жирный текст');
  });

  it('DTD и сущности отклоняются до разбора', () => {
    const evil = book('<Worksheet ss:Name="A"><Table><Row><Cell><Data ss:Type="String">&xxe;</Data></Cell></Row></Table></Worksheet>',
      '<!DOCTYPE Workbook [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>');
    expect(() => parseSpreadsheetML(evil, 100)).toThrow(/DTD или сущностей/);
    const entityOnly = book('<!ENTITY a "b"><Worksheet ss:Name="A"/>');
    expect(() => parseSpreadsheetML(entityOnly, 100)).toThrow(/DTD или сущностей/);
  });

  it('повреждённый XML и лимит строк', () => {
    expect(() => parseSpreadsheetML(book('<Worksheet ss:Name="A"><Table><Row>'), 100)).toThrow(/повреждён/);
    const many = Array.from({ length: 5 }, () => '<Row><Cell><Data ss:Type="Number">1</Data></Cell></Row>').join('');
    expect(() => parseSpreadsheetML(book(`<Worksheet ss:Name="A"><Table>${many}</Table></Worksheet>`), 3)).toThrow(/больше 3 строк/);
  });

  it('.xlsx читается в тот же вид, неизвестный формат — ошибка', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Details');
    ws.addRow(['Устройство', 'Созданы']);
    ws.addRow(['TEST-PC01NB', new Date('2026-10-01T00:00:00Z')]);
    const sheets = await readSheets(Buffer.from(await wb.xlsx.writeBuffer()), 100);
    expect(sheets[0]?.rows[1]?.[0]).toBe('TEST-PC01NB');
    expect(cellString(sheets[0]?.rows[1]?.[1])).toBe('2026-10-01');
    await expect(readSheets(Buffer.from('просто текст'), 100)).rejects.toThrow(/Формат не распознан/);
  });
});
