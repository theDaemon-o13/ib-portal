// Экспорт учебного письма (1.9.0; docs/specs/awareness.md, раздел 16): .eml, HTML для буфера обмена, данные для печати.
// Язык — RU, TJ или RU+TJ, только заполненные. По умолчанию — последняя версия (у отправленного это версия sent),
// можно выбрать любую. В версии sent подпись уже текстом; в остальных блок «Подпись ИБ» — текущая подпись.
// Каждый экспорт — строка журнала awareness_letter.exported: формат, язык, версия.
import type { Db } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { Actor } from '../settings/common.js';
import { buildEml } from './export/eml.js';
import { composeLetter, mailDocument, substituteSignature, type ExportLang, type Signature } from './export/html.js';
import { htmlToText } from './export/text.js';
import { auditLetter, currentSignature, exportLangs } from './letters.service.js';
import type { TemplateTexts } from './variables.js';

export type ExportFormat = 'eml' | 'html' | 'print';

const LANG_TEXT: Record<ExportLang, string> = { ru: 'RU', tj: 'TJ', both: 'RU+TJ' };
const FORMAT_TEXT: Record<ExportFormat, string> = { eml: '.eml', html: 'копирование с оформлением', print: 'печать' };

interface Picked {
  letter: { id: string; number: number; title: string };
  versionNo: number;
  texts: TemplateTexts;
  /** null — версия sent: подпись уже подставлена текстом. */
  signature: Signature | null;
}

async function pick(db: Db, id: string, lang: ExportLang, versionNo?: number): Promise<Picked> {
  const l = await db.awarenessLetter.findUnique({ where: { id }, select: { id: true, number: true, title: true, currentVersion: true } });
  if (!l) throw notFound('Письмо');
  const v = versionNo === undefined
    ? l.currentVersion
    : await db.awarenessLetterVersion.findUnique({ where: { letterId_no: { letterId: id, no: versionNo } } });
  if (!v) throw notFound('Версия письма');
  const texts: TemplateTexts = { subjectRu: v.subjectRu, subjectTj: v.subjectTj, htmlRu: v.htmlRu, htmlTj: v.htmlTj };
  const langs = exportLangs(texts);
  if (!langs.includes(lang)) {
    throw badRequest('LANG_NOT_AVAILABLE', langs.length
      ? `В версии ${v.no} нет текста на ${lang === 'tj' ? 'таджикском' : lang === 'ru' ? 'русском' : 'обоих языках'}. Можно выгрузить: ${langs.map((x) => LANG_TEXT[x]).join(', ')}`
      : `Версия ${v.no} пустая — выгружать нечего`);
  }
  return {
    letter: { id: l.id, number: l.number, title: l.title }, versionNo: v.no, texts,
    signature: v.reason === 'sent' ? null : await currentSignature(db),
  };
}

async function logExport(db: Db, actor: Actor, p: Picked, format: ExportFormat, lang: ExportLang) {
  await auditLetter(db, actor, p.letter, 'exported', `экспорт: ${FORMAT_TEXT[format]}, ${LANG_TEXT[lang]}, версия ${p.versionNo}`, {
    format, lang, versionNo: p.versionNo,
  });
}

/** Файл .eml: письмо открывается в почтовом клиенте как неотправленное (X-Unsent). */
export async function exportEml(db: Db, actor: Actor, id: string, q: { lang: ExportLang; version?: number }) {
  const p = await pick(db, id, q.lang, q.version);
  const { subject, body } = composeLetter(p.texts, q.lang, p.signature);
  const eml = buildEml({ subject, html: mailDocument(body), text: htmlToText(body) });
  await logExport(db, actor, p, 'eml', q.lang);
  return { title: p.letter.title, eml };
}

/** «Скопировать с оформлением»: text/html (встроенные стили, изображения data:) и text/plain для буфера обмена. */
export async function exportHtml(db: Db, actor: Actor, id: string, q: { lang: ExportLang; version?: number }) {
  const p = await pick(db, id, q.lang, q.version);
  const { subject, body } = composeLetter(p.texts, q.lang, p.signature);
  await logExport(db, actor, p, 'html', q.lang);
  return { subject, html: mailDocument(body), text: htmlToText(body), versionNo: p.versionNo };
}

/**
 * Данные страницы печати (PDF через печать браузера): части по языкам без почтовых стилей — оформление задаёт
 * CSS страницы. HTML прошёл санитайзер при сохранении, подпись подставлена.
 */
export async function exportPrint(db: Db, actor: Actor, id: string, q: { lang: ExportLang; version?: number }) {
  const p = await pick(db, id, q.lang, q.version);
  const part = (lang: 'ru' | 'tj') => {
    const html = lang === 'ru' ? p.texts.htmlRu : p.texts.htmlTj;
    const sig = p.signature ? (lang === 'ru' ? p.signature.htmlRu : p.signature.htmlTj) : null;
    return { lang, subject: (lang === 'ru' ? p.texts.subjectRu : p.texts.subjectTj).trim(), html: sig === null ? html : substituteSignature(html, sig) };
  };
  await logExport(db, actor, p, 'print', q.lang);
  return {
    number: p.letter.number,
    title: p.letter.title,
    versionNo: p.versionNo,
    lang: q.lang,
    parts: q.lang === 'both' ? [part('ru'), part('tj')] : [part(q.lang)],
  };
}
