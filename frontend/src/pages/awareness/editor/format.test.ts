import { describe, expect, it } from 'vitest';
import { contrastWarning, swatchLabel } from './ColorPalette';
import { addFavorite, cleanFavorites, FAVORITE_SET, FAVORITES_FULL, readFavorites, removeFavorite, writeFavorites, type KeyValueStore } from './favorites';
import { canonicalEditorHtml, cleanPastedHtml, columnWidths, contrast, letterStyleCss, resizeColumn, TNR_CSS, toFont, toHex } from './format';

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

describe('ширина столбцов (1.13.11)', () => {
  it('изменение одного столбца пересчитывает остальные пропорционально, сумма 100%, минимум 10%', () => {
    expect(resizeColumn([50, 50], 0, 40)).toEqual([40, 60]);
    expect(resizeColumn([25, 25, 50], 0, 50)).toEqual([50, 17, 33]);
    const w = resizeColumn([20, 30, 50], 1, 95);
    expect(sum(w)).toBe(100);
    expect(w).toEqual([10, 80, 10]);
    expect(resizeColumn([40, 60], 1, 3)).toEqual([90, 10]);
    for (const n of [2, 3, 4, 5, 7]) {
      for (let i = 0; i < n; i++) for (const pct of [0, 12, 33, 50, 77, 100]) {
        const r = resizeColumn(columnWidths(Array(n).fill(null)), i, pct);
        expect(sum(r)).toBe(100);
        expect(Math.min(...r)).toBeGreaterThanOrEqual(10);
      }
    }
    expect(resizeColumn([100], 0, 40)).toEqual([100]);
  });

  it('незаданные ширины — равные; заданные приводятся к 100', () => {
    expect(columnWidths([null, null, null])).toEqual([34, 33, 33]);
    expect(columnWidths([40, null])).toEqual([50, 50]);
    expect(columnWidths([30, 30])).toEqual([50, 50]);
  });
});

describe('цвета и контраст', () => {
  it('вставка приводит цвета к HEX; прозрачный, auto и прочее — нет', () => {
    expect([toHex('#abc'), toHex('rgb(220, 38, 38)'), toHex('rgba(220,38,38,1)'), toHex('yellow'), toHex('#dc2626')]).toEqual(['#AABBCC', '#DC2626', '#DC2626', '#FFFF00', '#DC2626']);
    expect([toHex('rgba(0,0,0,0.5)'), toHex('auto'), toHex('windowtext'), toHex('transparent'), toHex('')]).toEqual([null, null, null, null, null]);
  });

  it('контраст: предупреждение «Текст будет плохо виден» ниже 4,5:1 — только для фона и заливки', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastWarning('highlight', '#FEF08A', null)).toBeNull();
    expect(contrastWarning('highlight', '#1E3A8A', null)).toBe('Текст будет плохо виден');
    expect(contrastWarning('cell', '#1E3A8A', '#FFFFFF')).toBeNull();
    expect(contrastWarning('text', '#FEF08A', null)).toBeNull();
  });

  it('подпись образца для экранного диктора', () => {
    expect(swatchLabel('#DC2626', 'Красный', true)).toBe('Красный, #DC2626, в избранном');
    expect(swatchLabel('#123456', null, false)).toBe('#123456');
  });

  it('стиль span — в каноническом порядке, как у backend', () => {
    expect(letterStyleCss({ backgroundColor: '#FEF08A', color: '#DC2626', fontFamily: TNR_CSS })).toBe(`font-family:${TNR_CSS};color:#DC2626;background-color:#FEF08A`);
    expect(toFont('"Times New Roman", serif')).toBe(TNR_CSS);
    expect(toFont('Calibri, sans-serif')).toBeNull();
  });
});

describe('избранные цвета', () => {
  it('добавить, повтор не добавляется, 13-й — сообщение, удалить', () => {
    let list: string[] = [];
    list = addFavorite(list, '#dc2626').list;
    expect(list).toEqual(['#DC2626']);
    expect(addFavorite(list, '#DC2626')).toEqual({ list: ['#DC2626'], error: null });
    for (let i = 1; i < 12; i++) list = addFavorite(list, `#0000${String(i).padStart(2, '0')}`).list;
    expect(list).toHaveLength(12);
    expect(addFavorite(list, '#FFFFFF')).toEqual({ list, error: FAVORITES_FULL });
    expect(FAVORITES_FULL).toBe('В избранном не больше 12 цветов, удалите лишний');
    expect(removeFavorite(list, '#dc2626')).toHaveLength(11);
    expect(addFavorite([], 'red').error).not.toBeNull();
  });

  it('наборы: цвет текста и подчёркивание — один, фон текста и заливка — другой', () => {
    expect([FAVORITE_SET.text, FAVORITE_SET.underline, FAVORITE_SET.highlight, FAVORITE_SET.cell]).toEqual(['text', 'text', 'bg', 'bg']);
  });

  it('хранятся по пользователю и набору и читаются после перезагрузки; испорченное — не ломает', () => {
    const data = new Map<string, string>();
    const store: KeyValueStore = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
    writeFavorites(store, 'u1', 'text', ['#DC2626', '#2563EB']);
    writeFavorites(store, 'u1', 'bg', ['#FEF08A']);
    expect(readFavorites(store, 'u1', 'text')).toEqual(['#DC2626', '#2563EB']);
    expect(readFavorites(store, 'u1', 'bg')).toEqual(['#FEF08A']);
    expect(readFavorites(store, 'u2', 'text')).toEqual([]);
    data.set('ibportal.awareness.favoriteColors.u1.text', '{bad');
    expect(readFavorites(store, 'u1', 'text')).toEqual([]);
    expect(cleanFavorites(['#dc2626', '#DC2626', 'red', 5, ...Array(20).fill('#000001')])).toEqual(['#DC2626', '#000001']);
  });
});

