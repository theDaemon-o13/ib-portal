// Этап 15 «Перевод» (релиз 1.2.0, этап Г4, ADR-0024). Языки с переводчиком — пользователем портала (решение
// владельца 3) — и сроком ведут автор, старшие над автором и начальник ИБ на этапах 11–15. Перевод готов, когда
// приложен файл (pdf или docx): прикладывает переводчик или тот, кто ведёт языки, на этапе 15. Срок меняется только
// с комментарием — в общую историю сроков. 15 → 16 — когда у каждого языка есть файл (service.ts, gate).
import { isUniqueViolation, withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { MIME_BY_EXT } from '../../lib/file-type.js';
import { KIOSK_PERMISSION } from '../../lib/permissions.js';
import { formatDateRu } from '../../lib/register-values.js';
import { claimFiles, deleteIfUnreferenced } from '../files/links.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { notifyDeadlineChanged } from './notify.js';
import { cleanComment, forbiddenWith, notifyWaiting, rolesOf, routeContext } from './service.js';
import { stageName } from './status.js';

export const LANGUAGE_MAX = 100;
const TRANSLATION_STAGES = [11, 12, 13, 14, 15];
const UPLOAD_STAGE = 15;
const TRANSLATION_MIME = [MIME_BY_EXT.pdf, MIME_BY_EXT.docx];

type Stage = { version: number; stage: number };

function cleanDate(v: string): Date {
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw badRequest('BAD_DATE', 'Укажите срок перевода');
  return d;
}

function cleanLanguage(v: string): string {
  const t = trimmed(v);
  if (!t) throw badRequest('EMPTY', 'Укажите язык');
  if (t.length > LANGUAGE_MAX) throw badRequest('TOO_LONG', `Язык — не длиннее ${LANGUAGE_MAX} символов`);
  return t;
}

/** Переводчик — активный пользователь портала, не учётная запись настенного монитора. */
async function checkTranslator(db: Db, id: string) {
  const u = await db.user.findFirst({
    where: { id, isActive: true, roles: { none: { role: { permissions: { some: { permissionCode: KIOSK_PERMISSION } } } } } },
    select: { id: true, fullName: true },
  });
  if (!u) throw badRequest('BAD_TRANSLATOR', 'Переводчик — активный пользователь портала');
  return u;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Языки ведут автор, старшие над автором и начальник ИБ, на этапах 11–15. */
async function managerContext(tx: Db, actor: Actor, id: string, input: Stage) {
  const ctx = await routeContext(tx, actor, id, input);
  const roles = rolesOf(ctx.who, ctx.d);
  if (!roles.has('author') && !roles.has('senior') && !roles.has('head')) {
    throw forbiddenWith('FORBIDDEN', 'Переводы ведут автор документа, старшие над автором и начальник ИБ');
  }
  if (!TRANSLATION_STAGES.includes(ctx.w.stage)) throw conflict('WRONG_STAGE', `Переводы ведут до этапа «${stageName(UPLOAD_STAGE)}» включительно`);
  return ctx;
}

async function getTranslation(tx: Db, versionId: string, translationId: string) {
  const t = await tx.documentTranslation.findFirst({ where: { id: translationId, versionId, removedAt: null }, include: { translator: { select: { fullName: true } } } });
  if (!t) throw notFound('Перевод');
  return t;
}

async function createTranslation(tx: Db, data: { documentId: string; versionId: string; language: string; translatorId: string; dueDate: Date; addedBy: string }) {
  try {
    return await withTx(tx, (t) => t.documentTranslation.create({ data }));
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('DUPLICATE', `Язык «${data.language}» уже есть`);
    throw err;
  }
}

export async function addTranslation(db: Db, actor: Actor, id: string, input: Stage & { language: string; translatorId: string; dueDate: string }) {
  return withTx(db, async (tx) => {
    const { d, w } = await managerContext(tx, actor, id, input);
    const language = cleanLanguage(input.language);
    const due = cleanDate(input.dueDate);
    const translator = await checkTranslator(tx, input.translatorId);
    const t = await createTranslation(tx, { documentId: id, versionId: w.id, language, translatorId: translator.id, dueDate: due, addedBy: actor.id });
    await auditSettings(tx, actor, {
      action: 'document.translation_added', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: перевод на ${language} — ${translator.fullName}, срок ${formatDateRu(iso(due))}`,
      after: { translationId: t.id, language, translatorId: translator.id, dueDate: iso(due) },
    });
    // Язык добавили уже на этапе 15 — «ждёт вас» по stageHolders (один раз на состояние).
    if (w.stage === UPLOAD_STAGE) await notifyWaiting(tx, id, actor.id);
  });
}

/** Правка языка: переводчик, язык, срок (смена срока — только с комментарием, в историю сроков). */
export async function updateTranslation(db: Db, actor: Actor, id: string, translationId: string,
  input: Stage & { language?: string; translatorId?: string; dueDate?: string; comment?: string }) {
  return withTx(db, async (tx) => {
    const { d, w } = await managerContext(tx, actor, id, input);
    const t = await getTranslation(tx, w.id, translationId);
    const data: { language?: string; translatorId?: string; dueDate?: Date } = {};
    const changes: { label: string; from: string; to: string }[] = [];
    if (input.language !== undefined) {
      const v = cleanLanguage(input.language);
      if (v !== t.language) { data.language = v; changes.push({ label: 'Язык', from: t.language, to: v }); }
    }
    if (input.translatorId !== undefined && input.translatorId !== t.translatorId) {
      const u = await checkTranslator(tx, input.translatorId);
      data.translatorId = u.id;
      changes.push({ label: 'Переводчик', from: t.translator.fullName, to: u.fullName });
    }
    if (input.dueDate !== undefined) {
      const due = cleanDate(input.dueDate);
      if (iso(due) !== iso(t.dueDate)) {
        const comment = cleanComment(input.comment, 'Напишите, почему меняется срок');
        data.dueDate = due;
        changes.push({ label: 'Срок', from: formatDateRu(iso(t.dueDate)), to: formatDateRu(iso(due)) });
        await tx.documentDeadlineChange.create({ data: { documentId: id, translationId, fromDate: t.dueDate, toDate: due, comment, actorId: actor.id } });
        await notifyDeadlineChanged(tx, { id, number: d.number, title: w.title, ownerId: d.ownerId }, `перевода на ${t.language}`,
          [data.translatorId ?? t.translatorId], iso(t.dueDate), iso(due), comment, actor.id);
      }
    }
    if (!changes.length) return;
    try {
      await withTx(tx, (x) => x.documentTranslation.update({ where: { id: translationId }, data }));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE', `Язык «${data.language ?? t.language}» уже есть`);
      throw err;
    }
    await auditSettings(tx, actor, {
      action: 'document.translation_updated', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: перевод на ${t.language} — ${changes.map((c) => `«${c.label}»`).join(', ')}`,
      after: { translationId, changes, comment: input.comment?.trim() ?? '' },
    });
    // Новый переводчик на этапе 15 — «ждёт вас» по stageHolders (новому — один раз).
    if (data.translatorId && w.stage === UPLOAD_STAGE) await notifyWaiting(tx, id, actor.id);
  });
}

/** Снять язык, у которого нет файла перевода (ошибка в списке). Строка остаётся с отметкой «снят». */
export async function removeTranslation(db: Db, actor: Actor, id: string, translationId: string, input: Stage) {
  return withTx(db, async (tx) => {
    const { d, w } = await managerContext(tx, actor, id, input);
    const t = await getTranslation(tx, w.id, translationId);
    if (await tx.documentFile.count({ where: { translationId, removedAt: null } })) {
      throw conflict('HAS_FILES', `У перевода на ${t.language} есть файл: сначала снимите его`);
    }
    await tx.documentTranslation.update({ where: { id: translationId }, data: { removedAt: new Date(), removedBy: actor.id } });
    await auditSettings(tx, actor, {
      action: 'document.translation_removed', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: снят перевод на ${t.language}`,
      after: { translationId },
    });
    if (w.stage === UPLOAD_STAGE) await notifyWaiting(tx, id, actor.id);
  });
}

/** Файл перевода (этап 15): переводчик языка или тот, кто ведёт языки. */
async function uploadContext(tx: Db, actor: Actor, id: string, translationId: string, input: Stage) {
  const ctx = await routeContext(tx, actor, id, input);
  if (ctx.w.stage !== UPLOAD_STAGE) throw conflict('WRONG_STAGE', `Файлы перевода прикладываются на этапе «${stageName(UPLOAD_STAGE)}»`);
  const t = await getTranslation(tx, ctx.w.id, translationId);
  const roles = rolesOf(ctx.who, ctx.d);
  if (t.translatorId !== actor.id && !roles.has('author') && !roles.has('senior') && !roles.has('head')) {
    throw forbiddenWith('FORBIDDEN', `Перевод на ${t.language} прикладывает переводчик (${t.translator.fullName}), автор или начальник ИБ`);
  }
  return { ...ctx, t };
}

export async function addTranslationFiles(db: Db, actor: Actor, id: string, translationId: string, input: Stage & { fileIds: string[] }) {
  return withTx(db, async (tx) => {
    const { d, w, t } = await uploadContext(tx, actor, id, translationId, input);
    const files = await claimFiles(tx, actor.id, input.fileIds, { mimes: TRANSLATION_MIME, what: 'Перевод' });
    if (!files.length) throw badRequest('FILE_REQUIRED', 'Выберите файл перевода');
    await tx.documentFile.createMany({ data: files.map((f) => ({ documentId: id, versionId: w.id, round: w.round, kind: 'translation', translationId, fileId: f.id, addedBy: actor.id })) });
    await auditSettings(tx, actor, {
      action: 'document.files_added', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: перевод на ${t.language} — ${files.map((f) => `«${f.originalName}»`).join(', ')}`,
      after: { translationId, files: files.map((f) => ({ id: f.id, name: f.originalName, sha256: f.sha256 })) },
    });
    await notifyWaiting(tx, id, actor.id);
  });
}

export async function removeTranslationFile(db: Db, actor: Actor, id: string, translationId: string, linkId: string, input: Stage) {
  return withTx(db, async (tx) => {
    const { d, w, t } = await uploadContext(tx, actor, id, translationId, input);
    const link = await tx.documentFile.findFirst({ where: { id: linkId, translationId, removedAt: null }, include: { file: { select: { originalName: true } } } });
    if (!link) throw notFound('Файл перевода');
    await tx.documentFile.update({ where: { id: link.id }, data: { removedAt: new Date(), removedBy: actor.id } });
    await deleteIfUnreferenced(tx, actor, link.fileId, `снят с перевода документа #${d.number}`);
    await auditSettings(tx, actor, {
      action: 'document.file_removed', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: снят файл перевода на ${t.language} «${link.file.originalName}»`,
      after: { translationId, fileId: link.fileId },
    });
  });
}
