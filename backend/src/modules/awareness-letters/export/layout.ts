// Макет учебного письма (1.12.0, ADR-0044; docs/specs/awareness.md, раздел 22; эталон — docs/email/layout-reference.html).
// Код, а не HTML в базе: письмо и шаблон хранят только содержимое, оформление накладывается здесь при предпросмотре,
// выгрузке .eml и «Скопировать с оформлением». Только таблицы и inline-стили: Outlook (Word), веб-почта, телефоны.
// Карточка 600 px (width, max-width и условная таблица для Outlook), до 620 px — на всю ширину. Шрифт Arial.
import { MAIL_FONT, LINK_STYLE } from './content.js';

export type MailLang = 'ru' | 'tj';

export interface MailCard {
  lang: MailLang;
  /** «Заголовок» шапки — простой текст. */
  header: string;
  /** «Метка» шапки — простой текст. */
  label: string;
  /** Тело — уже почтовый HTML (contentToMail). */
  body: string;
  /** Подпись макета; null — не выводится (в тексте блок «Подпись ИБ» или отправленная версия 1.9.0). */
  signature: { closing: string; dept: string; email: string } | null;
  /** Подвал — простой текст; пустой не выводится. */
  footer: string;
  /** Название отдела этого языка: alt логотипа и шапка без логотипа. */
  dept: string;
}

export interface MailLogo {
  /** src изображения: data: (предпросмотр, буфер) — .eml заменяет его на cid: одной частью на обе карточки. */
  src: string;
  width: number;
  height: number;
}

export interface MailDoc {
  subject: string;
  preheader: string;
  cards: MailCard[];
  /** Подсказка над первой карточкой RU+TJ — ссылка на таджикскую часть. */
  tjHint: string;
  logo: MailLogo | null;
}

/** Экранирование простого текста для HTML (заголовок, метка, подпись, подвал). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LANG_ATTR: Record<MailLang, string> = { ru: 'ru', tj: 'tg' };
const TEXT = `${MAIL_FONT};font-size:15px;line-height:23px;color:#0F172A;`;
/** Логотип в шапке — 238 px по ширине, высота по пропорциям файла. */
export const LOGO_WIDTH = 238;

function header(card: MailCard, logo: MailLogo | null): string {
  const anchor = `<a name="${card.lang}" id="${card.lang}"></a>`;
  const img = logo
    ? `<img src="${logo.src}" width="${logo.width}" height="${logo.height}" alt="${escapeHtml(card.dept)}" style="display:block;width:${logo.width}px;height:${logo.height}px;border:0;outline:none;${MAIL_FONT};font-size:16px;color:#FFFFFF;">`
    : `<p style="margin:0;${MAIL_FONT};font-size:16px;line-height:22px;font-weight:bold;color:#FFFFFF;">${escapeHtml(card.dept)}</p>`;
  const title = card.header.trim()
    ? `<p style="margin:18px 0 0 0;${MAIL_FONT};font-size:24px;line-height:30px;font-weight:bold;color:#FFFFFF;">${escapeHtml(card.header.trim())}</p>`
    : '';
  const label = card.label.trim()
    ? `<p style="margin:8px 0 0 0;${MAIL_FONT};font-size:12px;line-height:16px;letter-spacing:2px;color:#BFDBFE;text-transform:uppercase;">${escapeHtml(card.label.trim())}</p>`
    : '';
  return `<tr><td align="center" style="background:#1E3A8A;padding:28px 24px 26px 24px;">\n${anchor}\n${img}\n${title}\n${label}\n</td></tr>`;
}

function signature(s: NonNullable<MailCard['signature']>): string {
  const email = s.email.trim();
  const mail = email
    ? `<br><a href="mailto:${escapeHtml(email)}" style="${LINK_STYLE}white-space:nowrap;">${escapeHtml(email)}</a>`
    : '';
  return `<p style="margin:0;${TEXT}">${escapeHtml(s.closing.trim())}<br><b>${escapeHtml(s.dept.trim())}</b>${mail}</p>`;
}

function card(c: MailCard, logo: MailLogo | null): string {
  const footer = c.footer.trim()
    ? `\n<tr><td style="border-top:1px solid #E2E8F0;padding:14px 28px 16px 28px;">\n<p style="margin:0;${MAIL_FONT};font-size:12px;line-height:18px;color:#64748B;">${escapeHtml(c.footer.trim()).replace(/\r?\n/g, '<br>')}</p>\n</td></tr>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" lang="${LANG_ATTR[c.lang]}" style="border-collapse:collapse;background:#FFFFFF;border:1px solid #E2E8F0;">\n`
    + `${header(c, logo)}\n`
    + `<tr><td style="padding:26px 28px 24px 28px;">\n${c.body}${c.signature ? signature(c.signature) : ''}\n</td></tr>${footer}\n</table>`;
}

/** Полный HTML-документ письма: одна или две карточки (RU, затем TJ), прехедер, подсказка о таджикском тексте. */
export function renderMail(doc: MailDoc): string {
  const rows: string[] = [];
  const both = doc.cards.length > 1;
  if (both && doc.tjHint.trim()) {
    rows.push(`<tr><td align="right" style="padding:0 2px 8px 0;${MAIL_FONT};font-size:12px;line-height:16px;color:#64748B;">\n<a href="#tj" style="color:#64748B;text-decoration:none;">${escapeHtml(doc.tjHint.trim())}</a></td></tr>`);
  }
  doc.cards.forEach((c, i) => {
    if (i > 0) rows.push('<tr><td style="height:24px;font-size:0;line-height:0;">&nbsp;</td></tr>');
    rows.push(`<tr><td><!-- ===== ${c.lang.toUpperCase()} ===== -->\n${card(c, doc.logo)}</td></tr>`);
  });
  const lang = LANG_ATTR[doc.cards[0]?.lang ?? 'ru'];
  return '<!DOCTYPE html>\n'
    + `<html lang="${lang}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">\n<head>\n`
    + '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<meta name="x-apple-disable-message-reformatting">\n<meta name="color-scheme" content="light">\n<meta name="supported-color-schemes" content="light">\n'
    + `<title>${escapeHtml(doc.subject)}</title>\n`
    + '<!--[if mso]><style>table,td,p,a{font-family:Arial,sans-serif !important;}</style><![endif]-->\n'
    + '<style>\n  body{margin:0;padding:0;}\n  @media (max-width:620px){ .wrap{width:100% !important;} .pad{padding-left:12px !important;padding-right:12px !important;} }\n</style>\n'
    + '</head>\n<body style="margin:0;padding:0;background:#F1F5F9;">\n'
    + `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#F1F5F9;">${escapeHtml(doc.preheader)}</div>\n`
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#F1F5F9;">\n'
    + '<tr><td align="center" class="pad" style="padding:20px 16px 28px 16px;">\n'
    + '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->\n'
    + '<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:600px;max-width:600px;">\n'
    + `${rows.join('\n')}\n</table>\n<!--[if mso]></td></tr></table><![endif]-->\n</td></tr></table>\n</body>\n</html>\n`;
}

/** Размеры PNG из заголовка IHDR; null — не PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Логотип для шапки: ширина 238 px, высота по пропорциям (не меньше 1). */
export function logoOf(png: Buffer): MailLogo | null {
  const size = pngSize(png);
  if (!size || size.width < 1 || size.height < 1) return null;
  return { src: `data:image/png;base64,${png.toString('base64')}`, width: LOGO_WIDTH, height: Math.max(1, Math.round((LOGO_WIDTH * size.height) / size.width)) };
}
