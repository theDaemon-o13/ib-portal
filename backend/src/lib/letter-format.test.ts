import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { columnWidth, contrast, filterStyle, frontendLetterFormatModule, imageAlign, imageWidth, normalizeHex, parseStyle } from './letter-format.js';

describe('оформление писем: разбор style (1.13.11)', () => {
  it('по объявлениям: кавычки и скобки не делят, комментарии вырезаются, !important — признаком', () => {
    expect(parseStyle("font-family:'Times; New', serif; color : #abcdef ;/* x:y */ COLOR:red !important")).toEqual([
      { property: 'font-family', value: "'Times; New', serif", important: false },
      { property: 'color', value: '#abcdef', important: false },
      { property: 'color', value: 'red', important: true },
    ]);
    expect(parseStyle('background:url(a;b);x')).toEqual([{ property: 'background', value: 'url(a;b)', important: false }]);
  });

  it('цвет — только #RRGGBB, в верхнем регистре', () => {
    expect(normalizeHex(' #dc2626 ')).toBe('#DC2626');
    for (const bad of ['red', 'rgb(1,2,3)', '#fff', '#12345G', '#1234567', 'transparent']) expect(normalizeHex(bad)).toBeNull();
  });
});

describe('оформление писем: фильтр style по тегам', () => {
  it('каждое разрешённое значение проходит, вид канонический и устойчивый', () => {
    const tnr = "font-family:'Times New Roman', Times, serif";
    expect(filterStyle('span', `${tnr};color:#dc2626;background-color:#FEF08A`)).toBe(`${tnr};color:#DC2626;background-color:#FEF08A`);
    expect(filterStyle('span', 'font-family:"times new roman",times,serif')).toBe(tnr);
    expect(filterStyle('u', 'text-decoration-color:#2563eb')).toBe('text-decoration-color:#2563EB');
    for (const tag of ['p', 'h2', 'h3', 'h4', 'li']) for (const a of ['left', 'center', 'right', 'justify']) expect(filterStyle(tag, `text-align: ${a.toUpperCase()}`)).toBe(`text-align:${a}`);
    for (const tag of ['td', 'th']) expect(filterStyle(tag, 'background-color:#eff6ff')).toBe('background-color:#EFF6FF');
    const once = filterStyle('span', `color:#DC2626;${tnr}`);
    expect(filterStyle('span', once ?? '')).toBe(once);
  });

  it('недопустимое удаляется: шрифт, цвет, выравнивание, url(), expression, !important, повтор, чужое свойство и тег', () => {
    expect(filterStyle('span', 'font-family:Calibri')).toBeNull();
    expect(filterStyle('span', 'font-family:Arial')).toBeNull();
    for (const c of ['red', 'rgb(220,38,38)', '#fff', '#12345G', 'var(--x)', 'expression(alert(1))']) expect(filterStyle('span', `color:${c}`)).toBeNull();
    expect(filterStyle('p', 'text-align:start')).toBeNull();
    expect(filterStyle('u', 'text-decoration-color:blue')).toBeNull();
    expect(filterStyle('span', 'background-color:#FEF08A;background-image:url(https://x.example/a.png)')).toBe('background-color:#FEF08A');
    expect(filterStyle('span', 'color:#DC2626 !important')).toBeNull();
    expect(filterStyle('span', 'color:#DC2626;color:#2563EB')).toBeNull();
    expect(filterStyle('span', 'color:#DC2626;position:fixed;font-size:40px')).toBe('color:#DC2626');
    expect(filterStyle('p', 'background-color:#FEF08A')).toBeNull();
    expect(filterStyle('a', 'color:#DC2626')).toBeNull();
    expect(filterStyle('span', 'color:/* */#DC2626')).toBe('color:#DC2626');
  });

  it('картинка и столбец: положение из списка, ширина 40–544, столбец 10–100%', () => {
    for (const a of ['left', 'center', 'right', 'wrap-left', 'wrap-right']) expect(imageAlign(a)).toBe(a);
    expect(imageAlign('float')).toBeNull();
    expect([imageWidth('40'), imageWidth('544'), imageWidth('39'), imageWidth('545'), imageWidth('50%'), imageWidth('1e2')]).toEqual([40, 544, null, null, null, null]);
    expect([columnWidth('40%'), columnWidth(' 10 % '), columnWidth('9%'), columnWidth('101%'), columnWidth('200')]).toEqual([40, 10, null, null, null]);
  });

  it('контраст по WCAG: чёрный на белом — 21, жёлтый маркер на белом тексте — ниже 4,5', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrast('#0F172A', '#FEF08A')).toBeGreaterThan(4.5);
    expect(contrast('#FFFFFF', '#FEF08A')).toBeLessThan(4.5);
  });

  it('сгенерированный модуль frontend совпадает со списком backend', () => {
    const file = readFileSync(new URL('../../../frontend/src/api/generated/letter-format.ts', import.meta.url), 'utf8');
    expect(file).toBe(frontendLetterFormatModule());
  });
});
