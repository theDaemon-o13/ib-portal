// Вставка и изображения редактора писем (1.9.0; docs/specs/awareness.md, раздел 15). Без TipTap: чистые функции.
// Изображения — только данными (data: PNG, JPEG, GIF). Текст прошлого письма из Outlook или Word приносит картинки
// ссылками cid:, file:// или внешним адресом: если в буфере есть сами картинки — подставляем их по порядку, иначе
// убираем ссылки и говорим, сколько не вставлено (решение владельца 05.11.2026). Тот же текст — у backend (warnings).

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export function imagesWarning(n: number): string | null {
  return n > 0 ? `Не вставлено изображений: ${n}. Картинки по ссылке не поддерживаются — сохраните их файлом и вставьте заново` : null;
}

const IMG_RE = /<img\b[^>]*>/gi;
const SRC_RE = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Картинка по ссылке, а не данными: cid:, file://, http(s), относительный путь, пустой src. */
export function isLinkedSrc(src: string): boolean {
  return !/^data:image\/(png|jpeg|gif);base64,/i.test(src.trim());
}

const srcOf = (tag: string) => {
  const m = SRC_RE.exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
};

/**
 * Подставить в HTML вставки картинки из буфера (data: URL) вместо ссылок — по порядку. Картинки по ссылке, для
 * которых данных нет, удаляются; их число — missing. Картинки данными остаются как есть.
 */
export function replaceLinkedImages(html: string, dataUrls: readonly string[]): { html: string; missing: number } {
  let next = 0;
  let missing = 0;
  const out = html.replace(IMG_RE, (tag) => {
    const src = srcOf(tag);
    if (!isLinkedSrc(src)) return tag;
    const data = dataUrls[next];
    if (data === undefined) {
      missing++;
      return '';
    }
    next++;
    return tag.replace(SRC_RE, `src="${data}"`);
  });
  return { html: out, missing };
}

/** Сколько картинок по ссылке в HTML. */
export function countLinkedImages(html: string): number {
  return [...html.matchAll(IMG_RE)].filter((m) => isLinkedSrc(srcOf(m[0]))).length;
}

export const kb = (bytes: number) => Math.ceil(bytes / 1024);

/** Проверка файла изображения до вставки: тип и размер. Решает всё равно backend. */
export function checkImageFile(file: { type: string; size: number }, maxImageKb: number): string | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return 'Вставьте картинку PNG, JPEG или GIF';
  if (file.size > maxImageKb * 1024) return `Изображение ${kb(file.size)} КБ — больше допустимых ${maxImageKb} КБ. Уменьшите его`;
  return null;
}

/** Размер письма, как его считает backend: HTML обоих языков вместе с изображениями (UTF-8). */
export function letterBytes(htmlRu: string, htmlTj: string): number {
  const enc = new TextEncoder();
  return enc.encode(htmlRu).length + enc.encode(htmlTj).length;
}

export function sizeWarning(bytes: number, limits: { warnLetterKb: number; maxLetterKb: number }): { level: 'ok' | 'warn' | 'over'; text: string | null } {
  if (bytes > limits.maxLetterKb * 1024) return { level: 'over', text: `Письмо ${kb(bytes)} КБ — больше допустимых ${limits.maxLetterKb} КБ. Уменьшите изображения или их число` };
  if (bytes >= limits.warnLetterKb * 1024) return { level: 'warn', text: `Письмо ${kb(bytes)} КБ — каждая из 1500+ копий ляжет на почтовый сервер` };
  return { level: 'ok', text: null };
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Не удалось прочитать файл'));
    r.readAsDataURL(file);
  });
}
