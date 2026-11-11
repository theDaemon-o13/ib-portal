import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { checkLetterSize, DEFAULT_LETTER_LIMITS, imagesWarning, sanitizeLetterHtml, sniffImage } from './sanitize.js';

// Минимальные настоящие изображения: PNG 1×1 и GIF 1×1.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const s = (html: string) => sanitizeLetterHtml(html, { portalUrl: 'https://ib-portal.bank.example' });

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('ошибки не было');
}

describe('санитайзер писем', () => {
  it('оставляет разметку редактора: заголовки, списки, таблица, ссылка, кириллица и {{переменные}}', () => {
    const html = '<h2>Осторожно</h2><p><strong>Жирный</strong>, <em>курсив</em>, <u>подч.</u>, <s>зачёркн.</s> {{дата}}</p>'
      + '<ul><li><p>раз</p></li></ul><ol><li><p>два</p></li></ol>'
      + '<table><tbody><tr><th colspan="2" rowspan="1"><p>Заг</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>'
      + '<p><a href="https://example.org/news">сайт</a> и <a href="mailto:ib@example.org">почта</a></p><blockquote><p>цитата</p></blockquote><hr>';
    expect(s(html).html).toBe(html.replace('<hr>', '<hr />'));
  });

  it('вырезает script, iframe, object, embed, form, style и svg вместе с содержимым', () => {
    const r = s('<p>до</p><script>alert(1)</script><iframe src="https://evil.example"></iframe><object data="x"></object>'
      + '<embed src="x"><form action="https://evil.example"><input name="p"><button>Войти</button></form>'
      + '<style>p{color:red}</style><svg><script>alert(2)</script><text>t</text></svg><p>после</p>');
    expect(r.html).toBe('<p>до</p>Войти<p>после</p>');
  });

  it('вырезает обработчики on*, style, class, id и прочие атрибуты', () => {
    expect(s('<p onclick="alert(1)" style="color:red" class="x" id="y" onmouseover="z">текст</p>').html).toBe('<p>текст</p>');
    expect(s('<img src="data:image/png;base64,' + PNG + '" onerror="alert(1)" alt="лого" width="120" height="auto">').html)
      .toBe(`<img src="data:image/png;base64,${PNG}" alt="лого" width="120" />`);
  });

  it('javascript:, vbscript: и data: в ссылках — ссылка без адреса; в том числе замаскированные', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav&#x61;script:alert(1)', ' javascript:alert(1)', 'vbscript:x', 'data:text/html;base64,PHNjcmlwdD4=']) {
      expect(s(`<a href="${href}">ссылка</a>`).html).toBe('<a>ссылка</a>');
    }
  });

  it('внешние и относительные src изображений вырезаются и считаются; относительные ссылки — с пояснением', () => {
    const r = s('<p><img src="https://tracker.example/pixel.gif"><img src="/api/v1/files/1"><img src="//cdn.example/x.png"></p><a href="/tasks?task=1">задача</a>');
    expect(r.html).toBe('<p></p><a>задача</a>');
    expect(r.removed).toEqual(['ссылка без адреса сайта (относительная или другого вида)']);
    expect(r.removedImages).toBe(3);
  });

  it('вставка из Outlook и Word: картинки cid:, file:// и по адресу не пропадают молча — число и предупреждение', () => {
    const outlook = '<p>Коллеги!</p><p><img src="cid:image001.png@01DA1234.ABCD5678" alt="Логотип"></p>'
      + '<p><img src="file:///C:/Users/x/AppData/Local/Temp/msohtmlclip1/01/clip_image002.jpg"></p>'
      + `<p><img src="https://mail.example/img.png"><img src="data:image/png;base64,${PNG}"></p>`;
    const r = s(outlook);
    expect(r.removedImages).toBe(3);
    expect(r.images.length).toBe(1);
    expect(r.html).not.toMatch(/cid:|file:|mail\.example/);
    expect(imagesWarning(r.removedImages)).toEqual(['Не вставлено изображений: 3. Картинки по ссылке не поддерживаются — сохраните их файлом и вставьте заново']);
    expect(imagesWarning(0)).toEqual([]);
  });

  it('изображения data: — только PNG, JPEG, GIF, тип сверяется по сигнатуре', () => {
    const r = s(`<img src="data:image/png;base64,${PNG}"><img src="data:image/gif;base64,${GIF}">`);
    expect(r.images.map((i) => i.mime)).toEqual(['image/png', 'image/gif']);
    expect(r.images[0]?.bytes).toBe(Buffer.from(PNG, 'base64').length);
    // SVG и WebP не принимаются (вырезаются как неподходящие).
    expect(s('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">').html).toBe('');
    // PNG, заявленный как JPEG, — ошибка: картинку подменили или она повреждена.
    expect(errorOf(() => s(`<img src="data:image/jpeg;base64,${PNG}">`)).code).toBe('BAD_IMAGE');
    expect(errorOf(() => s('<img src="data:image/png;base64,PGh0bWw+">')).code).toBe('BAD_IMAGE');
  });

  it('ссылка на портал — 400 PORTAL_LINK', () => {
    const e = errorOf(() => s('<p><a href="https://IB-PORTAL.bank.example/tasks">открыть</a></p>'));
    expect([e.statusCode, e.code]).toEqual([400, 'PORTAL_LINK']);
    expect(s('<a href="https://bank.example/">сайт банка</a>').html).toBe('<a href="https://bank.example/">сайт банка</a>');
  });

  it('блок «Подпись ИБ» сохраняется, другие data-атрибуты — нет', () => {
    expect(s('<div data-ib-fragment="signature"></div>').html).toBe('<div data-ib-fragment="signature"></div>');
    expect(s('<div data-ib-fragment="other" data-x="1"><p>т</p></div>').html).toBe('<div><p>т</p></div>');
  });
});

