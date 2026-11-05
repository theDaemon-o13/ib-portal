import { describe, expect, it } from 'vitest';
import { attachmentDisposition, buildEml, encodeHeader } from './eml.js';
import { composeLetter, inlineMailStyles, mailDocument, substituteSignature } from './html.js';
import { htmlToText } from './text.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SIG = '<div data-ib-fragment="signature"></div>';
const fixedBoundary = () => {
  let n = 0;
  return () => `b${++n}`;
};

/** Разобрать .eml на заголовки и тело и раскодировать base64-части — для проверок. */
function parts(eml: string) {
  const [head = '', ...rest] = eml.split('\r\n\r\n');
  return { head, body: rest.join('\r\n\r\n') };
}
const decodeB64 = (s: string) => Buffer.from(s.replace(/\r\n/g, ''), 'base64').toString('utf8');

describe('RFC 2047', () => {
  it('ASCII — как есть; кириллица — кодированные слова ≤ 75 символов, символ не режется', () => {
    expect(encodeHeader('Subject', 'Phishing alert')).toBe('Subject: Phishing alert');
    const subject = 'Осторожно: поддельные письма о выигрыше в лотерею от имени банка / Эҳтиёт: мактубҳои қалбакӣ';
    const h = encodeHeader('Subject', subject);
    const lines = h.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    const words = h.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? [];
    expect(words.every((w) => w.length <= 75)).toBe(true);
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8'));
    expect(decoded.join('')).toBe(subject);
    expect(decoded.every((d) => !d.includes('�'))).toBe(true);
  });

  it('переводы строк в теме не создают новых заголовков', () => {
    expect(encodeHeader('Subject', 'a\r\nBcc: x@example.org')).toBe('Subject: a Bcc: x@example.org');
  });
});

describe('.eml', () => {
  const html = mailDocument(`<p>Текст</p><img src="data:image/png;base64,${PNG}" alt="лого" /><p>ещё</p><img src="data:image/png;base64,${PNG}" />`);
  const eml = buildEml({ subject: 'Учебное письмо', html, text: 'Текст\n[изображение: лого]', boundary: fixedBoundary() });

  it('заголовки: X-Unsent, тема по RFC 2047, без From, To и Date; переводы строк CRLF', () => {
    const { head } = parts(eml);
    expect(head.split('\r\n')).toEqual([
      'MIME-Version: 1.0',
      'X-Unsent: 1',
      `Subject: =?UTF-8?B?${Buffer.from('Учебное письмо').toString('base64')}?=`,
      'Content-Type: multipart/alternative; boundary="b1"',
    ]);
    expect(eml).not.toMatch(/^(From|To|Date):/m);
    expect(eml.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('multipart/alternative: text/plain и multipart/related с HTML и изображением по Content-ID', () => {
    expect(eml).toContain('--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64');
    expect(eml).toContain('--b1\r\nContent-Type: multipart/related; boundary="b2"; type="text/html"');
    const htmlPart = /--b2\r\nContent-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--b2/.exec(eml);
    const decoded = decodeB64(htmlPart?.[1] ?? '');
    const cids = [...decoded.matchAll(/src="cid:([^"]+)"/g)].map((m) => m[1]);
    // Одинаковое изображение дважды — одна часть, две ссылки.
    expect(cids).toHaveLength(2);
    expect(new Set(cids).size).toBe(1);
    expect(decoded).not.toContain('data:image');
    expect(eml.match(/Content-ID: </g)).toHaveLength(1);
    expect(eml).toContain(`Content-ID: <${cids[0]}>\r\nContent-Disposition: inline; filename="image1.png"`);
    expect(eml.endsWith('--b2--\r\n--b1--\r\n')).toBe(true);
  });

  it('base64 строками не длиннее 76 символов', () => {
    const { body } = parts(eml);
    expect(body.split('\r\n').every((l) => l.length <= 76)).toBe(true);
  });

  it('имя файла для скачивания — с кириллицей по RFC 5987', () => {
    expect(attachmentDisposition('Письмо: «выигрыш»?', 'eml'))
      .toBe(`attachment; filename="______ _________.eml"; filename*=UTF-8''${encodeURIComponent('Письмо «выигрыш».eml')}`);
  });
});

describe('HTML для почты', () => {
  const c = { subjectRu: 'Тема RU', subjectTj: 'Мавзӯъ TJ', htmlRu: `<p>Русский</p>${SIG}`, htmlTj: `<p>Тоҷикӣ</p>${SIG}` };
  const sig = { htmlRu: '<p>Отдел ИБ</p>', htmlTj: '<p>Шуъбаи АИ</p>' };

  it('RU, TJ и RU+TJ: порядок, разделитель, тема «RU / TJ», подпись по языку', () => {
    expect(composeLetter(c, 'ru', sig)).toEqual({ subject: 'Тема RU', body: '<p style="margin:0 0 10px">Русский</p><div><p style="margin:0 0 10px">Отдел ИБ</p></div>' });
    const both = composeLetter(c, 'both', sig);
    expect(both.subject).toBe('Тема RU / Мавзӯъ TJ');
    expect(both.body.indexOf('Русский')).toBeLessThan(both.body.indexOf('<hr'));
    expect(both.body.indexOf('<hr')).toBeLessThan(both.body.indexOf('Тоҷикӣ'));
    expect(both.body).toContain('Шуъбаи АИ');
  });

  it('замороженная версия: подпись уже в тексте, блок не подставляется заново', () => {
    const frozen = { ...c, htmlRu: substituteSignature(c.htmlRu, '<p>Подпись на день отправки</p>') };
    expect(composeLetter(frozen, 'ru', null).body).toContain('Подпись на день отправки');
  });

  it('встроенные стили таблиц; абзац в ячейке без отступа', () => {
    expect(inlineMailStyles('<table><tbody><tr><td><p>1</p></td></tr></tbody></table>'))
      .toBe('<table style="border-collapse:collapse;margin:0 0 12px"><tbody><tr><td style="border:1px solid #c7c7cc;padding:6px 8px;vertical-align:top"><p style="margin:0">1</p></td></tr></tbody></table>');
  });
});

describe('текстовая часть', () => {
  it('заголовки, абзацы, списки, ссылки, таблица, изображение, линия', () => {
    const html = '<h2>Осторожно</h2><p>Не открывайте <strong>вложения</strong> &amp; ссылки.</p>'
      + '<ul><li><p>раз</p></li><li><p>два</p></li></ul><ol><li><p>первый</p></li><li><p>второй</p></li></ol>'
      + '<p><a href="https://bank.example/">сайт банка</a>, <a href="mailto:ib@example.org">ib@example.org</a></p>'
      + '<table><tbody><tr><th><p>Признак</p></th><th><p>Что делать</p></th></tr><tr><td><p>Срочность</p></td><td><p>Позвонить</p></td></tr></tbody></table>'
      + '<p><img src="data:image/png;base64,x" alt="пример" /></p><hr /><p>Конец<br />строка</p>';
    expect(htmlToText(html)).toBe([
      'Осторожно', '', 'Не открывайте вложения & ссылки.', '',
      '• раз', '• два', '', '1. первый', '2. второй', '',
      'сайт банка (https://bank.example/), ib@example.org', '',
      'Признак\tЧто делать', 'Срочность\tПозвонить', '',
      '[изображение: пример]', '', '———', '', 'Конец', 'строка',
    ].join('\n'));
  });
});
