// Готовое письмо (1.12.0; docs/specs/awareness.md, разделы 22–24): содержимое версии + «Оформление писем» → тема, HTML
// макета, текстовая часть. Одна функция для предпросмотра, «Скопировать с оформлением» и .eml — поэтому предпросмотр
// показывает ровно то, что уйдёт в файл (изображения — data:, файл заменяет их на cid:).
import type { TemplateTexts } from '../variables.js';
import { LETTER_LANG_TO_CODE } from '../../../lib/languages.js';
import { contentToMail, firstSentence } from './content.js';
import { substituteSignature, type ExportLang, type Signature } from './html.js';
import { renderMail, type MailCard, type MailLang, type MailLogo } from './layout.js';
import { htmlToText } from './text.js';

/** «Оформление писем» (строка awareness_layout без служебных колонок). */
export interface LayoutSettings {
  deptRu: string;
  deptTj: string;
  email: string;
  closingRu: string;
  closingTj: string;
  footerRu: string;
  footerTj: string;
  labelUrgentRu: string;
  labelUrgentTj: string;
  labelPlannedRu: string;
  labelPlannedTj: string;
  tjHint: string;
}

export type LetterKindForLabel = 'planned' | 'urgent';

export interface ComposeOptions {
  lang: ExportLang;
  kind: LetterKindForLabel;
  layout: LayoutSettings;
  logo: MailLogo | null;
  /** «Подпись ИБ» для блока в тексте; null — блок уже подставлен текстом (версия sent). */
  signature: Signature | null;
  /** false — подпись макета не выводится (отправленная версия 1.9.0: подпись уже в тексте). */
  layoutSignature: boolean;
}

export interface ComposedMail {
  subject: string;
  html: string;
  text: string;
  /** Content-Language. */
  language: string;
}

/** Блок «Подпись ИБ» или подпись, подставленная при отправке (1.12.0): подпись макета тогда не выводится. */
const SIGNATURE_BLOCK_RE = /<div data-ib-fragment="signature(?:-sent)?">/;
const cap = (l: MailLang) => (l === 'ru' ? 'Ru' : 'Tj') as 'Ru' | 'Tj';

/** Метка по умолчанию — из настроек по типу письма. */
export function defaultLabel(layout: LayoutSettings, kind: LetterKindForLabel, lang: MailLang): string {
  return layout[`label${kind === 'urgent' ? 'Urgent' : 'Planned'}${cap(lang)}`];
}

/** Тема RU+TJ: «Тема общая» или «тема RU | тема TJ». */
export function bothSubject(t: Pick<TemplateTexts, 'subjectRu' | 'subjectTj' | 'subjectBoth'>): string {
  return t.subjectBoth.trim() || [t.subjectRu.trim(), t.subjectTj.trim()].filter(Boolean).join(' | ');
}

export function subjectOf(t: TemplateTexts, lang: ExportLang): string {
  return lang === 'both' ? bothSubject(t) : (lang === 'ru' ? t.subjectRu : t.subjectTj).trim();
}

export function composeMail(t: TemplateTexts, o: ComposeOptions): ComposedMail {
  const langs: MailLang[] = o.lang === 'both' ? ['ru', 'tj'] : [o.lang];
  const texts: string[] = [];
  const cards: MailCard[] = langs.map((lang) => {
    const L = cap(lang);
    const raw = t[`html${L}`];
    const hasBlock = SIGNATURE_BLOCK_RE.test(raw);
    const html = o.signature ? substituteSignature(raw, o.signature[`html${L}`]) : raw;
    const dept = o.layout[`dept${L}`];
    const header = t[`header${L}`].trim() || t[`subject${L}`].trim();
    const label = t[`label${L}`].trim() || defaultLabel(o.layout, o.kind, lang);
    const signature = o.layoutSignature && !hasBlock ? { closing: o.layout[`closing${L}`], dept, email: o.layout.email } : null;
    const footer = o.layout[`footer${L}`];
    texts.push([
      header,
      htmlToText(html),
      signature ? [signature.closing, signature.dept, signature.email].map((s) => s.trim()).filter(Boolean).join('\n') : '',
      footer.trim(),
    ].filter(Boolean).join('\n\n'));
    return { lang, header, label, body: contentToMail(html), signature, footer, dept };
  });
  const subject = subjectOf(t, o.lang);
  const preheader = firstSentence(htmlToText(cards[0] ? t[`html${cap(cards[0].lang)}`] : ''));
  return {
    subject,
    html: renderMail({ subject, preheader, cards, tjHint: o.layout.tjHint, logo: o.logo }),
    text: texts.join('\n\n————————————————\n\n'),
    // Content-Language — коды общего списка языков (ключ письма tj → tg).
    language: langs.map((l) => LETTER_LANG_TO_CODE[l]).join(', '),
  };
}
