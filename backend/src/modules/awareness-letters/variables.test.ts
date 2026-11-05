import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import {
  checkTemplate, extractVariables, fillTemplate, hasSignatureInSubject, SIGNATURE_BLOCK, signatureToBlock, unfilledInLetter,
} from './variables.js';

const t = (o: Partial<{ subjectRu: string; subjectTj: string; htmlRu: string; htmlTj: string }>) => ({ subjectRu: '', subjectTj: '', htmlRu: '', htmlTj: '', ...o });

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('ошибки не было');
}

describe('извлечение переменных', () => {
  it('из обеих тем и текстов, по порядку, одинаковое имя — одна переменная', () => {
    const { variables, problems } = extractVariables([
      'Осторожно: {{Название схемы}}', 'Эҳтиёт: {{название   схемы}}',
      '<p>Здравствуйте! {{Дата}} пришло письмо от {{отправитель}}.</p>', '<p>{{ДАТА}} {{отправитель TJ}}</p>',
    ]);
    expect(problems).toEqual([]);
    expect(variables).toEqual([
      { key: 'название схемы', label: 'Название схемы' },
      { key: 'дата', label: 'Дата' },
      { key: 'отправитель', label: 'отправитель' },
      { key: 'отправитель tj', label: 'отправитель TJ' },
    ]);
  });

  it('«ё» и «е» — одно имя; {{подпись}} служебная и в список не входит', () => {
    const { variables } = extractVariables(['{{Счёт}} {{счет}}', '<p>{{Подпись}}</p>']);
    expect(variables.map((v) => v.key)).toEqual(['счет']);
  });

  it('пустое, слишком длинное имя и больше 30 переменных — ошибки', () => {
    expect(extractVariables(['{{  }}']).problems).toEqual(['Пустая переменная {{}}']);
    expect(extractVariables([`{{${'а'.repeat(61)}}}`]).problems[0]).toMatch(/длиннее 60/);
    const many = Array.from({ length: 31 }, (_, i) => `{{п${i}}}`).join(' ');
    expect(extractVariables([many]).problems).toEqual(['Переменных больше 30: 31']);
  });

  it('подпись в теме шаблона запрещена', () => {
    expect(errorOf(() => checkTemplate(t({ subjectRu: 'Тема {{подпись}}' }))).code).toBe('BAD_TEMPLATE');
    expect(checkTemplate(t({ subjectRu: '{{тема}}', htmlRu: '<p>{{подпись}}</p>' }))).toEqual([{ key: 'тема', label: 'тема' }]);
  });
});

describe('подстановка', () => {
  const tpl = t({
    subjectRu: 'Осторожно: {{схема}}', subjectTj: 'Эҳтиёт: {{схема TJ}}',
    htmlRu: '<p>Схема: <strong>{{Схема}}</strong></p><p>{{подпись}}</p>',
    htmlTj: '<p>{{схема TJ}} — <a href="https://example.org/{{страница}}">сайт</a></p><p>Ҳурмат, {{подпись}}</p>',
  });

  it('подставляет значения в темы и тексты, подпись становится блоком', () => {
    const r = fillTemplate(tpl, { 'Схема': 'Выигрыш в лотерею', 'схема tj': 'Бурди лотерея', 'страница': 'news' });
    expect(r.subjectRu).toBe('Осторожно: Выигрыш в лотерею');
    expect(r.subjectTj).toBe('Эҳтиёт: Бурди лотерея');
    expect(r.htmlRu).toBe(`<p>Схема: <strong>Выигрыш в лотерею</strong></p>${SIGNATURE_BLOCK}`);
    expect(r.htmlTj).toBe(`<p>Бурди лотерея — <a href="https://example.org/news">сайт</a></p><p>Ҳурмат, ${SIGNATURE_BLOCK}</p>`);
  });

  it('значения экранируются: HTML из формы не попадает в письмо разметкой', () => {
    const r = fillTemplate(t({ htmlRu: '<p>{{x}}</p>' }), { x: '<img src=x onerror=alert(1)> & "кавычки"' });
    expect(r.htmlRu).toBe('<p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;кавычки&quot;</p>');
  });

  it('незаполненная или пустая переменная блокирует создание — со списком', () => {
    const e = errorOf(() => fillTemplate(tpl, { 'схема': 'Выигрыш', 'схема tj': '   ' }));
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe('UNFILLED_VARIABLES');
    expect(e.message).toBe('Заполните переменные: «схема TJ», «страница»');
  });

  it('переменная с сущностью в имени: {{a &amp; b}} — это «a & b»', () => {
    expect(fillTemplate(t({ htmlRu: '<p>{{a &amp; b}}</p>' }), { 'a & b': 'да' }).htmlRu).toBe('<p>да</p>');
  });

  it('незаполненные переменные письма — для блокировки «На согласование»', () => {
    expect(unfilledInLetter(t({ subjectRu: 'Тема', htmlRu: '<p>{{дата}} {{подпись}}</p>' }))).toEqual(['дата']);
    expect(unfilledInLetter(t({ htmlRu: `<p>текст</p>${SIGNATURE_BLOCK}` }))).toEqual([]);
  });

  it('{{подпись}} в письме — блок «Подпись ИБ» (абзац целиком или внутри строки), в любом написании; в теме — ошибка', () => {
    expect(signatureToBlock('<p>Текст</p><p> {{Подпись}} </p>')).toBe(`<p>Текст</p>${SIGNATURE_BLOCK}`);
    expect(signatureToBlock('<p>Ҳурмат, {{ подпись }}</p>')).toBe(`<p>Ҳурмат, ${SIGNATURE_BLOCK}</p>`);
    expect(signatureToBlock('<p>{{дата}}</p>')).toBe('<p>{{дата}}</p>');
    expect([hasSignatureInSubject('Тема {{ПОДПИСЬ}}'), hasSignatureInSubject('Тема {{дата}}')]).toEqual([true, false]);
  });
});
