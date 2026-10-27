import { describe, expect, it } from 'vitest';
import { macroDocx, makeZip, tinyDocx, tinyJpg, tinyPdf, tinyPng, tinyXlsx } from '../test/files-fixture.js';
import { checkFile, cleanFileName, decodeText, MAX_FILE_BYTES } from './file-type.js';

const code = (name: string, buf: Buffer) => {
  const r = checkFile(name, buf);
  return r.ok ? `ok:${r.mime}` : r.code;
};

describe('тип файла по содержимому', () => {
  it('разрешённые типы с правильным расширением проходят, MIME — по содержимому', () => {
    expect(code('Протокол.pdf', tinyPdf())).toBe('ok:application/pdf');
    expect(code('скрин.PNG', tinyPng())).toBe('ok:image/png');
    expect(code('фото.jpeg', tinyJpg())).toBe('ok:image/jpeg');
    expect(code('выгрузка.csv', Buffer.from('Логин;Срок\nadmin;90\n'))).toBe('ok:text/csv');
    expect(code('заметка.txt', Buffer.from('MinimumPasswordLength = 12'))).toBe('ok:text/plain');
    expect(code('форма.docx', tinyDocx())).toBe('ok:application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(code('отчёт.xlsx', tinyXlsx())).toBe('ok:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('подмена расширения: содержимое другого типа под разрешённым расширением отклоняется', () => {
    expect(code('скрин.png', tinyPdf())).toBe('FILE_TYPE_MISMATCH');
    expect(code('документ.pdf', tinyPng())).toBe('FILE_TYPE_MISMATCH');
    expect(code('отчёт.xlsx', tinyDocx())).toBe('FILE_TYPE_MISMATCH');
    // Исполняемый файл и произвольный zip под видом документа.
    expect(code('setup.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]))).toBe('FILE_TYPE_MISMATCH');
    expect(code('архив.docx', makeZip({ 'a.txt': 'x' }))).toBe('FILE_TYPE_MISMATCH');
  });

  it('SVG и HTML не проходят ни под своим, ни под чужим расширением', () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    const html = Buffer.from('\uFEFF  <!DOCTYPE html><html><script>alert(1)</script></html>');
    expect(code('картинка.svg', svg)).toBe('BAD_FILE_TYPE');
    expect(code('страница.html', html)).toBe('BAD_FILE_TYPE');
    expect(code('картинка.png', svg)).toBe('FILE_TYPE_MISMATCH');
    expect(code('заметка.txt', html)).toBe('FILE_TYPE_MISMATCH');
    expect(code('данные.csv', Buffer.from('a;b\n<svg onload=alert(1)>\n'))).toBe('FILE_TYPE_MISMATCH');
  });

  it('офисный файл с макросами отклоняется', () => {
    expect(code('форма.docx', macroDocx())).toBe('FILE_TYPE_MISMATCH');
  });

  it('пустой, без расширения, больше 25 МБ — отказ', () => {
    expect(code('пусто.txt', Buffer.alloc(0))).toBe('EMPTY_FILE');
    expect(code('README', Buffer.from('text'))).toBe('BAD_FILE_TYPE');
    expect(code('big.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 0x41))).toBe('FILE_TOO_LARGE');
    expect(code('ровно.txt', Buffer.alloc(MAX_FILE_BYTES, 0x41))).toBe('ok:text/plain');
  });

  it('имя без пути и управляющих символов; текст Windows-1251 читается', () => {
    expect(cleanFileName('C:\\Users\\a\\..\\Протокол\u0007.pdf')).toBe('Протокол.pdf');
    expect(cleanFileName('../../etc/passwd.txt')).toBe('passwd.txt');
    const cp1251 = Buffer.from([0xcf, 0xe0, 0xf0, 0xee, 0xeb, 0xfc]); // «Пароль»
    expect(decodeText(cp1251)).toBe('Пароль');
    expect(code('пароли.csv', cp1251)).toBe('ok:text/csv');
  });
});
