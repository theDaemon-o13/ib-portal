// Файл .eml учебного письма (1.9.0; docs/specs/awareness.md, раздел 16). Без зависимостей.
// Структура: multipart/alternative → text/plain + multipart/related → text/html + изображения (Content-ID).
// Без From, To и Date — их ставит почтовый клиент; X-Unsent: 1 — Outlook открывает файл как новое письмо.
// 1.12.0 (ADR-0045): Content-Language; разделители частей — из sha256 содержимого: одинаковое письмо — одинаковый файл.
import { createHash } from 'node:crypto';

const CRLF = '\r\n';

/** base64 строками по 76 символов (RFC 2045). */
export function base64Lines(data: Buffer): string {
  return (data.toString('base64').match(/.{1,76}/g) ?? []).join(CRLF);
}

/**
 * Заголовок по RFC 2047: кодированные слова `=?UTF-8?B?…?=` не длиннее 75 символов, перенос строки с пробелом.
 * Символ UTF-8 не разрезается между словами. Только ASCII без управляющих — как есть.
 */
export function encodeHeader(name: string, value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean) && `${name}: ${clean}`.length <= 78) return `${name}: ${clean}`;
  // 75 − «=?UTF-8?B?» (10) − «?=» (2) = 63 символа base64 → не больше 45 байт (кратно 3).
  const MAX = 45;
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > MAX) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return `${name}: ${words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `)}`;
}

export interface EmlInput {
  subject: string;
  /** HTML-документ письма; изображения — data: (их заменят ссылки cid:). */
  html: string;
  text: string;
  /** Content-Language: «ru», «tg» или «ru, tg». */
  language?: string;
  /** Разделители частей; по умолчанию — из sha256 темы, HTML и текста (детерминированно). */
  boundary?: () => string;
}

const IMG_SRC_RE = /src="data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=]+)"/g;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

/** Собрать .eml: изображения вкладываются частями multipart/related, одинаковые — один раз. */
export function buildEml(input: EmlInput): string {
  const seed = createHash('sha256').update(input.subject).update('\0').update(input.html).update('\0').update(input.text).digest('hex');
  let n = 0;
  // «=_» не встречается в base64 и в заголовках частей — разделитель не совпадёт с содержимым.
  const boundary = input.boundary ?? (() => `=_ibportal_${seed.slice(0, 24)}_${++n}`);
  const images = new Map<string, { cid: string; mime: string; data: Buffer; n: number }>();
  const html = input.html.replace(IMG_SRC_RE, (_, mime: string, b64: string) => {
    const data = Buffer.from(b64, 'base64');
    const sha = createHash('sha256').update(data).digest('hex');
    let img = images.get(sha);
    if (!img) {
      img = { cid: `img-${sha.slice(0, 16)}@ibportal`, mime, data, n: images.size + 1 };
      images.set(sha, img);
    }
    return `src="cid:${img.cid}"`;
  });
  const alt = boundary();
  const rel = boundary();
  const lines: string[] = [
    'MIME-Version: 1.0',
    'X-Unsent: 1',
    encodeHeader('Subject', input.subject),
    ...(input.language ? [`Content-Language: ${input.language}`] : []),
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(input.text.replace(/\r?\n/g, CRLF), 'utf8')),
    `--${alt}`,
    `Content-Type: multipart/related; boundary="${rel}"; type="text/html"`,
    '',
    `--${rel}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(html, 'utf8')),
  ];
  for (const img of images.values()) {
    const file = `image${img.n}.${EXT[img.mime] ?? 'bin'}`;
    lines.push(
      `--${rel}`,
      `Content-Type: ${img.mime}; name="${file}"`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${img.cid}>`,
      `Content-Disposition: inline; filename="${file}"`,
      '',
      base64Lines(img.data),
    );
  }
  lines.push(`--${rel}--`, `--${alt}--`, '');
  return lines.join(CRLF);
}

/** Content-Disposition для скачивания файла с кириллическим именем (RFC 6266 / RFC 5987). */
export function attachmentDisposition(title: string, ext: string): string {
  const base = [...title].filter((c) => c >= ' ').join('').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Письмо';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
}

/** Запрещённые в именах файлов Windows символы и управляющие — «_» (1.12.0). */
export function safeFileName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
}

const LANG_FILE: Record<'both' | 'ru' | 'tj', string> = { both: 'RU-TJ', ru: 'RU', tj: 'TJ' };

/** Имя файла готового письма: «<Тема RU>_<RU-TJ|RU|TJ>_<ГГГГ-ММ-ДД>.eml» (у письма только на TJ — тема TJ). */
export function emlFileName(subject: string, lang: 'both' | 'ru' | 'tj', date: string): string {
  const base = safeFileName(subject).slice(0, 120) || 'Письмо';
  return `${base}_${LANG_FILE[lang]}_${date}.eml`;
}

/** Content-Disposition вложения с готовым именем файла (RFC 6266 / RFC 5987). */
export function fileDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
