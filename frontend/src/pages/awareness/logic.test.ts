import { describe, expect, it } from 'vitest';
import { cadenceOf, DEFAULT_CADENCE, formOfCadence, leadDaysProblem, hasChanges, htmlToLines, letterMarks, lineDiff, templateVariables, withoutApprovalComment } from './logic';

describe('сравнение версий', () => {
  it('текст из HTML построчно: абзацы, списки, таблица, ссылка, изображение, подпись', () => {
    const html = '<h2>Осторожно</h2><p>Не открывайте <a href="https://x.example">ссылки</a> &amp; вложения.</p>'
      + '<ul><li>раз</li><li>два</li></ul><table><tr><th>А</th><th>Б</th></tr></table><p><img src="data:image/png;base64,AA"></p>'
      + '<div data-ib-fragment="signature"></div>';
    expect(htmlToLines(html)).toEqual(['Осторожно', 'Не открывайте ссылки (https://x.example) & вложения.', '• раз', '• два', 'А Б', '[изображение]', '[Подпись ИБ]']);
  });

  it('построчно: удалённые, добавленные и общие строки по порядку', () => {
    const d = lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
    expect(d).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'x' }, { kind: 'same', text: 'c' }, { kind: 'add', text: 'd' },
    ]);
    expect(hasChanges(lineDiff(['a'], ['a']))).toBe(false);
    expect(lineDiff([], ['a'])).toEqual([{ kind: 'add', text: 'a' }]);
  });
});

describe('пометки и причины', () => {
  it('«только RU», «без независимого согласования», «отправлено без согласования»', () => {
    expect(letterMarks({ langMark: 'only_tj', selfApproved: true, sentWithoutApproval: true }))
      .toEqual(['только TJ', 'без независимого согласования', 'отправлено без согласования']);
    expect(letterMarks({ langMark: null })).toEqual([]);
  });

  it('причина отправки без согласования — с приставкой, без повтора', () => {
    expect(withoutApprovalComment(' атака идёт сейчас ')).toBe('Отправлено без согласования: атака идёт сейчас');
    expect(withoutApprovalComment('Отправлено без согласования: x')).toBe('Отправлено без согласования: x');
    expect(withoutApprovalComment('  ')).toBe('');
  });
});

describe('переменные шаблона', () => {
  it('из тем и текстов, одинаковое имя (регистр, пробелы, «ё») — одна; {{подпись}} — служебная', () => {
    expect(templateVariables(['Осторожно: {{Схема}}', 'Эҳтиёт: {{схема}}', '<p>{{Дата  звонка}} от {{ОТПРАВИТЕЛЬ}}</p><p>{{подпись}}</p>', '<p>{{ёлка}} {{елка}} {{a &amp; b}}</p>']))
      .toEqual([
        { key: 'схема', label: 'Схема' }, { key: 'дата звонка', label: 'Дата звонка' }, { key: 'отправитель', label: 'ОТПРАВИТЕЛЬ' },
        { key: 'елка', label: 'ёлка' }, { key: 'a & b', label: 'a & b' },
      ]);
  });
});

describe('периодичность правила', () => {
  it('форма → правило → форма для каждого вида', () => {
    const kinds = ['monthly', 'twice_monthly', 'quarterly', 'yearly', 'weekly'] as const;
    for (const kind of kinds) {
      const f = { ...DEFAULT_CADENCE, kind, day: 31, day2: 15, month: 2, quarterMonth: 3, every: 4, weekday: 5 };
      expect(formOfCadence(cadenceOf(f))).toMatchObject({ kind });
      expect(cadenceOf(formOfCadence(cadenceOf(f)))).toEqual(cadenceOf(f));
    }
    expect(cadenceOf({ ...DEFAULT_CADENCE, kind: 'twice_monthly', day: 1, day2: 15 })).toEqual({ kind: 'twice_monthly', days: [1, 15] });
  });

  it('опережение 7–90: меньше 7 — нельзя (этап «черновик» за 7 дней)', () => {
    expect([leadDaysProblem(6), leadDaysProblem(7), leadDaysProblem(90), leadDaysProblem(91)].map((x) => x === null))
      .toEqual([false, true, true, false]);
    expect(leadDaysProblem(6)).toContain('за 7 дней');
  });
});
