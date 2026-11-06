// Санитизация HTML писем, шаблонов и «Подписи ИБ» (1.9.0; docs/specs/awareness.md, раздел 15).
// Выполняется на backend при каждом сохранении: сохраняется только результат. Белый список тегов и атрибутов;
// ссылки — http(s) и mailto, без ссылок на портал; изображения — только data: PNG, JPEG, GIF с проверкой сигнатуры.
import { createHash } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { AppError } from '../../lib/errors.js';

export const ALLOWED_TAGS = [
  'h2', 'h3', 'h4', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'hr', 'blockquote', 'div', 'span',
];
/** Теги, содержимое которых выбрасывается вместе с ними (не только сам тег). */
const DROP_WITH_CONTENT = ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'title', 'head'];

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif';
export interface LetterImage {
  mime: ImageMime;
  bytes: number;
  /** sha256 содержимого: одинаковые изображения в .eml вкладываются один раз. */
  sha256: string;
}

export interface SanitizeResult {
  html: string;
  images: LetterImage[];
  /** Что было вырезано и о чём стоит сказать пользователю (относительные ссылки). */
  removed: string[];
  /** Сколько изображений вырезано: по ссылке (cid:, file://, внешний адрес) — их нет в письме. */
  removedImages: number;
}

/**
 * Предупреждение о вырезанных изображениях (решение владельца 05.11.2026): текст прошлого письма копируют из Outlook
 * или Word, картинки приходят ссылками — они не должны пропадать молча. Тот же текст показывает редактор при вставке.
 */
export function imagesWarning(n: number): string[] {
  return n > 0 ? [`Не вставлено изображений: ${n}. Картинки по ссылке не поддерживаются — сохраните их файлом и вставьте заново`] : [];
}

/** Пустые атрибуты: новый объект на каждый тег — sanitize-html может менять переданный. */
const noAttrs = (): Record<string, string> => ({});
const DATA_IMAGE_RE = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/\s]+={0,2})$/i;

/** Тип изображения по сигнатуре: PNG, JPEG или GIF; иначе null. */
export function sniffImage(buf: Buffer): ImageMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  return null;
}

/** Разобрать data: URI изображения. Ошибка — 400 BAD_IMAGE: заявленный тип не совпал с содержимым или не тот тип. */
export function decodeDataImage(src: string): { mime: ImageMime; data: Buffer } | null {
  const m = DATA_IMAGE_RE.exec(src.trim());
  if (!m) return null;
  const data = Buffer.from((m[2] ?? '').replace(/\s+/g, ''), 'base64');
  const declared = (m[1] ?? '').toLowerCase() as ImageMime;
  const real = sniffImage(data);
  if (real !== declared) {
    throw new AppError(400, 'BAD_IMAGE', 'Изображение повреждено или не PNG, JPEG, GIF. Вставьте картинку заново');
  }
  return { mime: real, data };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Санитизировать HTML письма. portalUrl — адрес портала (PORTAL_URL): ссылки на него — 400 PORTAL_LINK,
 * сотрудники банка портал не видят. Неподходящие изображения и ссылки вырезаются, о внешних — запись в removed.
 */
export function sanitizeLetterHtml(dirty: string, opts: { portalUrl?: string } = {}): SanitizeResult {
  const portalHost = opts.portalUrl ? hostOf(opts.portalUrl) : null;
  const images: LetterImage[] = [];
  const removed = new Set<string>();
  let removedImages = 0;
  let portalLink: string | null = null;

  const html = sanitizeHtml(dirty, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      div: ['data-ib-fragment', 'data-callout'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: DROP_WITH_CONTENT,
    transformTags: {
      a: (tagName, attribs) => {
        const href = (attribs.href ?? '').trim();
        if (!/^(https?:\/\/|mailto:)/i.test(href)) {
          if (href) removed.add('ссылка без адреса сайта (относительная или другого вида)');
          return { tagName, attribs: noAttrs() };
        }
        if (portalHost && /^https?:/i.test(href) && hostOf(href) === portalHost) portalLink ??= href;
        return { tagName, attribs: { href } };
      },
      img: (tagName, attribs) => {
        const src = attribs.src ?? '';
        const img = decodeDataImage(src);
        if (!img) {
          removedImages++;
          return { tagName, attribs: noAttrs() };
        }
        images.push({ mime: img.mime, bytes: img.data.length, sha256: createHash('sha256').update(img.data).digest('hex') });
        const out: Record<string, string> = { src: `data:${img.mime};base64,${img.data.toString('base64')}` };
        if (attribs.alt) out.alt = attribs.alt;
        for (const k of ['width', 'height'] as const) if (/^\d{1,4}$/.test(attribs[k] ?? '')) out[k] = attribs[k] as string;
        return { tagName, attribs: out };
      },
      // Блок «Подпись ИБ» и выделенный блок (1.12.0): только эти значения, остальные атрибуты div вырезаются.
      div: (tagName, attribs) => ({
        tagName,
        attribs: attribs['data-ib-fragment'] === 'signature' ? { 'data-ib-fragment': 'signature' }
          : attribs['data-callout'] === 'info' || attribs['data-callout'] === 'warn' ? { 'data-callout': attribs['data-callout'] } : noAttrs(),
      }),
    },
    // Изображение без src (внешнее, вырезанное) не оставляем пустым тегом.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });

  if (portalLink) {
    throw new AppError(400, 'PORTAL_LINK', `В письме ссылка на портал (${portalLink}) — сотрудники банка его не видят. Уберите ссылку`);
  }
  return { html, images, removed: [...removed], removedImages };
}

export interface LetterLimits {
  maxImageKb: number;
  maxLetterKb: number;
  warnLetterKb: number;
}
export const DEFAULT_LETTER_LIMITS: LetterLimits = { maxImageKb: 1024, maxLetterKb: 2048, warnLetterKb: 1024 };

const kb = (bytes: number) => Math.ceil(bytes / 1024);

/**
 * Лимиты размера: изображение и письмо целиком (HTML обоих языков вместе с изображениями). Превышение — 413,
 * от warnLetterKb — предупреждение (сохранение не блокируется).
 */
export function checkLetterSize(htmls: readonly string[], images: readonly LetterImage[], limits: LetterLimits): { bytes: number; warn: boolean } {
  const big = images.find((i) => i.bytes > limits.maxImageKb * 1024);
  if (big) {
    throw new AppError(413, 'IMAGE_TOO_LARGE', `Изображение ${kb(big.bytes)} КБ — больше допустимых ${limits.maxImageKb} КБ. Уменьшите его`);
  }
  const bytes = htmls.reduce((s, h) => s + Buffer.byteLength(h, 'utf8'), 0);
  if (bytes > limits.maxLetterKb * 1024) {
    throw new AppError(413, 'LETTER_TOO_LARGE', `Письмо ${kb(bytes)} КБ — больше допустимых ${limits.maxLetterKb} КБ. Уменьшите изображения или их число`);
  }
  return { bytes, warn: bytes >= limits.warnLetterKb * 1024 };
}
