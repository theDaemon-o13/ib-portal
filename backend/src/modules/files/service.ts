// Файлы (этап 7, CLAUDE.md 3.7, ADR-0011). Содержимое — в томе (lib/file-store.ts), метаданные — в files.
// Кто видит файл, решают ссылки на него: решение другого отдела, доказательство и поле «Файл» записи реестра —
// ib.work; PDF версии документа — тот, кто видит эту версию (ADR-0010); файл без ссылок — только загрузивший.
// Текст PDF для поиска извлекается фоновым прогоном (text.ts): при загрузке PDF получает строку file_texts 'pending'.
// Файл физически не удаляется; отметка «удалён» — только когда ссылок нет (сервис и триггер files_guard).
import { createHash } from 'node:crypto';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, notFound } from '../../lib/errors.js';
import { checkFile } from '../../lib/file-type.js';
import type { FileStore } from '../../lib/file-store.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { accessOf, versionVisible, type DocAccess } from '../documents/service.js';

import { fileDto, withUploader, type FileDto } from './links.js';

export { fileDto, type FileDto };

/** Загрузить: проверка имени, размера и типа по содержимому, запись на диск, затем строка в БД. */
export async function uploadFile(db: Db, store: FileStore, actor: Actor, rawName: string, data: Buffer): Promise<FileDto> {
  const check = checkFile(rawName, data);
  if (!check.ok) throw new AppError(check.code === 'FILE_TOO_LARGE' ? 413 : 400, check.code, check.message);
  const sha256 = createHash('sha256').update(data).digest('hex');
  // Сначала диск: если вставка в БД не пройдёт, на диске останется файл без строки — его покажет check:integrity.
  const storageKey = await store.put(data);
  return withTx(db, async (tx) => {
    const row = await tx.file.create({
      data: { storageKey, originalName: check.name, mime: check.mime, size: BigInt(data.length), sha256, uploadedBy: actor.id },
      include: withUploader,
    });
    if (check.mime === 'application/pdf') await tx.fileText.create({ data: { fileId: row.id } });
    await auditSettings(tx, actor, {
      action: 'file.uploaded', entity: 'file', entityId: row.id,
      summary: `Загружен файл «${check.name}» (${check.mime}, ${data.length} Б)`,
      after: { name: check.name, mime: check.mime, size: data.length, sha256 },
    });
    return fileDto(row);
  });
}

// ---------------------------------------------------------------- ссылки и доступ

const DOC_FILE_KIND: Record<string, string> = { draft: 'Файл драфта', head_approved: 'Одобренная начальником ИБ', final: 'Финальная', response: 'Ответ ответственного лица', translation: 'Перевод' };

export interface FileRef {
  kind: 'evidence' | 'decision' | 'document_pdf' | 'document_file' | 'record' | 'compare' | 'vuln_scan' | 'vuln_extension' | 'awareness_letter' | 'awareness_layout';
  id: string;
  label: string;
}