describe('вставка из Word и Outlook', () => {
  const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{margin:0}</style></head><body>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]-->
<p class=MsoNormal align=center style='margin:0cm;text-align:center;line-height:115%'><span style='font-family:"Times New Roman",serif;mso-fareast-font-family:Calibri;color:#C00000'>Заголовок<o:p></o:p></span></p>
<p class=MsoNormal><span style='font-family:Calibri;color:windowtext'>Calibri и авто</span> <span style='background:yellow;mso-highlight:yellow'>маркер</span>
<u><span style='text-decoration-color:#0070C0'>подчёркнуто</span></u> <span style='text-decoration:underline;text-underline-color:red'>ещё</span>
<span style='color:#1A1A1A;background:white'>почти чёрный</span></p>
<table class=MsoTableGrid><tr><td width=200 style='width:150.0pt;background:#DEEAF6;mso-shading:white'><p>А</p></td><td width=300 style='width:225pt'><p>Б</p></td></tr>
<tr><td style='background:#FFFFFF'><p>1</p></td><td bgcolor="#FFF2CC"><p>2</p></td></tr></table></body></html>`;
  const out = cleanPastedHtml(word);

  it('остаётся только разрешённое: Times New Roman, цвет, фон, подчёркивание с цветом, выравнивание, заливка, ширина столбцов', () => {
    expect(out).toContain(`<p style="text-align:center"><span style="font-family:${TNR_CSS.replace(/'/g, "'")};color:#C00000">Заголовок</span></p>`);
    expect(out).toContain('<span style="background-color:#FFFF00">маркер</span>');
    expect(out).toContain('<u style="text-decoration-color:#0070C0">подчёркнуто</u>');
    expect(out).toContain('<u style="text-decoration-color:#FF0000">ещё</u>');
    expect(out).toContain('<td width="40%" style="background-color:#DEEAF6"><p>А</p></td><td width="60%"><p>Б</p></td>');
    expect(out).toContain('<td><p>1</p></td><td style="background-color:#FFF2CC"><p>2</p></td>');
  });

  it('Calibri, «auto»-цвет, почти чёрный текст, белый фон, MsoNormal, mso-стили, комментарии и стили Word — отброшены', () => {
    expect(out).toContain('Calibri и авто');
    expect(out).toContain('почти чёрный');
    expect(out).not.toMatch(/Calibri;|windowtext|#1A1A1A|white|#FFFFFF|Mso|mso-|class=|line-height|<style|<xml|<o:|<!--|margin/i);
  });

  it('цветное подчёркивание из Word (u со span) — подчёркивание сохраняется', () => {
    expect(cleanPastedHtml(`<u><span style='text-decoration-color:#0070C0'>т</span></u>`)).toBe('<u style="text-decoration-color:#0070C0">т</u>');
  });
});

describe('канонический HTML редактора', () => {
  it('rgb() и кавычки браузера → #RRGGBB и канонический шрифт; лишние свойства отброшены', () => {
    expect(canonicalEditorHtml('<p><span style="color: rgb(124, 58, 237); font-family: &quot;Times New Roman&quot;, Times, serif; font-size: 12px;">т</span> <u style="text-decoration-color: rgb(37, 99, 235);">у</u></p>'))
      .toBe(`<p><span style="font-family:${TNR_CSS};color:#7C3AED">т</span> <u style="text-decoration-color:#2563EB">у</u></p>`);
    expect(canonicalEditorHtml('<p style="text-align: center;">ц</p><td style="background-color: rgb(253, 230, 138);"><p>я</p></td>'))
      .toBe('<p style="text-align:center">ц</p><td style="background-color:#FDE68A"><p>я</p></td>');
    expect(canonicalEditorHtml('<p style="margin: 0;">без стиля</p><a style="color:#DC2626">с</a>')).toBe('<p>без стиля</p><a style="color:#DC2626">с</a>');
  });
});
