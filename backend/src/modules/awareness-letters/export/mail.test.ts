// Макет письма и готовый .eml (1.12.0, ADR-0044, ADR-0045; docs/specs/awareness.md, разделы 22–24). Вымышленное письмо.
import { describe, expect, it } from 'vitest';
import { sanitizeLetterHtml } from '../sanitize.js';
import { withHead } from '../variables.js';
import { contentToMail, firstSentence } from './content.js';
import { buildEml, emlFileName, safeFileName } from './eml.js';
import { logoOf, pngSize } from './layout.js';
import { bothSubject, composeMail, type LayoutSettings } from './mail.js';

const LAYOUT: LayoutSettings = {
  deptRu: 'Отдел информационной безопасности', deptTj: 'Шуъбаи амнияти иттилоотӣ', email: 'security@example.org',
  closingRu: 'С уважением,', closingTj: 'Бо эҳтиром,', footerRu: 'Отдел ИБ никогда не запрашивает пароли и коды из SMS.', footerTj: '',
  labelUrgentRu: 'ВАЖНАЯ ИНФОРМАЦИЯ', labelUrgentTj: 'МАЪЛУМОТИ МУҲИМ', labelPlannedRu: 'ПАМЯТКА', labelPlannedTj: 'ЁДДОШТ', tjHint: 'Матни тоҷикӣ дар поён ↓',
};

/** Минимальный PNG 2 × 1 (сигнатура и IHDR; содержимое для макета не важно). */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'),
  Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0]), Buffer.alloc(16),
]);

const LETTER = withHead({
  subjectRu: 'Осторожно: поддельные письма о выигрыше',
  subjectTj: 'Эҳтиёт: мактубҳои қалбакӣ дар бораи бурд',
  htmlRu: '<p><strong>Уважаемые коллеги!</strong></p><p>&nbsp;&nbsp;&nbsp;Мошенники рассылают письма о выигрыше. Не переходите по ссылкам.</p>'
    + '<div data-callout="info"><p><strong>Просьба:</strong></p><p>Пересылайте такие письма на <a href="mailto:security@example.org">security@example.org</a>.</p></div>'
    + '<div data-callout="warn"><p><strong>Предупреждение:</strong></p><p>Никому не сообщайте коды из SMS.</p></div><p></p><p>&nbsp;</p><p>Последний абзац.</p>',
  htmlTj: '<p><strong>Ҳамкорони муҳтарам!</strong></p><p>Қаллобон мактубҳо мефиристанд.</p><div data-callout="warn"><p><strong>Огоҳӣ:</strong></p><p>Рамзро нагӯед.</p></div>',
});

const compose = (lang: 'ru' | 'tj' | 'both', logo = true) => composeMail(LETTER, { lang, kind: 'urgent', layout: LAYOUT, logo: logo ? logoOf(PNG) : null, signature: null, layoutSignature: true });

describe('содержимое редактора → почтовый HTML', () => {
  it('снимок вымышленного письма', () => {
    expect(contentToMail(LETTER.htmlRu)).toMatchSnapshot();
  });

  it('выделенный блок обоих видов: таблица с полосой 4 px, цвета вида; у последнего абзаца нет отступа', () => {
    const html = contentToMail(LETTER.htmlRu);
    expect(html).toContain('background:#2563EB');
    expect(html).toContain('background:#EFF6FF');
    expect(html).toContain('background:#DC2626');
    expect(html).toContain('background:#FEF2F2');
    expect(html).not.toContain('data-callout');
    expect(html).toMatch(/<p style="margin:0;[^"]*">Никому не сообщайте коды из SMS.<\/p><\/td><\/tr><\/table>/);
  });

  it('ведущие &nbsp; вырезаются, пустые абзацы выбрасываются, ссылка mailto не переносится', () => {
    const html = contentToMail(LETTER.htmlRu);
    expect(html).toContain('">Мошенники рассылают');
    expect(html).not.toMatch(/<p [^>]*><\/p>/);
    expect(html).not.toContain('&nbsp;Мошенники');
    expect(html).toMatch(/<a href="mailto:security@example.org" style="[^"]*white-space:nowrap;">/);
  });

  it('прехедер — первая фраза', () => {
    expect(firstSentence('Уважаемые коллеги! Мошенники рассылают письма.')).toBe('Уважаемые коллеги!');
  });
});

