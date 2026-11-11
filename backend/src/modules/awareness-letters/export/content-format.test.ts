// Оформление 1.13.11 в почтовом HTML (docs/plans/release-1.13.11.md, раздел 4): снимки результата.
import { describe, expect, it } from 'vitest';
import { contentToMail } from './content.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TNR = "font-family:'Times New Roman', Times, serif";

describe('выгрузка: оформление текста', () => {
  it('Times New Roman, цвет и фон — span внутри абзаца макета (Arial 15/23 не меняется)', () => {
    expect(contentToMail(`<p>Обычный <span style="${TNR}">Times</span> <span style="color:#DC2626">красный</span> <span style="background-color:#FEF08A">маркер</span></p>`)).toMatchSnapshot();
  });

  it('подчёркивание цветом текста — как раньше, цветное — text-decoration-color', () => {
    const out = contentToMail('<p><u>обычное</u> и <u style="text-decoration-color:#2563EB">синее</u></p>');
    expect(out).toContain('<u>обычное</u>');
    expect(out).toContain('<u style="text-decoration:underline;text-decoration-color:#2563EB;">синее</u>');
    expect(out).toMatchSnapshot();
  });

  it('четыре выравнивания — align и text-align у абзаца, заголовка и пункта списка', () => {
    const out = contentToMail('<p style="text-align:left">л</p><p style="text-align:center">ц</p><p style="text-align:right">п</p><p style="text-align:justify">ш</p>'
      + '<h2 style="text-align:center">З</h2><ul><li style="text-align:right"><p>пункт</p></li></ul>');
    for (const a of ['left', 'center', 'right', 'justify']) expect(out).toContain(`<p align="${a}" style="margin:0 0 14px 0;`);
    expect(out).toMatch(/<h2 align="center" style="[^"]*text-align:center;">/);
    expect(out).toMatch(/<li align="right" style="[^"]*text-align:right;">/);
    expect(out).toMatchSnapshot();
  });
});

describe('выгрузка: картинки', () => {
  it('пять положений: на отдельной строке — абзац с align, с обтеканием — img align с hspace и max-width:45%', () => {
    const img = (a: string) => contentToMail(`<img src="${PNG}" data-align="${a}" width="200" />`);
    for (const a of ['left', 'center', 'right']) {
      expect(img(a)).toContain(`<p align="${a}" style="margin:0 0 14px 0;text-align:${a};`);
      expect(img(a)).toContain('width="200" style="display:inline-block;max-width:100%;height:auto;border:0;"');
    }
    expect(img('wrap-left')).toContain('width="200" align="left" hspace="12" vspace="4" style="max-width:45%;height:auto;border:0;margin:0 12px 8px 0;"');
    expect(img('wrap-right')).toContain('align="right" hspace="12" vspace="4" style="max-width:45%;height:auto;border:0;margin:0 0 8px 12px;"');
    for (const a of ['left', 'center', 'right', 'wrap-left', 'wrap-right']) expect(img(a)).not.toMatch(/float|<div|class=/);
    expect(['left', 'center', 'right', 'wrap-left', 'wrap-right'].map(img)).toMatchSnapshot();
  });

  it('картинка без положения — как в 1.13.10', () => {
    expect(contentToMail(`<img src="${PNG}" width="120" />`)).toBe(`<img src="${PNG}" alt="" width="120" style="display:block;max-width:100%;height:auto;border:0;margin:0 0 14px 0;">`);
  });
});

describe('выгрузка: таблицы', () => {
  it('ширина столбцов в % и заливка — width="100%", width у первой строки, bgcolor и background-color', () => {
    const out = contentToMail('<table><tbody><tr><th width="40%" style="background-color:#EFF6FF"><p>Временный</p></th><th width="60%"><p>Постоянный</p></th></tr>'
      + '<tr><td style="background-color:#FFFBEB"><p>1</p></td><td><p>2</p></td></tr></tbody></table>');
    expect(out).toContain('<table width="100%" role="presentation"');
    expect(out).toContain('style="width:100%;border-collapse:collapse;');
    expect(out).toContain('<th width="40%" bgcolor="#EFF6FF" style="');
    expect(out).toMatch(/<th width="40%" bgcolor="#EFF6FF" style="[^"]*font-weight:bold;background-color:#EFF6FF;">/);
    expect(out).toContain('<th width="60%" style="');
    expect(out).toContain('<td bgcolor="#FFFBEB" style="');
    expect(out).not.toMatch(/<td width=/);
    expect(out).toMatchSnapshot();
  });

  it('таблица без ширины и заливки — как в 1.13.10', () => {
    const out = contentToMail('<table><tbody><tr><th><p>А</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>');
    expect(out).toBe('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px 0;"><tbody><tr>'
      + '<th style="border:1px solid #CBD5E1;padding:6px 8px;vertical-align:top;text-align:left;font-family:Arial, \'Segoe UI\', Helvetica, sans-serif;font-size:14px;line-height:20px;color:#0F172A;background:#F1F5F9;font-weight:bold;"><p style="margin:0;font-family:Arial, \'Segoe UI\', Helvetica, sans-serif;font-size:15px;line-height:23px;color:#0F172A;">А</p></th></tr>'
      + '<tr><td style="border:1px solid #CBD5E1;padding:6px 8px;vertical-align:top;text-align:left;font-family:Arial, \'Segoe UI\', Helvetica, sans-serif;font-size:14px;line-height:20px;color:#0F172A;"><p style="margin:0;font-family:Arial, \'Segoe UI\', Helvetica, sans-serif;font-size:15px;line-height:23px;color:#0F172A;">1</p></td></tr></tbody></table>');
  });
});
