// Экспорт учебного письма (1.9.0; 1.12.0 — макет, ADR-0044–0046; docs/specs/awareness.md, разделы 16, 22–25).
// .eml и «Скопировать с оформлением» — HTML макета (export/mail.ts); печать — как в 1.9.0, без макета.
// Каждая выгрузка .eml сохраняется файлом (message/rfc822) и строкой awareness_letter_exports: отметка «Отправлено»
// берёт её как «Файл письма». Повторная выгрузка отправленного письма на том же языке отдаёт отправленный файл.
// Журнал: awareness_letter.exported — формат, язык, версия (и sha256 у .eml).
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import type { FileStore } from '../../lib/file-store.js';
import { todayIso } from '../../lib/today.js';
import { readPortalParam } from '../settings/portal-params.js';
import type { Actor } from '../settings/common.js';
import { buildEml, emlFileName } from './export/eml.js';
import { substituteSignature, type ExportLang, type Signature } from './export/html.js';
import { composeMail, type ComposedMail, type LetterKindForLabel } from './export/mail.js';
import { readLayout, readLogo } from './layout.service.js';
import { auditLetter, cleanContent, currentSignature, exportLangs, type LetterDeps } from './letters.service.js';
import type { LetterLimits } from './sanitize.js';
import { AWARENESS_LETTERS_KEY } from './settings.js';
import { withHead, type TemplateTexts, type TextsInput } from './variables.js';

export type ExportFormat = 'eml' | 'html' | 'print';

export const LANG_TEXT: Record<ExportLang, string> = { ru: 'RU', tj: 'TJ', both: 'RU+TJ' };
const FORMAT_TEXT: Record<ExportFormat, string> = { eml: '.eml', html: 'копирование с оформлением', print: 'печать' };

interface PickedVersion { id: string; no: number; reason: string; texts: TemplateTexts }
interface Picked {
  letter: { id: string; number: number; title: string; kind: LetterKindForLabel };
  version: PickedVersion;
  /** null — версия sent: подпись уже подставлена текстом. */
  signature: Signature | null;
  /** Отправленная версия 1.9.0 (без файла отправки): подпись макета не выводится — подпись уже в тексте. */
  legacySent: boolean;
}

async function pick(db: Db, id: string, lang: ExportLang, versionNo?: number): Promise<Picked> {
  const l = await db.awarenessLetter.findUnique({ where: { id, deletedAt: null }, select: { id: true, number: true, title: true, kind: true, currentVersion: true } });
  if (!l) throw notFound('Письмо');
  const v = versionNo === undefined
    ? l.currentVersion
    : await db.awarenessLetterVersion.findUnique({ where: { letterId_no: { letterId: id, no: versionNo } } });
  if (!v) throw notFound('Версия письма');
  const texts = withHead(v);
  const langs = exportLangs(texts);
  if (!langs.includes(lang)) {
    throw badRequest('LANG_NOT_AVAILABLE', langs.length
      ? `В версии ${v.no} нет текста на ${lang === 'tj' ? 'таджикском' : lang === 'ru' ? 'русском' : 'обоих языках'}. Можно выгрузить: ${langs.map((x) => LANG_TEXT[x]).join(', ')}`
      : `Версия ${v.no} пустая — выгружать нечего`);
  }
  const sent = v.reason === 'sent';
  const legacySent = sent && !(await db.awarenessLetterEvent.findFirst({ where: { letterId: id, versionId: v.id, action: 'sent', exportId: { not: null } }, select: { id: true } }));
  return {
    letter: { id: l.id, number: l.number, title: l.title, kind: l.kind as LetterKindForLabel },
    version: { id: v.id, no: v.no, reason: v.reason, texts },
    signature: sent ? null : await currentSignature(db),
    legacySent,
  };
}

async function compose(db: Db, store: FileStore | undefined, p: Picked, lang: ExportLang): Promise<ComposedMail> {
  return composeMail(p.version.texts, {
    lang, kind: p.letter.kind, layout: await readLayout(db), logo: await readLogo(db, store), signature: p.signature, layoutSignature: !p.legacySent,
  });
}