/** Действующие ссылки на файл (то же, что file_active_refs() в БД). */
export async function fileRefs(db: Db, fileId: string): Promise<(FileRef & { versionId?: string })[]> {
  const [links, decisions, versions, records, compares, docFiles, returnNotes, scans, handovers, extensions, versionDocx, translationFiles, letterExports, logos] = await Promise.all([
    db.evidenceFile.findMany({ where: { fileId, removedAt: null }, select: { evidence: { select: { id: true, number: true, title: true } } } }),
    db.registerDecision.findMany({ where: { fileId }, select: { id: true, documentTitle: true, documentNumber: true } }),
    db.documentVersion.findMany({ where: { pdfFileId: fileId }, select: { id: true, no: true, documentId: true, title: true } }),
    db.registerRecordFile.findMany({
      where: { fileId, removedAt: null },
      select: { field: { select: { label: true } }, record: { select: { id: true, number: true, register: { select: { name: true } } } } },
    }),
    // Сравнение с реестром (релиз 1.1.0): файл — доказательство, по какому отчёту меняли статусы.
    db.registerImport.findMany({ where: { fileId }, select: { id: true, createdAt: true, register: { select: { id: true, name: true } } } }),
    // Файлы версии документа (1.2.0): драфт, одобренная начальником ИБ, финальная.
    db.documentFile.findMany({ where: { fileId, removedAt: null }, select: { kind: true, documentId: true, versionId: true, version: { select: { no: true, title: true } } } }),
    // Записка к возврату на доработку (1.4.0): колонка решения document_approvals.file_id.
    db.documentApproval.findMany({ where: { fileId }, select: { documentId: true, versionId: true, version: { select: { no: true, title: true } } } }),
    // Раздел «Уязвимости» (1.5.0): файл скана и письмо передачи ИКТ.
    db.vulnScan.findMany({ where: { fileId }, select: { id: true, fileName: true } }),
    db.vulnScan.findMany({ where: { handoverFileId: fileId }, select: { id: true, fileName: true } }),
    db.vulnExtension.findMany({ where: { basisFileId: fileId }, select: { id: true, basisNumber: true } }),
    // Этап 24 «Утверждение» (1.11.0): исходный Word версии и файлы переводов (Word — обязателен, PDF — по желанию).
    db.documentVersion.findMany({ where: { sourceDocxFileId: fileId }, select: { id: true, no: true, documentId: true, title: true } }),
    db.documentTranslation.findMany({
      where: { OR: [{ sourceDocxFileId: fileId }, { signedPdfFileId: fileId }] },
      select: { language: true, documentId: true, versionId: true, sourceDocxFileId: true, version: { select: { no: true, title: true } } },
    }),
    // Учебные письма (1.12.0, ADR-0046): выгрузка .eml и логотип «Оформления писем» — для сотрудников ИБ.
    db.awarenessLetterExport.findMany({ where: { fileId }, select: { letter: { select: { id: true, number: true } }, version: { select: { no: true } } } }),
    db.awarenessLayout.findMany({ where: { logoFileId: fileId }, select: { id: true } }),
  ]);
  return [
    ...records.map((r) => ({ kind: 'record' as const, id: r.record.id, label: `«${r.record.register.name}», запись #${r.record.number}: ${r.field.label}` })),
    ...links.map((l) => ({ kind: 'evidence' as const, id: l.evidence.id, label: `Доказательство #${l.evidence.number} «${l.evidence.title}»` })),
    ...decisions.map((d) => ({ kind: 'decision' as const, id: d.id, label: `Решение: ${d.documentTitle} № ${d.documentNumber}` })),
    ...versions.map((v) => ({ kind: 'document_pdf' as const, id: v.documentId, versionId: v.id, label: `PDF версии ${v.no} «${v.title}»` })),
    ...docFiles.map((x) => ({
      kind: 'document_file' as const, id: x.documentId, versionId: x.versionId,
      label: `${DOC_FILE_KIND[x.kind] ?? 'Файл'} версии ${x.version.no} «${x.version.title}»`,
    })),
    ...versionDocx.map((v) => ({ kind: 'document_file' as const, id: v.documentId, versionId: v.id, label: `Word версии ${v.no} «${v.title}»` })),
    ...translationFiles.map((t) => ({
      kind: 'document_file' as const, id: t.documentId, versionId: t.versionId,
      label: `${t.sourceDocxFileId === fileId ? 'Word' : 'PDF'} перевода (${t.language}) версии ${t.version.no} «${t.version.title}»`,
    })),
    ...returnNotes.map((x) => ({
      kind: 'document_file' as const, id: x.documentId, versionId: x.versionId,
      label: `Записка к возврату версии ${x.version.no} «${x.version.title}»`,
    })),
    ...compares.map((c) => ({
      kind: 'compare' as const, id: c.register.id,
      label: `Сравнение с реестром «${c.register.name}» от ${c.createdAt.toISOString().slice(0, 10).split('-').reverse().join('.')}`,
    })),
    ...scans.map((x) => ({ kind: 'vuln_scan' as const, id: x.id, label: `Скан «${x.fileName}»` })),
    ...handovers.map((x) => ({ kind: 'vuln_scan' as const, id: x.id, label: `Передача ИКТ скана «${x.fileName}»` })),
    ...extensions.map((x) => ({ kind: 'vuln_extension' as const, id: x.id, label: `Обоснование ОИКТ № ${x.basisNumber}` })),
    ...letterExports.map((x) => ({ kind: 'awareness_letter' as const, id: x.letter.id, label: `Учебное письмо № ${x.letter.number}, версия ${x.version.no}: файл .eml` })),
    ...logos.map(() => ({ kind: 'awareness_layout' as const, id: '1', label: 'Логотип «Оформления писем»' })),
  ];
}

async function canRead(db: Db, a: DocAccess, f: { id: string; uploadedBy: string }, refs: Awaited<ReturnType<typeof fileRefs>>): Promise<boolean> {
  if (!refs.length) return f.uploadedBy === a.userId;
  if (a.ibWork) return true;
  for (const r of refs) {
    if ((r.kind === 'document_pdf' || r.kind === 'document_file') && r.versionId && (await versionVisible(db, a, r.versionId))) return true;
  }
  return false;
}

/** Файл, который пользователь может читать; иначе 404 (не раскрываем, что файл есть). */
async function readable(db: Db, userId: string, id: string) {
  const f = await db.file.findUnique({ where: { id }, include: withUploader });
  if (!f || f.deletedAt) throw notFound('Файл');
  const refs = await fileRefs(db, id);
  if (!(await canRead(db, await accessOf(db, userId), f, refs))) throw notFound('Файл');
  return { f, refs };
}

export async function getFileMeta(db: Db, actor: Actor, id: string) {
  const { f, refs } = await readable(db, actor.id, id);
  const text = await db.fileText.findUnique({ where: { fileId: id }, select: { status: true, pages: true } });
  return {
    ...fileDto(f),
    refs: refs.map(({ kind, id: rid, label }) => ({ kind, id: rid, label })),
    /** Текст PDF для поиска: pending — ещё не разобран; no_text — текстового слоя нет (поиск только по полям). */
    text: text ? { status: text.status as 'pending' | 'text' | 'no_text' | 'failed', pages: text.pages } : null,
  };
}

/** Открыть содержимое на чтение (с проверкой прав); выдача пишется в журнал. */
export async function openFile(db: Db, store: FileStore, actor: Actor, id: string) {
  const { f } = await readable(db, actor.id, id);
  await auditSettings(db, actor, {
    action: 'file.downloaded', entity: 'file', entityId: f.id,
    summary: `Выдан файл «${f.originalName}»`,
  });
  return { file: fileDto(f), stream: store.open(f.storageKey) };
}
