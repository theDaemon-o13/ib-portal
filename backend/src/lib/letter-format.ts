// Оформление текста учебных писем (1.13.11, docs/plans/release-1.13.11.md): шрифт, цвет и фон текста, цветное
// подчёркивание, выравнивание, положение и ширина картинки, ширина столбцов и заливка ячеек. Один источник правил:
// санитайзер (что сохраняется), выгрузка в почтовый HTML и frontend (константы — сгенерированным файлом).
// Разбор style — по объявлениям, а не регулярным выражением по всей строке.

/** Шрифты: Arial — по умолчанию (атрибута нет), Times New Roman — span со стилем. */
export const LETTER_FONTS = [
  { key: 'arial', label: 'Arial', css: null },
  { key: 'times', label: 'Times New Roman', css: "'Times New Roman', Times, serif" },
] as const;
export type LetterFontKey = (typeof LETTER_FONTS)[number]['key'];

export interface NamedColor { name: string; hex: string }

/** Цвет текста: «Обычный» снимает цвет (тот же, что у текста макета). */
export const TEXT_DEFAULT = '#0F172A';
export const TEXT_COLORS: readonly NamedColor[] = [
  { name: 'Обычный', hex: TEXT_DEFAULT },
  { name: 'Тёмно-синий', hex: '#1E3A8A' },
  { name: 'Синий', hex: '#2563EB' },
  { name: 'Красный', hex: '#DC2626' },
  { name: 'Оранжевый', hex: '#EA580C' },
  { name: 'Зелёный', hex: '#16A34A' },
  { name: 'Серый', hex: '#64748B' },
];
/** Фон текста (выделение маркером). */
export const HIGHLIGHT_COLORS: readonly NamedColor[] = [
  { name: 'Жёлтый', hex: '#FEF08A' },
  { name: 'Зелёный', hex: '#BBF7D0' },
  { name: 'Голубой', hex: '#BFDBFE' },
  { name: 'Розовый', hex: '#FECACA' },
  { name: 'Серый', hex: '#E2E8F0' },
];
/** Заливка ячейки таблицы. */
export const CELL_COLORS: readonly NamedColor[] = [
  { name: 'Голубой', hex: '#EFF6FF' },
  { name: 'Розовый', hex: '#FEF2F2' },
  { name: 'Зелёный', hex: '#F0FDF4' },
  { name: 'Жёлтый', hex: '#FFFBEB' },
  { name: 'Серый', hex: '#F1F5F9' },
  { name: 'Тёмно-серый', hex: '#E2E8F0' },
  { name: 'Тёмно-синий', hex: '#1E3A8A' },
];
/** Избранные цвета: не больше 12 в наборе. */
export const FAVORITES_MAX = 12;
/** Контраст текста и фона ниже — предупреждение «Текст будет плохо виден». */
export const MIN_CONTRAST = 4.5;

export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export const IMAGE_ALIGNS = ['left', 'center', 'right', 'wrap-left', 'wrap-right'] as const;
export type ImageAlign = (typeof IMAGE_ALIGNS)[number];
/** Ширина картинки, px: от 40 до ширины содержимого карточки письма. С обтеканием — не шире половины. */
export const IMAGE_WIDTH = { min: 40, max: 544, wrapMax: 280 } as const;
/** Ширина столбца таблицы, % ширины таблицы. */
export const COLUMN_WIDTH = { min: 10, max: 100 } as const;

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Цвет #RRGGBB (любой регистр) → #RRGGBB в верхнем регистре; иное — null. */
export function normalizeHex(value: string): string | null {
  const v = value.trim();
  return HEX_RE.test(v) ? v.toUpperCase() : null;
}

export interface StyleDeclaration {
  property: string;
  value: string;
  important: boolean;
}

/**
 * Разобрать атрибут style на объявления. Комментарии вырезаются, `;` и `:` внутри кавычек и скобок не делят.
 * Свойство — в нижнем регистре, значение — без пробелов по краям; `!important` — отдельным признаком.
 */