async function logExport(db: Db, actor: Actor, p: Picked, format: ExportFormat, lang: ExportLang, extra: Record<string, unknown> = {}) {
  const sha = typeof extra.sha256 === 'string' ? `, sha256 ${extra.sha256.slice(0, 12)}…` : '';
  await auditLetter(db, actor, p.letter, 'exported', `экспорт: ${FORMAT_TEXT[format]}, ${LANG_TEXT[lang]}, версия ${p.version.no}${sha}`, {
    format, lang, versionNo: p.version.no, ...extra,
  });
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

/** Собрать .eml из версии: тема, макет, лимит размера по готовому файлу (413). */
async function buildFile(db: Db, store: FileStore | undefined, p: Picked, lang: ExportLang, now: Date) {
  const mail = await compose(db, store, p, lang);
  const eml = Buffer.from(buildEml({ subject: mail.subject, html: mail.html, text: mail.text, language: mail.language }), 'utf8');
  const limits = await readPortalParam<LetterLimits>(db, AWARENESS_LETTERS_KEY);
  if (eml.length > limits.maxLetterKb * 1024) {
    throw new AppError(413, 'LETTER_TOO_LARGE', `Готовое письмо ${Math.ceil(eml.length / 1024)} КБ — больше допустимых ${limits.maxLetterKb} КБ. Уменьшите изображения или их число`);
  }
  const t = p.version.texts;
  const fileSubject = lang === 'tj' ? t.subjectTj : t.subjectRu || t.subjectTj || p.letter.title;
  return { eml, fileName: emlFileName(fileSubject, lang, todayIso(now)), sha256: createHash('sha256').update(eml).digest('hex') };
}

/**
 * Сохранить файл выгрузки: сначала диск, затем строки files и awareness_letter_exports (в транзакции вызывающего).
 * Тип message/rfc822 создаёт только сервер (ADR-0046).
 */
async function saveExport(tx: Db, store: FileStore, actor: Actor, p: Picked, lang: ExportLang, f: { eml: Buffer; fileName: string; sha256: string }) {
  const storageKey = await store.put(f.eml);
  const file = await tx.file.create({
    data: { storageKey, originalName: f.fileName, mime: 'message/rfc822', size: BigInt(f.eml.length), sha256: f.sha256, uploadedBy: actor.id },
  });
  return tx.awarenessLetterExport.create({ data: { letterId: p.letter.id, versionId: p.version.id, langs: lang, fileId: file.id, sha256: f.sha256, createdBy: actor.id } });
}

function requireStore(store: FileStore | undefined): FileStore {
  if (!store) throw new AppError(503, 'FILES_UNAVAILABLE', 'Хранилище файлов недоступно. Обратитесь к администратору');
  return store;
}

/**
 * Файл .eml «Скачать для Outlook»: письмо открывается как неотправленное (X-Unsent). Выгрузка сохраняется — её возьмёт
 * «Отметить отправленным». У отправленной версии на языке отправки — отправленный файл, без новой выгрузки.
 */
export async function exportEml(db: Db, store: FileStore | undefined, actor: Actor, id: string, q: { lang: ExportLang; version?: number }, deps: LetterDeps = {}) {
  const fs = requireStore(store);
  const p = await pick(db, id, q.lang, q.version);
  if (p.version.reason === 'sent') {
    const sent = await db.awarenessLetterEvent.findFirst({
      where: { letterId: id, versionId: p.version.id, action: 'sent', export: { langs: q.lang } },
      orderBy: { at: 'asc' }, select: { export: { select: { sha256: true, file: { select: { storageKey: true, originalName: true } } } } },
    });
    if (sent?.export) {
      const eml = await readAll(fs.open(sent.export.file.storageKey));
      await logExport(db, actor, p, 'eml', q.lang, { sha256: sent.export.sha256, sentFile: true });
      return { fileName: sent.export.file.originalName, eml };
    }
  }
  const f = await buildFile(db, store, p, q.lang, deps.now?.() ?? new Date());
  await withTx(db, async (tx) => {
    const exp = await saveExport(tx, fs, actor, p, q.lang, f);
    await logExport(tx, actor, p, 'eml', q.lang, { sha256: f.sha256, exportId: exp.id, fileId: exp.fileId, bytes: f.eml.length });
  });
  return { fileName: f.fileName, eml: f.eml };
}

/**
 * «Файл письма» для отметки «Отправлено» (в её транзакции): выбранная или последняя выгрузка этой версии с этими
 * языками, иначе файл собирается сейчас. versionNo — версия, с которой отправляли (у первой отметки — до версии sent).
 */
export async function exportForSend(
  tx: Db, store: FileStore | undefined, actor: Actor, letterId: string, versionNo: number, lang: ExportLang, exportId: string | undefined, now: Date,
) {
  const p = await pick(tx, letterId, lang, versionNo);
  const withFile = { file: { select: { id: true, originalName: true } } } as const;
  if (exportId) {
    const e = await tx.awarenessLetterExport.findFirst({ where: { id: exportId, letterId }, include: withFile });
    if (!e) throw badRequest('EXPORT_NOT_FOUND', 'Выбранная выгрузка не найдена. Выберите другую или оставьте «собрать сейчас»');
    if (e.langs !== lang) throw badRequest('EXPORT_LANG', `Выбранная выгрузка — ${LANG_TEXT[e.langs as ExportLang]}, а отмечены языки ${LANG_TEXT[lang]}`);
    if (e.versionId !== p.version.id) throw badRequest('EXPORT_VERSION', 'Выбранная выгрузка сделана с другой версии письма. Выгрузите письмо заново');
    return { export: e, built: false };
  }
  const last = await tx.awarenessLetterExport.findFirst({ where: { letterId, versionId: p.version.id, langs: lang }, orderBy: { createdAt: 'desc' }, include: withFile });
  if (last) return { export: last, built: false };
  // Без хранилища (сборка приложения без тома файлов, отдельные тесты сервиса) — отметка без файла.
  if (!store) return null;
  const f = await buildFile(tx, store, p, lang, now);
  const e = await saveExport(tx, store, actor, p, lang, f);
  await logExport(tx, actor, p, 'eml', lang, { sha256: f.sha256, exportId: e.id, fileId: e.fileId, bytes: f.eml.length, forSend: true });
  const file = await tx.file.findUniqueOrThrow({ where: { id: e.fileId }, select: { id: true, originalName: true } });
  return { export: { ...e, file }, built: true };
}

/** Выгрузки письма для диалога «Отметить отправленным»: новые сверху. */
export async function listExports(db: Db, letterId: string) {
  const rows = await db.awarenessLetterExport.findMany({
    where: { letterId }, orderBy: { createdAt: 'desc' }, take: 50,
    include: { version: { select: { no: true } }, file: { select: { originalName: true, size: true } }, creator: { select: { id: true, fullName: true } } },
  });
  return {
    items: rows.map((e) => ({
      id: e.id, langs: e.langs as ExportLang, versionNo: e.version.no, fileName: e.file.originalName, size: Number(e.file.size), sha256: e.sha256,
      createdBy: e.creator, createdAt: e.createdAt.toISOString(),
    })),
  };
}

/** Предпросмотр сохранённой версии «как в почте» — тот же HTML, что .eml (изображения data:); не экспорт, без журнала. */
export async function previewVersion(db: Db, store: FileStore | undefined, id: string, q: { lang: ExportLang; version?: number }) {
  const p = await pick(db, id, q.lang, q.version);
  const mail = await compose(db, store, p, q.lang);
  return { subject: mail.subject, html: mail.html, versionNo: p.version.no };
}

/** «Скопировать с оформлением»: HTML макета (изображения data:) и простой текст для буфера обмена. */
export async function exportHtml(db: Db, store: FileStore | undefined, actor: Actor, id: string, q: { lang: ExportLang; version?: number }) {
  const p = await pick(db, id, q.lang, q.version);
  const mail = await compose(db, store, p, q.lang);
  await logExport(db, actor, p, 'html', q.lang);
  return { subject: mail.subject, html: mail.html, text: mail.text, versionNo: p.version.no };
}

/**
 * «Предпросмотр как в почте» из несохранённого содержимого (форма письма или шаблона): санитайзер и лимиты как при
 * сохранении, затем тот же макет, что у .eml. Ничего не сохраняется и не пишется в журнал.
 */
export async function previewMail(db: Db, store: FileStore | undefined, input: TextsInput & { kind: LetterKindForLabel; lang: ExportLang }, deps: LetterDeps = {}) {
  const content = await cleanContent(db, input, deps);
  const langs = exportLangs(content.texts);
  if (!langs.includes(input.lang)) {
    throw badRequest('LANG_NOT_AVAILABLE', `Нет текста для ${LANG_TEXT[input.lang]}. Можно: ${langs.map((x) => LANG_TEXT[x]).join(', ') || 'ничего — письмо пустое'}`);
  }
  const mail = composeMail(content.texts, {
    lang: input.lang, kind: input.kind, layout: await readLayout(db), logo: await readLogo(db, store), signature: await currentSignature(db), layoutSignature: true,
  });
  return { subject: mail.subject, html: mail.html, warnings: content.warnings, removed: content.removed };
}

/**
 * Данные страницы печати (PDF через печать браузера): части по языкам без почтовых стилей — оформление задаёт
 * CSS страницы. HTML прошёл санитайзер при сохранении, подпись подставлена.
 */
export async function exportPrint(db: Db, actor: Actor, id: string, q: { lang: ExportLang; version?: number }) {
  const p = await pick(db, id, q.lang, q.version);
  const t = p.version.texts;
  const part = (lang: 'ru' | 'tj') => {
    const html = lang === 'ru' ? t.htmlRu : t.htmlTj;
    const sig = p.signature ? (lang === 'ru' ? p.signature.htmlRu : p.signature.htmlTj) : null;
    return { lang, subject: (lang === 'ru' ? t.subjectRu : t.subjectTj).trim(), html: sig === null ? html : substituteSignature(html, sig) };
  };
  await logExport(db, actor, p, 'print', q.lang);
  return {
    number: p.letter.number,
    title: p.letter.title,
    versionNo: p.version.no,
    lang: q.lang,
    parts: q.lang === 'both' ? [part('ru'), part('tj')] : [part(q.lang)],
  };
}
