// Текстовая часть письма (text/plain для .eml и буфера; сравнение версий) из санитизированного HTML.
// Без разборщика HTML: после санитайзера разметка простая (белый список тегов), её хватает токенайзера.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const BLOCK = new Set(['p', 'h2', 'h3', 'h4', 'blockquote', 'div', 'table', 'ul', 'ol']);
const TOKEN_RE = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi;
const attr = (attrs: string, name: string) => {
  const m = new RegExp(`${name}="([^"]*)"`, 'i').exec(attrs);
  return m ? decodeHtmlEntities(m[1] ?? '') : '';
};

/**
 * HTML → текст: заголовки и абзацы — отдельными строками, списки «•» и «1.», ссылка — «текст (адрес)»,
 * таблица — ячейки через табуляцию, изображение — «[изображение: подпись]», линия — «———».
 */
export function htmlToText(html: string): string {
  let out = '';
  const lists: { ordered: boolean; n: number }[] = [];
  let link: { href: string; start: number } | null = null;
  let cellInRow = 0;
  const newline = () => {
    out = out.replace(/[ \t]+$/, '');
    if (out && !out.endsWith('\n')) out += '\n';
  };
  for (const m of html.matchAll(TOKEN_RE)) {
    const [, close, rawTag, attrs = '', text] = m;
    if (text !== undefined) {
      out += decodeHtmlEntities(text).replace(/\s+/g, ' ');
      continue;
    }
    const tag = (rawTag ?? '').toLowerCase();
    if (close) {
      if (tag === 'a' && link) {
        const label = out.slice(link.start).trim();
        const href = link.href.replace(/^mailto:/i, '');
        if (link.href && label !== href) out += ` (${href})`;
        link = null;
      } else if (tag === 'ul' || tag === 'ol') {
        lists.pop();
        newline();
        if (lists.length === 0) out += '\n';
      } else if (tag === 'tr') {
        newline();
      } else if (tag === 'table') {
        cellInRow = 0;
        newline();
        out += '\n';
      } else if (cellInRow > 0) {
        // Абзац внутри ячейки строку таблицы не разрывает.
      } else if (tag === 'li' || (lists.length > 0 && tag === 'p')) {
        newline();
      } else if (BLOCK.has(tag)) {
        newline();
        if (tag !== 'div') out += '\n';
      }
      continue;
    }
    switch (tag) {
      case 'br':
        out += '\n';
        break;
      case 'hr':
        newline();
        out += '———\n\n';
        break;
      case 'img': {
        const alt = attr(attrs, 'alt');
        out += alt ? `[изображение: ${alt}]` : '[изображение]';
        break;
      }
      case 'a':
        link = { href: attr(attrs, 'href'), start: out.length };
        break;
      case 'ul':
      case 'ol':
        newline();
        lists.push({ ordered: tag === 'ol', n: 0 });
        break;
      case 'li': {
        newline();
        const l = lists[lists.length - 1];
        if (l) l.n++;
        out += `${'  '.repeat(Math.max(0, lists.length - 1))}${l?.ordered ? `${l.n}.` : '•'} `;
        break;
      }
      case 'tr':
        newline();
        cellInRow = 0;
        break;
      case 'td':
      case 'th':
        if (cellInRow++ > 0) out += '\t';
        break;
      case 'table':
        newline();
        cellInRow = 0;
        break;
      default:
        // Абзац внутри ячейки или пункта списка не начинает новую строку.
        if (BLOCK.has(tag) && cellInRow === 0 && !(tag === 'p' && lists.length > 0)) newline();
    }
  }
  return out
    .split('\n').map((l) => l.replace(/[ \t]+$/, '').replace(/^ +(?=\S)/, (sp) => (sp.length % 2 === 0 ? sp : ''))).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