describe('сигнатуры и лимиты', () => {
  it('сигнатуры PNG, JPEG, GIF', () => {
    expect(sniffImage(Buffer.from(PNG, 'base64'))).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from(GIF, 'base64'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('<svg/>'))).toBeNull();
  });

  it('изображение больше 1 МБ и письмо больше 2 МБ — 413; от 1 МБ — предупреждение', () => {
    const img = (bytes: number) => ({ mime: 'image/png' as const, bytes, sha256: 'x' });
    expect(errorOf(() => checkLetterSize(['<p></p>'], [img(1024 * 1024 + 1)], DEFAULT_LETTER_LIMITS)).code).toBe('IMAGE_TOO_LARGE');
    expect(checkLetterSize(['x'.repeat(600 * 1024), 'x'.repeat(500 * 1024)], [], DEFAULT_LETTER_LIMITS)).toEqual({ bytes: 1100 * 1024, warn: true });
    expect(checkLetterSize(['x'.repeat(100)], [], DEFAULT_LETTER_LIMITS).warn).toBe(false);
    const e = errorOf(() => checkLetterSize(['x'.repeat(1100 * 1024), 'я'.repeat(500 * 1024)], [], DEFAULT_LETTER_LIMITS));
    expect([e.statusCode, e.code]).toEqual([413, 'LETTER_TOO_LARGE']);
    expect(e.message).toMatch(/^Письмо 2100 КБ/);
  });
});

describe('санитайзер писем: оформление (1.13.11)', () => {
  const TNR = "font-family:'Times New Roman', Times, serif";

  it('разрешённое проходит: шрифт, цвет и фон у span, цвет подчёркивания, выравнивание, картинка, ширина и заливка ячеек', () => {
    const html = `<p style="text-align:center"><span style="${TNR};color:#DC2626;background-color:#FEF08A">текст</span> <u style="text-decoration-color:#2563EB">подч</u></p>`
      + '<h3 style="text-align:right">З</h3><ul><li style="text-align:justify"><p>п</p></li></ul>'
      + `<img src="data:image/png;base64,${PNG}" width="280" data-align="wrap-right" />`
      + '<table><tbody><tr><th width="40%" style="background-color:#1E3A8A"><p>А</p></th><td width="60%"><p>Б</p></td></tr></tbody></table>';
    expect(s(html).html).toBe(html);
  });

  it('style с несколькими объявлениями — по каждому: недопустимые удаляются, разрешённые остаются', () => {
    expect(s('<p><span style="color:red;font-family:Calibri;background-color:#bbf7d0;font-size:30px">т</span></p>').html)
      .toBe('<p><span style="background-color:#BBF7D0">т</span></p>');
    expect(s('<p><span style="color:rgb(1,2,3);background:url(https://x.example/a.png)">т</span></p>').html).toBe('<p><span>т</span></p>');
    expect(s('<p><span style="color:#fff;background-color:#12345G">т</span></p>').html).toBe('<p><span>т</span></p>');
    expect(s('<p><span style="color:expression(alert(1))">т</span></p>').html).toBe('<p><span>т</span></p>');
    expect(s('<p style="text-align:start;background-color:#FEF08A">т</p>').html).toBe('<p>т</p>');
    expect(s('<p><u style="text-decoration-color:blue;color:#DC2626">т</u></p>').html).toBe('<p><u>т</u></p>');
  });

  it('style у неразрешённого тега, data-align вне списка, ширина картинки вне 40–544, ширина столбца вне 10–100% — удаляются', () => {
    expect(s('<p><strong style="color:#DC2626">ж</strong> <a href="https://example.org" style="color:#DC2626">с</a></p>').html)
      .toBe('<p><strong>ж</strong> <a href="https://example.org">с</a></p>');
    expect(s('<blockquote style="text-align:center"><p>ц</p></blockquote>').html).toBe('<blockquote><p>ц</p></blockquote>');
    expect(s(`<img src="data:image/png;base64,${PNG}" data-align="float" width="600" />`).html).toBe(`<img src="data:image/png;base64,${PNG}" />`);
    expect(s(`<img src="data:image/png;base64,${PNG}" width="39" />`).html).toBe(`<img src="data:image/png;base64,${PNG}" />`);
    expect(s('<table><tbody><tr><td width="5%" style="background-color:#EFF6FF;width:200px"><p>1</p></td><td width="200"><p>2</p></td></tr></tbody></table>').html)
      .toBe('<table><tbody><tr><td style="background-color:#EFF6FF"><p>1</p></td><td><p>2</p></td></tr></tbody></table>');
  });

  it('повторное сохранение ничего не меняет', () => {
    const once = s(`<p style="TEXT-ALIGN: Center"><span style="color:#dc2626; font-family: 'times new roman' , times , serif">т</span></p>`).html;
    expect(once).toBe(`<p style="text-align:center"><span style="${TNR};color:#DC2626">т</span></p>`);
    expect(s(once).html).toBe(once);
  });
});