describe('макет', () => {
  it('RU+TJ — две карточки, подсказка со ссылкой на таджикскую часть, логотип в обеих', () => {
    const m = compose('both');
    expect(m.html.match(/lang="(ru|tg)" style="border-collapse:collapse;background:#FFFFFF/g)).toHaveLength(2);
    expect(m.html).toContain('<a href="#tj" style="color:#64748B;text-decoration:none;">Матни тоҷикӣ дар поён ↓</a>');
    expect(m.html).toContain('<a name="tj" id="tj"></a>');
    expect(m.html.match(/<img src="data:image\/png/g)).toHaveLength(2);
    expect(m.html).toContain('alt="Шуъбаи амнияти иттилоотӣ"');
    expect(m.subject).toBe('Осторожно: поддельные письма о выигрыше | Эҳтиёт: мактубҳои қалбакӣ дар бораи бурд');
    expect(m.language).toBe('ru, tg');
  });

  it('один язык — одна карточка без подсказки', () => {
    const m = compose('ru');
    expect(m.html.match(/style="border-collapse:collapse;background:#FFFFFF/g)).toHaveLength(1);
    expect(m.html).not.toContain('href="#tj"');
    expect(m.subject).toBe(LETTER.subjectRu);
  });

  it('шапка: заголовок по умолчанию — тема, метка — по типу письма; без логотипа — название отдела текстом', () => {
    const m = compose('ru', false);
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('font-weight:bold;color:#FFFFFF;">Отдел информационной безопасности</p>');
    expect(m.html).toContain('>Осторожно: поддельные письма о выигрыше</p>');
    expect(m.html).toContain('text-transform:uppercase;">ВАЖНАЯ ИНФОРМАЦИЯ</p>');
  });

  it('подпись — прощание, отдел, адрес mailto; подвал выводится только непустой', () => {
    const ru = compose('ru').html;
    expect(ru).toContain('С уважением,<br><b>Отдел информационной безопасности</b><br><a href="mailto:security@example.org"');
    expect(ru).toContain('Отдел ИБ никогда не запрашивает пароли');
    const tj = compose('tj').html;
    expect(tj).toContain('Бо эҳтиром,<br><b>Шуъбаи амнияти иттилоотӣ</b>');
    expect(tj).not.toContain('border-top:1px solid #E2E8F0;padding:14px 28px');
  });

  it('в тексте блок «Подпись ИБ» — подпись макета не выводится', () => {
    const withBlock = withHead({ ...LETTER, htmlRu: '<p>Текст.</p><div data-ib-fragment="signature"></div>' });
    const m = composeMail(withBlock, { lang: 'ru', kind: 'planned', layout: LAYOUT, logo: null, signature: { htmlRu: '<p>Отдел ИБ, тел. 000</p>', htmlTj: '' }, layoutSignature: true });
    expect(m.html).toContain('Отдел ИБ, тел. 000');
    expect(m.html).not.toContain('С уважением,');
  });

  it('свои заголовок, метка и общая тема', () => {
    const t = withHead({ ...LETTER, headerRu: 'Мошенники пишут', labelRu: 'Срочно', subjectBoth: 'Общая тема' });
    expect(bothSubject(t)).toBe('Общая тема');
    const m = composeMail(t, { lang: 'ru', kind: 'urgent', layout: LAYOUT, logo: null, signature: null, layoutSignature: true });
    expect(m.html).toContain('>Мошенники пишут</p>');
    expect(m.html).toContain('>Срочно</p>');
  });

  it('логотип — 238 px по ширине, высота по пропорциям', () => {
    expect(pngSize(PNG)).toEqual({ width: 2, height: 1 });
    expect(logoOf(PNG)).toMatchObject({ width: 238, height: 119 });
    expect(logoOf(Buffer.from('not a png'))).toBeNull();
  });
});

describe('готовый .eml', () => {
  const m = compose('both');
  const eml = buildEml({ subject: m.subject, html: m.html, text: m.text, language: m.language });

  it('логотип вложен один раз — один Content-ID на две карточки', () => {
    const cids = [...eml.matchAll(/^Content-ID: <([^>]+)>/gm)].map((x) => x[1]);
    expect(cids).toHaveLength(1);
    const html = Buffer.from(eml.split(/Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/)[1]?.split('\r\n--')[0]?.replace(/\r\n/g, '') ?? '', 'base64').toString('utf8');
    expect(html.match(new RegExp(`src="cid:${cids[0]}"`, 'g'))).toHaveLength(2);
    expect(html).not.toContain('data:image');
  });

  it('X-Unsent и Content-Language есть, From, To, Cc и Date нет; text/plain есть', () => {
    const head = eml.split('\r\n\r\n')[0] ?? '';
    expect(head).toContain('X-Unsent: 1');
    expect(head).toContain('Content-Language: ru, tg');
    expect(head).not.toMatch(/^(From|To|Cc|Date):/m);
    expect(eml).toContain('Content-Type: text/plain; charset=utf-8');
    expect(m.text).toContain('Ҳамкорони муҳтарам!');
    expect(m.text).toContain('————————————————');
  });

  it('Subject по RFC 2047: кириллица и таджикские буквы ҳ, ӯ, ҷ, ғ, қ, ӣ', () => {
    const tj = 'Ҳушёр бошед: ӯ, ҷ, ғ, қ, ӣ — рамзро нагӯед';
    const one = buildEml({ subject: tj, html: '<p>x</p>', text: 'x' });
    const header = /^Subject: ((?:.*)(?:\r\n .*)*)/m.exec(one)?.[1] ?? '';
    const words = [...header.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)];
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) expect(w[0].length).toBeLessThanOrEqual(75);
    expect(words.map((w) => Buffer.from(w[1] ?? '', 'base64').toString('utf8')).join('')).toBe(tj);
  });

  it('одинаковое письмо — одинаковый файл (разделители из содержимого)', () => {
    expect(buildEml({ subject: m.subject, html: m.html, text: m.text, language: m.language })).toBe(eml);
  });

  it('имя файла: «Тема_RU-TJ_дата.eml», без запрещённых в Windows символов', () => {
    expect(emlFileName('Осторожно: письма? <выигрыш> "приз" a/b\\c|d*', 'both', '2026-11-06')).toBe('Осторожно_ письма_ _выигрыш_ _приз_ a_b_c_d__RU-TJ_2026-11-06.eml');
    expect(emlFileName('Тема', 'tj', '2026-11-06')).toBe('Тема_TJ_2026-11-06.eml');
    expect(safeFileName('a\u0001b')).toBe('a_b');
  });
});

describe('санитайзер: выделенный блок', () => {
  it('data-callout — только info и warn, иначе атрибут вырезается', () => {
    const r = sanitizeLetterHtml('<div data-callout="info"><p>a</p></div><div data-callout="warn"><p>b</p></div><div data-callout="danger" onclick="x()"><p>c</p></div>');
    expect(r.html).toBe('<div data-callout="info"><p>a</p></div><div data-callout="warn"><p>b</p></div><div><p>c</p></div>');
  });
});
