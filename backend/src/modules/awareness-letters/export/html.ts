// HTML письма для почтовых клиентов (1.9.0; docs/specs/awareness.md, раздел 16): подпись, встроенные стили, RU+TJ.
// На входе — HTML, уже прошедший санитайзер (теги без атрибутов style и class), поэтому стили вставляются по тегам.
// Встроенные стили в БД не хранятся: они нужны только Outlook и веб-почте, где нет таблицы стилей портала.
import { SIGNATURE_BLOCK } from '../variables.js';

export type ExportLang = 'ru' | 'tj' | 'both';

export interface LetterContent {
  subjectRu: string;
  subjectTj: string;
  htmlRu: string;
  htmlTj: string;
}

/** Текущая «Подпись ИБ»; null — подпись уже подставлена (версия sent замороженного письма). */
export interface Signature {
  htmlRu: string;
  htmlTj: string;
}

const SIGNATURE_RE = /<div data-ib-fragment="signature">\s*<\/div>/g;

/**
 * Подставить текст подписи вместо блока «Подпись ИБ» (просмотр, экспорт, версия sent при отправке).
 * sent — версия sent 1.12.0: блок с пометкой signature-sent, макет по ней не добавляет вторую подпись.
 */
export function substituteSignature(html: string, signatureHtml: string, sent = false): string {
  return html.replace(SIGNATURE_RE, () => (sent ? `<div data-ib-fragment="signature-sent">${signatureHtml}</div>` : `<div>${signatureHtml}</div>`));
}

const FONT = "font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1d1d1f";
const TAG_STYLES: Record<string, string> = {
  h2: 'font-size:20px;line-height:1.3;margin:16px 0 8px',
  h3: 'font-size:17px;line-height:1.3;margin:14px 0 6px',
  h4: 'font-size:15px;line-height:1.3;margin:12px 0 6px',
  p: 'margin:0 0 10px',
  ul: 'margin:0 0 10px;padding-left:24px',
  ol: 'margin:0 0 10px;padding-left:24px',
  blockquote: 'margin:0 0 10px;padding:4px 12px;border-left:3px solid #c7c7cc;color:#3a3a3c',
  table: 'border-collapse:collapse;margin:0 0 12px',
  th: 'border:1px solid #c7c7cc;padding:6px 8px;background:#f2f2f7;text-align:left;vertical-align:top',
  td: 'border:1px solid #c7c7cc;padding:6px 8px;vertical-align:top',
  img: 'max-width:100%;height:auto;border:0',
  hr: 'border:0;border-top:1px solid #c7c7cc;margin:16px 0',
  a: 'color:#0066cc',
};
const STYLED_RE = new RegExp(`<(${Object.keys(TAG_STYLES).join('|')})(?=[\\s>/])`, 'g');

/** Встроенные стили для почты. Ячейки таблиц: абзац внутри — без нижнего отступа. */
export function inlineMailStyles(html: string): string {
  return html
    .replace(STYLED_RE, (_, tag: string) => `<${tag} style="${TAG_STYLES[tag]}"`)
    .replace(/(<t[hd] [^>]*>)<p style="[^"]*">/g, '$1<p style="margin:0">');
}

const LANG_DIVIDER = '<hr style="border:0;border-top:2px solid #8e8e93;margin:24px 0">';

/** Тема и тело письма на выбранном языке; RU+TJ — сначала русский, затем разделитель и таджикский. */
export function composeLetter(c: LetterContent, lang: ExportLang, signature: Signature | null): { subject: string; body: string } {
  const part = (html: string, sig: string | undefined) => inlineMailStyles(sig === undefined ? html : substituteSignature(html, sig));
  const ru = part(c.htmlRu, signature?.htmlRu);
  const tj = part(c.htmlTj, signature?.htmlTj);
  if (lang === 'ru') return { subject: c.subjectRu.trim(), body: ru };
  if (lang === 'tj') return { subject: c.subjectTj.trim(), body: tj };
  return { subject: `${c.subjectRu.trim()} / ${c.subjectTj.trim()}`, body: `${ru}${LANG_DIVIDER}${tj}` };
}

/** Полный HTML-документ для .eml и буфера обмена. */
export function mailDocument(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="${FONT}">${body}</body></html>`;
}

export { SIGNATURE_BLOCK };
