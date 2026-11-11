// Оформление текста письма в редакторе (1.13.11, docs/plans/release-1.13.11.md): чистые функции без DOM и TipTap.
// Правила и константы — из backend (api/generated/letter-format.ts); backend проверяет всё ещё раз при сохранении.
import { COLUMN_WIDTH, IMAGE_ALIGNS, LETTER_FONTS, TEXT_ALIGNS, type ImageAlign, type TextAlign } from '../../../api/generated/letter-format';

export const TNR_CSS = LETTER_FONTS[1].css;

export interface Decl { property: string; value: string; important: boolean }

/** Разбор style по объявлениям — тот же, что у backend (lib/letter-format.ts). */
export function parseStyle(style: string | null | undefined): Decl[] {
  const src = (style ?? '').replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of src) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  const out: Decl[] = [];
  for (const part of parts) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const property = part.slice(0, at).trim().toLowerCase();
    let value = part.slice(at + 1).trim();
    const imp = /!\s*important\s*$/i.exec(value);
    if (imp) value = value.slice(0, imp.index).trim();
    if (property && value) out.push({ property, value, important: !!imp });
  }
  return out;
}

/** Последнее значение свойства (как в браузере). */
export function styleValue(style: string | null | undefined, property: string): string | null {
  const found = parseStyle(style).filter((d) => d.property === property);
  return found.length ? (found[found.length - 1] as Decl).value : null;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00',
  cyan: '#00FFFF', aqua: '#00FFFF', magenta: '#FF00FF', fuchsia: '#FF00FF', gray: '#808080', grey: '#808080',
  silver: '#C0C0C0', maroon: '#800000', olive: '#808000', navy: '#000080', purple: '#800080', teal: '#008080',
  lime: '#00FF00', orange: '#FFA500', darkblue: '#00008B', darkred: '#8B0000', darkgreen: '#006400',
  darkcyan: '#008B8B', darkmagenta: '#8B008B', darkyellow: '#808000', lightgray: '#D3D3D3', lightgrey: '#D3D3D3',
};
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();

/** Строгий цвет панели: #RRGGBB → в верхнем регистре; иное — null (как у backend). */
export function strictHex(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null;
}

/**
 * Цвет из вставки (Word, Outlook, браузер): #RRGGBB, #RGB, rgb()/rgba() без прозрачности, основные имена → #RRGGBB.
 * Прозрачный, «auto», windowtext и прочее — null.
 */