export function parseStyle(style: string): StyleDeclaration[] {
  const src = style.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
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
  const out: StyleDeclaration[] = [];
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

const fontKey = (value: string) => value.toLowerCase().replace(/["']/g, '').split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean).join(',');
const TIMES = LETTER_FONTS[1];

/** Шрифт из списка: только Times New Roman (полный канонический набор); Arial — шрифт по умолчанию, не хранится. */
export function normalizeFont(value: string): string | null {
  return fontKey(value) === fontKey(TIMES.css) ? TIMES.css : null;
}

type Checker = (value: string) => string | null;
const color: Checker = normalizeHex;
const align: Checker = (v) => {
  const a = v.trim().toLowerCase();
  return (TEXT_ALIGNS as readonly string[]).includes(a) ? a : null;
};

/** Разрешённые свойства style по тегам, в порядке вывода (канонический вид). */
const STYLE_RULES: Record<string, [string, Checker][]> = {
  span: [['font-family', normalizeFont], ['color', color], ['background-color', color]],
  u: [['text-decoration-color', color]],
  p: [['text-align', align]],
  h2: [['text-align', align]],
  h3: [['text-align', align]],
  h4: [['text-align', align]],
  li: [['text-align', align]],
  td: [['background-color', color]],
  th: [['background-color', color]],
};
export const STYLED_TAGS = Object.keys(STYLE_RULES);

/**
 * Отфильтровать style тега по правилам. Остаются только разрешённые свойства с допустимыми значениями; повтор свойства,
 * `!important`, `url()`, `expression`, `var()` и всё остальное удаляется. Результат — канонический `prop:value;prop:value`
 * (повторный фильтр его не меняет) или null, если ничего не осталось.
 */
export function filterStyle(tag: string, style: string | undefined): string | null {
  const rules = STYLE_RULES[tag.toLowerCase()];
  if (!rules || !style) return null;
  const decls = parseStyle(style);
  const out: string[] = [];
  for (const [property, check] of rules) {
    const found = decls.filter((d) => d.property === property);
    if (found.length !== 1) continue;
    const d = found[0] as StyleDeclaration;
    if (d.important || /url\(|expression|var\(|\\/i.test(d.value)) continue;
    const value = check(d.value);
    if (value !== null) out.push(`${property}:${value}`);
  }
  return out.length ? out.join(';') : null;
}

/** Значения style как объект (после filterStyle): для выгрузки. */
export function styleMap(style: string | null | undefined): Record<string, string> {
  return Object.fromEntries(parseStyle(style ?? '').map((d) => [d.property, d.value]));
}

/** Положение картинки из списка или null. */
export function imageAlign(value: string | undefined): ImageAlign | null {
  const v = (value ?? '').trim().toLowerCase();
  return (IMAGE_ALIGNS as readonly string[]).includes(v) ? (v as ImageAlign) : null;
}

/** Ширина картинки: целое 40–544 или null. */
export function imageWidth(value: string | undefined): number | null {
  const v = (value ?? '').trim();
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  return n >= IMAGE_WIDTH.min && n <= IMAGE_WIDTH.max ? n : null;
}

/** Ширина столбца: «NN%», целое 10–100, или null. */
export function columnWidth(value: string | undefined): number | null {
  const m = /^\s*(\d{1,3})\s*%\s*$/.exec(value ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return n >= COLUMN_WIDTH.min && n <= COLUMN_WIDTH.max ? n : null;
}

/** Относительная яркость цвета #RRGGBB (WCAG 2.x). */
export function luminance(hex: string): number {
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

/** Контраст двух цветов #RRGGBB, 1–21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Модуль для frontend (npm run openapi:export): константы оформления — те же, что проверяет backend. */
export function frontendLetterFormatModule(): string {
  const j = (v: unknown) => JSON.stringify(v, null, 2);
  return `// Сгенерировано из backend/src/lib/letter-format.ts (npm run openapi:export). Вручную не править.
// Правила проверяет backend (санитайзер при сохранении); здесь — для панели редактора, палитры и вставки.
export const LETTER_FONTS = ${j(LETTER_FONTS)} as const;
export const TEXT_DEFAULT = '${TEXT_DEFAULT}';
export const TEXT_COLORS = ${j(TEXT_COLORS)} as const;
export const HIGHLIGHT_COLORS = ${j(HIGHLIGHT_COLORS)} as const;
export const CELL_COLORS = ${j(CELL_COLORS)} as const;
export const FAVORITES_MAX = ${FAVORITES_MAX};
export const MIN_CONTRAST = ${MIN_CONTRAST};
export const TEXT_ALIGNS = ${j(TEXT_ALIGNS)} as const;
export const IMAGE_ALIGNS = ${j(IMAGE_ALIGNS)} as const;
export const IMAGE_WIDTH = ${j(IMAGE_WIDTH)} as const;
export const COLUMN_WIDTH = ${j(COLUMN_WIDTH)} as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export type ImageAlign = (typeof IMAGE_ALIGNS)[number];
`;
}
