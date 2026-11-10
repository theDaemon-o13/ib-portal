// Этап 23 «Перевод» (маршрут 1.11.0, ADR-0042; до него — этап 15). Строка перевода — язык, имя переводчика текстом
// (необязательно: переводчик не пользователь портала), срок и ссылка на перевод в OnlyOffice вместо файла. Раздел
// и строки — только на этапе 23 (замечание владельца 05.11.2026), ведёт автор. Срок меняется только с комментарием —
// в общую историю сроков. Язык (1.13.7) — только из списка lib/languages.ts: в базу пишется название («Таджикский»),
// старые строки с языком текстом не меняются; дубль проверяется по коду, старые строки — по псевдонимам (без записи).
// 23 → 24 — когда у каждого языка есть ссылка (service.ts, gate). Файлы перевода (Word —
// обязательно, PDF — по желанию) — на этапе 24 (service.ts, setApprovalFile). translator_id — тот, кто добавил строку.
import { isUniqueViolation, withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { languageByCode, languageCodeOf, type LanguageCode } from '../../lib/languages.js';
import { formatDateRu } from '../../lib/register-values.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { notifyDeadlineChanged } from './notify.js';
import { cleanComment, filesOnlyAtApproval, forbiddenWith, rolesOf, routeContext, syncStageTasks, type DocPolicy } from './service.js';
import { isDocUrl, TRANSLATION_STAGE } from './status.js';

export const LANGUAGE_MAX = 100;
const URL_MAX = 2000;

type Stage = { version: number; stage: number };

function cleanDate(v: string): Date {
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw badRequest('BAD_DATE', 'Укажите срок перевода');
  return d;
}

/**
 * Язык уже есть в версии: строка с тем же кодом — новая («Таджикский») или старая, где язык введён текстом и
 * сопоставляется по псевдонимам («таджикский», «TJ»). Снятые не считаются. Без записи в базу.
 */
async function assertLanguageFree(tx: Db, versionId: string, code: LanguageCode, exceptId?: string) {
  const rows = await tx.documentTranslation.findMany({ where: { versionId, removedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { language: true } });
  const taken = rows.find((r) => languageCodeOf(r.language) === code);
  if (taken) {
    const name = languageByCode(code).name;
    throw conflict('DUPLICATE', `Язык «${name}» уже есть${taken.language !== name ? ` (строка «${taken.language}»)` : ''}`);
  }
}

export const TRANSLATOR_NAME_MAX = 200;

/** Имя переводчика — необязательный текст (1.4.0). */
function cleanTranslatorName(v: string | undefined): string {
  const t = trimmed(v ?? '');
  if (t.length > TRANSLATOR_NAME_MAX) throw badRequest('TOO_LONG', `Имя переводчика — не длиннее ${TRANSLATOR_NAME_MAX} символов`);
  return t;
}
const nameOrDash = (v: string) => v || '—';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Языки ведёт автор, только на этапе 23 «Перевод». */
async function managerContext(tx: Db, actor: Actor, id: string, input: Stage) {
  const ctx = await routeContext(tx, actor, id, input);
  if (!rolesOf(ctx.who, ctx.d).has('author')) {
    throw forbiddenWith('FORBIDDEN', 'Переводы ведёт автор документа (владелец или «Документы: управление»)');
  }
  if (ctx.w.stage !== TRANSLATION_STAGE) throw conflict('WRONG_STAGE', 'Переводы ведут на этапе «Перевод»');
  return ctx;
}

/** Ссылка на перевод — как ссылка документа: http(s), с ONLYOFFICE_URL_PREFIX — тот же сервер (ADR-0010). */
function cleanUrl(v: string, policy: DocPolicy): string {
  const t = v.trim();
  if (!t) return '';
  if (t.length > URL_MAX || !isDocUrl(t, policy.urlPrefix ?? '')) {
    throw badRequest('BAD_URL', policy.urlPrefix ? `Ссылка на перевод — на сервер OnlyOffice банка (${policy.urlPrefix}…)` : 'Ссылка на перевод — адрес http:// или https:// без пробелов');
  }
  return t;
}

async function getTranslation(tx: Db, versionId: string, translationId: string) {
  const t = await tx.documentTranslation.findFirst({ where: { id: translationId, versionId, removedAt: null } });
  if (!t) throw notFound('Перевод');
  return t;
}

async function createTranslation(tx: Db, data: { documentId: string; versionId: string; language: string; translatorId: string; translatorName: string; dueDate: Date; addedBy: string; onlyofficeUrl: string }) {
  try {
    return await withTx(tx, (t) => t.documentTranslation.create({ data }));
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('DUPLICATE', `Язык «${data.language}» уже есть`);
    throw err;
  }
}

export async function addTranslation(db: Db, actor: Actor, id: string, input: Stage & { code: LanguageCode; translatorName?: string; dueDate: string; onlyofficeUrl?: string }, policy: DocPolicy = {}) {
  return withTx(db, async (tx) => {
    const { d, w } = await managerContext(tx, actor, id, input);
    const language = languageByCode(input.code).name;
    await assertLanguageFree(tx, w.id, input.code);
    const due = cleanDate(input.dueDate);
    const translatorName = cleanTranslatorName(input.translatorName);
    const onlyofficeUrl = cleanUrl(input.onlyofficeUrl ?? '', policy);
    // translator_id — тот, кто добавил строку (решение владельца 9): переводчик не пользователь портала.
    const t = await createTranslation(tx, { documentId: id, versionId: w.id, language, translatorId: actor.id, translatorName, dueDate: due, addedBy: actor.id, onlyofficeUrl });
    await auditSettings(tx, actor, {
      action: 'document.translation_added', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: перевод на ${language}${translatorName ? ` — ${translatorName}` : ''}, срок ${formatDateRu(iso(due))}`,
      after: { translationId: t.id, language, code: input.code, translatorName, dueDate: iso(due) },
    });
    await syncStageTasks(tx, id);
  });
}

/**
 * Правка строки: язык (только выбором из списка; code не передан — язык строки не меняется, в том числе старый текст),
 * имя переводчика, срок (смена срока — только с комментарием, в историю сроков).
 */
export async function updateTranslation(db: Db, actor: Actor, id: string, translationId: string,
  input: Stage & { code?: LanguageCode; translatorName?: string; dueDate?: string; comment?: string; onlyofficeUrl?: string }, policy: DocPolicy = {}) {
  return withTx(db, async (tx) => {
    const { d, w } = await managerContext(tx, actor, id, input);
    const t = await getTranslation(tx, w.id, translationId);
    const data: { language?: string; translatorName?: string; dueDate?: Date; onlyofficeUrl?: string } = {};
    if (input.onlyofficeUrl !== undefined) {
      const v = cleanUrl(input.onlyofficeUrl, policy);
      if (v !== t.onlyofficeUrl) { data.onlyofficeUrl = v; }
    }
    const changes: { label: string; from: string; to: string }[] = [];
    if (input.code !== undefined) {
      const v = languageByCode(input.code).name;
      if (v !== t.language) {
        await assertLanguageFree(tx, w.id, input.code, t.id);
        data.language = v;
        changes.push({ label: 'Язык', from: t.language, to: v });
      }
    }
    if (input.translatorName !== undefined) {
      const v = cleanTranslatorName(input.translatorName);
      if (v !== t.translatorName) { data.translatorName = v; changes.push({ label: 'Переводчик', from: nameOrDash(t.translatorName), to: nameOrDash(v) }); }
    }
    if (input.dueDate !== undefined) {
      const due = cleanDate(input.dueDate);
      if (iso(due) !== iso(t.dueDate)) {
        const comment = cleanComment(input.comment, 'Напишите, почему меняется срок');
        data.dueDate = due;
        changes.push({ label: 'Срок', from: formatDateRu(iso(t.dueDate)), to: formatDateRu(iso(due)) });
        await tx.documentDeadlineChange.create({ data: { documentId: id, translationId, fromDate: t.dueDate, toDate: due, comment, actorId: actor.id } });
        // Переводчик не пользователь портала — уведомление только автору.
        await notifyDeadlineChanged(tx, { id, number: d.number, title: w.title, ownerId: d.ownerId }, `перевода на ${t.language}`,
          [], iso(t.dueDate), iso(due), comment, actor.id);
      }
    }
    if (data.onlyofficeUrl !== undefined) changes.push({ label: 'Ссылка на перевод', from: t.onlyofficeUrl || '—', to: data.onlyofficeUrl || '—' });
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
    await syncStageTasks(tx, id);
  });
}

/** Снять строку перевода — на этапе 23: строка остаётся в базе с отметкой «снят», в проверке 23 → 24 не участвует. */
export async function removeTranslation(db: Db, actor: Actor, id: string, translationId: string, input: Stage) {
  return withTx(db, async (tx) => {
    const { d, w } = await managerContext(tx, actor, id, input);
    const t = await getTranslation(tx, w.id, translationId);
    await tx.documentTranslation.update({ where: { id: translationId }, data: { removedAt: new Date(), removedBy: actor.id } });
    await auditSettings(tx, actor, {
      action: 'document.translation_removed', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: снят перевод на ${t.language}`,
      after: { translationId },
    });
    await syncStageTasks(tx, id);
  });
}

/** Файлы перевода через этот маршрут — до 1.11.0; с 1.11.0 Word и PDF перевода — на этапе 24 (setApprovalFile), здесь — 409. */
export async function addTranslationFiles(db: Db, actor: Actor, id: string, _translationId: string, input: Stage & { fileIds: string[] }) {
  return withTx(db, async (tx) => {
    await routeContext(tx, actor, id, input);
    throw filesOnlyAtApproval();
  });
}

export async function removeTranslationFile(db: Db, actor: Actor, id: string, _translationId: string, _linkId: string, input: Stage) {
  return withTx(db, async (tx) => {
    await routeContext(tx, actor, id, input);
    throw filesOnlyAtApproval();
  });
}