export function toHex(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (/^#[0-9a-f]{6}$/.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`.toUpperCase();
  const m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(v);
  if (m) {
    const alpha = m[4];
    if (alpha !== undefined && (alpha.endsWith('%') ? parseFloat(alpha) < 100 : parseFloat(alpha) < 1)) return null;
    return `#${hex2(Number(m[1]))}${hex2(Number(m[2]))}${hex2(Number(m[3]))}`;
  }
  return NAMED[v] ?? null;
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Чёрный и почти чёрный — снимаются при вставке (останется цвет текста по умолчанию). */
export const isNearBlack = (hex: string) => channels(hex).every((c) => c <= 0x40);
/** Белый и почти белый фон — снимаются при вставке. */
export const isNearWhite = (hex: string) => channels(hex).every((c) => c >= 0xf8);

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Контраст по WCAG 2.x, 1–21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Шрифт из списка: Times New Roman (первым в списке семейств) → канонический вид; остальное — null (Arial по умолчанию). */
export function toFont(value: string | null | undefined): string | null {
  const first = (value ?? '').split(',')[0]?.replace(/["']/g, '').trim().toLowerCase();
  return first === 'times new roman' ? TNR_CSS : null;
}

export function toTextAlign(value: string | null | undefined): Exclude<TextAlign, 'left'> | null {
  const v = (value ?? '').trim().toLowerCase();
  return v !== 'left' && (TEXT_ALIGNS as readonly string[]).includes(v) ? (v as Exclude<TextAlign, 'left'>) : null;
}

export function toImageAlign(value: string | null | undefined): ImageAlign | null {
  const v = (value ?? '').trim().toLowerCase();
  return (IMAGE_ALIGNS as readonly string[]).includes(v) ? (v as ImageAlign) : null;
}

/** Атрибуты метки «шрифт и цвет» → style span в каноническом порядке (как у backend). */
export function letterStyleCss(a: { fontFamily?: string | null; color?: string | null; backgroundColor?: string | null }): string {
  return [a.fontFamily ? `font-family:${a.fontFamily}` : '', a.color ? `color:${a.color}` : '', a.backgroundColor ? `background-color:${a.backgroundColor}` : '']
    .filter(Boolean).join(';');
}

// ---------------------------------------------------------------- ширина столбцов

/** Равные ширины, сумма 100. */
export function equalWidths(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) => (i < 100 - base * n ? base + 1 : base));
}

/** Привести ширины к сумме 100 с минимумом каждого (наибольшие остатки получают единицы). */
function normalize(raw: number[], fixed: number | null = null): number[] {
  const min = COLUMN_WIDTH.min;
  const out = raw.map((w) => Math.max(min, w));
  for (let pass = 0; pass < 3; pass++) {
    const sum = out.reduce((s, w) => s + w, 0);
    const diff = 100 - sum;
    if (Math.abs(diff) < 0.0001) break;
    const adjustable = out.map((w, i) => ({ w, i })).filter(({ w, i }) => i !== fixed && (diff > 0 || w > min));
    const pool = adjustable.reduce((s, x) => s + x.w, 0);
    if (!pool) break;
    for (const { w, i } of adjustable) out[i] = Math.max(min, w + (diff * w) / pool);
  }
  // Целые проценты: остаток раздаётся по наибольшим дробным частям, изменённый столбец не трогается.
  const ints = out.map((w, i) => (i === fixed ? Math.round(w) : Math.floor(w)));
  let left = 100 - ints.reduce((s, w) => s + w, 0);
  const order = out.map((w, i) => ({ r: w - Math.floor(w), i })).filter((x) => x.i !== fixed).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) {
    const i = (order[k] as { i: number }).i;
    ints[i] = (ints[i] as number) + 1;
  }
  return ints;
}

/**
 * Ширина одного столбца, % (1.13.11): он получает новое значение, остальные пересчитываются пропорционально прежним;
 * минимум 10%, сумма 100%. Одна колонка — всегда 100.
 */
export function resizeColumn(widths: readonly number[], index: number, percent: number): number[] {
  const n = widths.length;
  if (n <= 1) return n ? [100] : [];
  const min = COLUMN_WIDTH.min;
  const max = 100 - min * (n - 1);
  const target = Math.max(min, Math.min(max, Math.round(percent)));
  const others = widths.map((w, i) => (i === index ? 0 : Math.max(w, 0.0001)));
  const sumOthers = others.reduce((s, w) => s + w, 0);
  const scaled = widths.map((_, i) => (i === index ? target : ((others[i] as number) / sumOthers) * (100 - target)));
  return normalize(scaled, index);
}

/** Ширины первой строки: заданные — как есть (с приведением к 100), иначе равные. */
export function columnWidths(given: readonly (number | null)[]): number[] {
  if (!given.length) return [];
  if (given.some((w) => w === null)) return equalWidths(given.length);
  return normalize(given as number[]);
}

// ---------------------------------------------------------------- вставка из Word и Outlook

const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const TAG_RE = /<!--[\s\S]*?-->|<!\[[\s\S]*?\]>|<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/g;
/** Теги, которые вставка выбрасывает вместе с содержимым. */
const DROP = new Set(['style', 'script', 'xml', 'meta', 'link', 'title', 'head', 'o:smarttagtype']);
/** Атрибуты, которые переживают очистку (остальные — классы Mso, lang, id, стили Word — отбрасываются). */
const KEEP_ATTRS: Record<string, string[]> = {
  a: ['href'], img: ['src', 'alt', 'width', 'height', 'data-align'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'],
  div: ['data-ib-fragment', 'data-callout'], ol: ['start'],
};
const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'div']);

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function attrsOf(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = (m[1] ?? '').toLowerCase();
    if (!name || name === '/') continue;
    out.set(name, decode(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return out;
}

/** Ширина ячейки из вставки, px (атрибут или style: px, pt, cm) или проценты. */
function cellWidth(a: Map<string, string>): { px?: number; pct?: number } | null {
  const raw = (styleValue(a.get('style'), 'width') ?? a.get('width') ?? '').trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(px|pt|cm|%)?$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === '%') return { pct: n };
  return { px: m[2] === 'pt' ? (n * 96) / 72 : m[2] === 'cm' ? (n * 96) / 2.54 : n };
}

interface Out { text: string }
interface OpenTag { name: string; closer: string }

/**
 * Очистить HTML вставки (1.13.11, п. 9 задания): из стилей остаются только Times New Roman, цвет и фон текста (к HEX;
 * чёрный и почти чёрный текст, белый фон — снимаются), подчёркивание и его цвет, выравнивание, заливка ячеек, ширина
 * столбцов (в %, по первой строке таблицы). Классы, lang, mso-стили и прочее отбрасываются. Избранное не трогается.
 */
export function cleanPastedHtml(html: string): string {
  const out: Out[] = [];
  const stack: OpenTag[] = [];
  let drop = 0;
  /** Ячейки первой строки текущих таблиц: индексы в out и ширины — проценты считаются на </table>. */
  const tables: { rows: number; cells: { at: number; w: { px?: number; pct?: number } | null }[] }[] = [];

  for (const m of html.matchAll(TAG_RE)) {
    const [whole, close, rawName, rawAttrs = '', text] = m;
    if (text !== undefined) {
      if (!drop) out.push({ text });
      continue;
    }
    if (!rawName) continue; // комментарии и условные блоки Word
    const name = rawName.toLowerCase();
    if (DROP.has(name)) {
      if (!whole.endsWith('/>')) drop += close ? -1 : 1;
      drop = Math.max(0, drop);
      continue;
    }
    if (drop) continue;
    if (name.includes(':')) continue; // o:p, w:… — без тега, текст остаётся
    if (close) {
      if (name === 'table') {
        const t = tables.pop();
        if (t && t.cells.length && t.cells.every((c) => c.w)) {
          const pct = t.cells.every((c) => c.w?.pct !== undefined)
            ? t.cells.map((c) => c.w?.pct as number)
            : (() => {
              const px = t.cells.map((c) => c.w?.px ?? 0);
              const sum = px.reduce((s, w) => s + w, 0);
              return sum ? px.map((w) => (w / sum) * 100) : [];
            })();
          const widths = pct.length ? columnWidths(pct) : [];
          widths.forEach((w, i) => {
            const cell = out[(t.cells[i] as { at: number }).at] as Out;
            cell.text = cell.text.replace(/^<(t[hd])/, `<$1 width="${w}%"`);
          });
        }
      }
      // Закрываем ближайший открытый с таким же исходным именем.
      for (let i = stack.length - 1; i >= 0; i--) {
        if ((stack[i] as OpenTag).name === name) {
          const [t] = stack.splice(i, 1);
          if (t?.closer) out.push({ text: t.closer });
          break;
        }
      }
      continue;
    }
    const a = attrsOf(rawAttrs);
    const style = a.get('style');
    const selfClosing = /\/\s*$/.test(rawAttrs) || ['br', 'img', 'hr'].includes(name);
    const keep = KEEP_ATTRS[name] ?? [];
    const kept = keep.filter((k) => a.has(k)).map((k) => ` ${k}="${escAttr(a.get(k) ?? '')}"`).join('');

    if (name === 'table') tables.push({ rows: 0, cells: [] });
    if (name === 'tr') {
      const t = tables.at(-1);
      if (t) t.rows++;
    }

    if (name === 'span' || name === 'font' || name === 'u') {
      // Шрифт, цвет и фон — span; подчёркивание (тег u или text-decoration:underline) — u с цветом.
      const font = toFont(styleValue(style, 'font-family') ?? a.get('face'));
      const rawColor = toHex(styleValue(style, 'color') ?? a.get('color'));
      const color = rawColor && !isNearBlack(rawColor) ? rawColor : null;
      const bgRaw = toHex(styleValue(style, 'background-color') ?? styleValue(style, 'background') ?? styleValue(style, 'mso-highlight'));
      const bg = bgRaw && !isNearWhite(bgRaw) ? bgRaw : null;
      const deco = (styleValue(style, 'text-decoration') ?? styleValue(style, 'text-decoration-line') ?? '').toLowerCase();
      const underline = name === 'u' || deco.includes('underline');
      const uColor = toHex(styleValue(style, 'text-decoration-color') ?? styleValue(style, 'text-underline-color'));
      const css = letterStyleCss({ fontFamily: font, color, backgroundColor: bg });
      let open = css ? `<span style="${escAttr(css)}">` : '';
      let closer = css ? '</span>' : '';
      // Word: <u><span style='text-decoration-color:…'> — цвет переносится на внешнее подчёркивание.
      const prev = out.at(-1);
      if (name !== 'u' && !underline && uColor && stack.at(-1)?.name === 'u' && prev?.text === '<u>') {
        prev.text = `<u style="text-decoration-color:${uColor}">`;
      } else if (underline) {
        open += uColor ? `<u style="text-decoration-color:${uColor}">` : '<u>';
        closer = `</u>${closer}`;
      }
      if (selfClosing) continue;
      out.push({ text: open });
      stack.push({ name, closer });
      continue;
    }

    let attrsOut = kept;
    if (BLOCKS.has(name)) {
      const al = toTextAlign(styleValue(style, 'text-align') ?? a.get('align'));
      if (al) attrsOut += ` style="text-align:${al}"`;
    }
    if (name === 'td' || name === 'th') {
      const bgRaw = toHex(styleValue(style, 'background-color') ?? styleValue(style, 'background') ?? a.get('bgcolor'));
      const bg = bgRaw && !isNearWhite(bgRaw) ? bgRaw : null;
      if (bg) attrsOut += ` style="background-color:${bg}"`;
      const t = tables.at(-1);
      if (t && t.rows === 1) {
        out.push({ text: `<${name}${attrsOut}>` });
        t.cells.push({ at: out.length - 1, w: cellWidth(a) });
        stack.push({ name, closer: `</${name}>` });
        continue;
      }
    }
    out.push({ text: `<${name}${attrsOut}${selfClosing && name !== 'br' && name !== 'img' && name !== 'hr' ? ' /' : ''}>` });
    if (!selfClosing) stack.push({ name, closer: `</${name}>` });
  }
  // Ведущие пробелы и &nbsp; в начале абзацев (отступ первой строки Word) вырезает выгрузка, как в 1.12.0.
  return out.map((o) => o.text).join('');
}

// ---------------------------------------------------------------- канонический HTML редактора

const COLOR_PROPS = new Set(['color', 'background-color', 'text-decoration-color']);

/**
 * HTML из редактора → вид, который принимает backend: браузер сериализует встроенные стили как `rgb(…)` и с кавычками
 * у шрифта, санитайзер же строгий (#RRGGBB, канонический шрифт). Остальные свойства style отбрасываются здесь же.
 */
export function canonicalEditorHtml(html: string): string {
  return html.replace(/<(span|u|p|h2|h3|h4|li|td|th)\b([^>]*?)\sstyle="([^"]*)"([^>]*)>/gi, (_m, tag: string, before: string, style: string, after: string) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const d of parseStyle(style.replace(/&quot;/g, '"'))) {
      if (seen.has(d.property)) continue;
      let v: string | null = null;
      if (COLOR_PROPS.has(d.property)) v = toHex(d.value);
      else if (d.property === 'font-family') v = toFont(d.value);
      else if (d.property === 'text-align') v = toTextAlign(d.value);
      if (v) {
        seen.add(d.property);
        out.push(`${d.property}:${v}`);
      }
    }
    const order = ['font-family', 'color', 'background-color', 'text-decoration-color', 'text-align'];
    out.sort((a, b) => order.indexOf(a.split(':')[0] as string) - order.indexOf(b.split(':')[0] as string));
    return out.length ? `<${tag}${before} style="${out.join(';').replace(/"/g, '&quot;')}"${after}>` : `<${tag}${before}${after}>`;
  });
}
