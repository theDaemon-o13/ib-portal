import { describe, expect, it } from 'vitest';
import { hasChanges, htmlToLines, letterMarks, lineDiff, withoutApprovalComment } from './logic';

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
