// Содержимое редактора → почтовый HTML (1.12.0, ADR-0044; docs/specs/awareness.md, раздел 22). Чистая функция без DOM:
// на входе HTML после санитайзера (белый список тегов без style и class), на выходе — те же теги со встроенными стилями
// макета, выделенные блоки — таблицами с полосой слева. Ведущие пробелы и &nbsp; в начале абзаца (отступ первой строки
// из Word) вырезаются, абзацы, оставшиеся пустыми, выбрасываются.

export const MAIL_FONT = "font-family:Arial, 'Segoe UI', Helvetica, sans-serif";
const TEXT = `${MAIL_FONT};font-size:15px;line-height:23px;color:#0F172A;`;
export const LINK_STYLE = 'color:#1D4ED8;text-decoration:underline;';

export type CalloutKind = 'info' | 'warn';
export const CALLOUT_COLORS: Record<CalloutKind, { bar: string; bg: string }> = {
  info: { bar: '#2563EB', bg: '#EFF6FF' },
  warn: { bar: '#DC2626', bg: '#FEF2F2' },
};

const P = (margin: string) => `<p style="margin:${margin};${TEXT}">`;
const STYLES: Record<string, string> = {
  h2: `<h2 style="margin:4px 0 12px 0;${MAIL_FONT};font-size:20px;line-height:26px;font-weight:bold;color:#0F172A;">`,
  h3: `<h3 style="margin:4px 0 10px 0;${MAIL_FONT};font-size:17px;line-height:24px;font-weight:bold;color:#0F172A;">`,
  h4: `<h4 style="margin:4px 0 8px 0;${MAIL_FONT};font-size:15px;line-height:23px;font-weight:bold;color:#0F172A;">`,
  ul: `<ul style="margin:0 0 14px 0;padding:0 0 0 24px;${TEXT}">`,
  ol: `<ol style="margin:0 0 14px 0;padding:0 0 0 24px;${TEXT}">`,
  li: `<li style="margin:0 0 6px 0;${TEXT}">`,
  blockquote: `<blockquote style="margin:0 0 14px 0;padding:4px 0 4px 14px;border-left:3px solid #CBD5E1;color:#334155;">`,
  table: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px 0;">`,
  hr: '<hr style="border:0;border-top:1px solid #E2E8F0;margin:18px 0;">',
};
const CELL = `border:1px solid #CBD5E1;padding:6px 8px;vertical-align:top;text-align:left;${MAIL_FONT};font-size:14px;line-height:20px;color:#0F172A;`;

const TOKEN_RE = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
const LEADING_SPACE_RE = /^(?:\s|&nbsp;|&#160;|&#xa0;|\u00a0)+/i;
const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(attrs);
  return m ? m[1] ?? '' : null;
};

interface Frame { tag: string; callout?: CalloutKind; /** Индексы открывающих <p> выделенного блока: у последнего — без отступа снизу. */ ps?: number[] }

/**
 * Перевести HTML редактора в почтовый. Абзац — 15/23, отступ 14 px снизу; в ячейке таблицы и выделенном блоке — свои
 * отступы. Ссылка `mailto:` не переносится (`white-space:nowrap`).
 */
export function contentToMail(html: string): string {
  const out: string[] = [];
  const stack: Frame[] = [];
  /** Открытый абзац: индекс его тега в out — пустой абзац выбрасывается целиком. */
  let openP: { at: number; empty: boolean } | null = null;
  const inside = (tag: string) => stack.some((f) => f.tag === tag);
  const callout = () => [...stack].reverse().find((f) => f.callout);

  for (const m of html.matchAll(TOKEN_RE)) {
    const [, close, rawTag, attrs = '', , text] = m;
    if (text !== undefined) {
      let t = text;
      if (openP?.empty) {
        t = t.replace(LEADING_SPACE_RE, '');
        if (t) openP.empty = false;
      }
      out.push(t);
      continue;
    }
    const tag = (rawTag ?? '').toLowerCase();
    if (close) {
      const frame = stack.pop();
      if (tag === 'p' && openP) {
        if (openP.empty) {
          const at = openP.at;
          out.length = at;
          const c = callout();
          if (c?.ps) c.ps = c.ps.filter((i) => i < at);
        } else {
          out.push('</p>');
        }
        openP = null;
        continue;
      }
      if (tag === 'div' && frame?.callout) {
        const last = frame.ps?.at(-1);
        if (last !== undefined) out[last] = (out[last] ?? '').replace('margin:0 0 4px 0', 'margin:0');
        out.push('</td></tr></table>');
        continue;
      }
      out.push(`</${tag}>`);
      continue;
    }
    // Любой тег внутри абзаца (жирный, ссылка, перенос, изображение) делает его непустым.
    if (openP && tag !== 'p') openP.empty = false;
    switch (tag) {
      case 'p': {
        const c = callout();
        const cell = inside('td') || inside('th');
        out.push(cell ? P('0') : c ? P('0 0 4px 0') : inside('li') ? P('0') : P('0 0 14px 0'));
        openP = { at: out.length - 1, empty: true };
        if (c && !cell) (c.ps ??= []).push(out.length - 1);
        stack.push({ tag });
        break;
      }
      case 'div': {
        const kind = attr(attrs, 'data-callout');
        if (kind === 'info' || kind === 'warn') {
          const { bar, bg } = CALLOUT_COLORS[kind];
          out.push(
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:4px 0 18px 0;">'
            + `<tr><td width="4" style="width:4px;background:${bar};font-size:0;line-height:0;">&nbsp;</td>`
            + `<td style="background:${bg};padding:14px 18px;">`,
          );
          stack.push({ tag, callout: kind, ps: [] });
        } else {
          const fragment = attr(attrs, 'data-ib-fragment');
          out.push(fragment ? `<div data-ib-fragment="${fragment}">` : '<div>');
          stack.push({ tag });
        }
        break;
      }
      case 'a': {
        const href = attr(attrs, 'href') ?? '';
        const nowrap = /^mailto:/i.test(href) ? 'white-space:nowrap;' : '';
        out.push(href ? `<a href="${href}" style="${LINK_STYLE}${nowrap}">` : '<a>');
        stack.push({ tag });
        break;
      }
      case 'td':
      case 'th': {
        const span = ['colspan', 'rowspan'].map((k) => attr(attrs, k)).map((v, i) => (v ? ` ${i ? 'rowspan' : 'colspan'}="${v}"` : '')).join('');
        out.push(`<${tag}${span} style="${CELL}${tag === 'th' ? 'background:#F1F5F9;font-weight:bold;' : ''}">`);
        stack.push({ tag });
        break;
      }
      case 'img': {
        const src = attr(attrs, 'src') ?? '';
        const alt = attr(attrs, 'alt');
        const size = ['width', 'height'].map((k) => attr(attrs, k)).map((v, i) => (v ? ` ${i ? 'height' : 'width'}="${v}"` : '')).join('');
        out.push(`<img src="${src}"${alt !== null ? ` alt="${alt}"` : ' alt=""'}${size} style="display:block;max-width:100%;height:auto;border:0;margin:0 0 14px 0;">`);
        break;
      }
      case 'br':
        out.push('<br>');
        break;
      case 'hr':
        out.push(STYLES.hr ?? '<hr>');
        break;
      default: {
        const styled = STYLES[tag];
        out.push(styled ?? `<${tag}>`);
        stack.push({ tag });
      }
    }
  }
  return out.join('');
}

/** Первая фраза текста — скрытый прехедер (превью в списке писем). */
export function firstSentence(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?…])(\s|$)/.exec(flat);
  const s = (m?.[1] ?? flat).trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
