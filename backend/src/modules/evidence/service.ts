// Доказательная база (этап 7, docs/concept.md раздел 8, ADR-0011). Доказательство привязано к одному объекту —
// записи реестра, документу или системе; к нему приложены файлы; форма подтверждения хранит снимок полей
// шаблона и значений (checks). Проверка «принять / отклонить» — право evidence.review, но не своё доказательство:
// проверяющий не принимает то, что загрузил сам (или к чему сам приложил файл).
// Новый файл возвращает доказательство на проверку; отвязать файл можно только у доказательства на проверке.
import type { Prisma } from '../../generated/prisma/client.js';
import { SYSTEMS_CATALOG } from '../../lib/catalogs.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { formatDateRu } from '../../lib/register-values.js';
import { daysBetween, todayIso } from '../../lib/today.js';
import { addMonthsIso } from '../documents/status.js';
import { claimFiles, deleteIfUnreferenced, fileDto, withUploader } from '../files/links.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';
import { buildChecks, checksSummary, type CheckItem, type TemplateField } from './checks.js';
import {
  EVIDENCE_KIND_NAMES, EVIDENCE_STATE_NAMES, evidenceState, type EvidenceKind, type EvidenceState,
} from './status.js';
import { closeEvidenceTasks, evidenceTask } from './tasks.js';

export const TITLE_MAX = 300;
export const CONFIRMED_MAX = 300;
export const COMMENT_MAX = 4000;
export const MAX_FILES = 20;
export const LIST_LIMIT = 500;
/** Срок задачи «Исправить и загрузить заново» (как в прототипе). */
export const REJECT_TASK_DAYS = 7;

const IB_WORK = { roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } } as const;

export type ObjectType = 'record' | 'document' | 'system';
export interface ObjectRef { type: ObjectType; id: string }

const include = {
  template: { select: { id: true, name: true, basis: true } },
  owner: { select: { id: true, fullName: true } },
  uploader: { select: { id: true, fullName: true } },
  reviewer: { select: { id: true, fullName: true } },
  decision: { select: { id: true, documentTitle: true, documentNumber: true, documentDate: true, reviewDue: true, option: { select: { label: true } } } },
  // Уже приложенные одним запросом (одинаковое added_at) — по времени загрузки: форма загружает по одному, по порядку.
  files: { where: { removedAt: null }, orderBy: [{ addedAt: 'asc' }, { file: { uploadedAt: 'asc' } }, { fileId: 'asc' }], include: { file: { include: withUploader } } },
} satisfies Prisma.EvidenceInclude;
type Row = Prisma.EvidenceGetPayload<{ include: typeof include }>;

const isoDay = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const dayDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

// ---------------------------------------------------------------- объекты

const objectOf = (r: { recordId: string | null; documentId: string | null; systemItemId: string | null }): ObjectRef =>
  r.recordId ? { type: 'record', id: r.recordId } : r.documentId ? { type: 'document', id: r.documentId } : { type: 'system', id: r.systemItemId as string };

interface ObjectInfo { type: ObjectType; id: string; label: string; registerId: string | null; exists: boolean }

/** Подписи объектов по текущим названиям: переименование записи, документа или системы видно сразу. */
async function objectInfos(db: Db, refs: readonly ObjectRef[]): Promise<Map<string, ObjectInfo>> {
  const out = new Map<string, ObjectInfo>();
  const ids = (t: ObjectType) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
  const recIds = ids('record');
  if (recIds.length) {
    const recs = await db.registerRecord.findMany({
      where: { id: { in: recIds } },
      select: { id: true, number: true, values: true, registerId: true, deletedAt: true, register: { select: { name: true } } },
    });
    const titles = await db.registerField.findMany({
      where: { registerId: { in: [...new Set(recs.map((r) => r.registerId))] }, isTitle: true, deletedAt: null },
      select: { id: true, registerId: true },
    });
    for (const r of recs) {
      const tf = titles.find((t) => t.registerId === r.registerId);
      const title = tf ? (r.values as Record<string, unknown>)[tf.id] : undefined;
      out.set(`record:${r.id}`, {
        type: 'record', id: r.id, registerId: r.registerId, exists: r.deletedAt === null,
        label: `${r.register.name}, запись #${r.number}${typeof title === 'string' && title ? ` «${title}»` : ''}`,
      });
    }
  }
  const docIds = ids('document');
  if (docIds.length) {
    const docs = await db.document.findMany({
      where: { id: { in: docIds } },
      select: { id: true, number: true, approvedVersion: { select: { title: true } }, workingVersion: { select: { title: true } } },
    });
    for (const d of docs) {
      out.set(`document:${d.id}`, {
        type: 'document', id: d.id, registerId: null, exists: true,
        label: `Документ #${d.number} «${(d.approvedVersion ?? d.workingVersion)?.title ?? ''}»`,
      });
    }
  }
  const sysIds = ids('system');
  if (sysIds.length) {
    const items = await db.catalogItem.findMany({ where: { id: { in: sysIds } }, select: { id: true, value: true, deletedAt: true } });
    for (const i of items) out.set(`system:${i.id}`, { type: 'system', id: i.id, registerId: null, exists: i.deletedAt === null, label: `Система «${i.value}»` });
  }
  return out;
}

/** Объект для нового доказательства: существует, не удалён и не в архиве. */
async function checkObject(db: Db, ref: ObjectRef): Promise<void> {
  if (ref.type === 'record') {
    const r = await db.registerRecord.findFirst({ where: { id: ref.id, deletedAt: null }, select: { archivedAt: true, register: { select: { archivedAt: true } } } });
    if (!r) throw badRequest('BAD_OBJECT', 'Нет такой записи реестра');
    if (r.archivedAt || r.register.archivedAt) throw badRequest('BAD_OBJECT', 'Запись или реестр в архиве');
  } else if (ref.type === 'document') {
    const d = await db.document.findUnique({ where: { id: ref.id }, select: { archivedAt: true } });
    if (!d) throw badRequest('BAD_OBJECT', 'Нет такого документа');
    if (d.archivedAt) throw badRequest('BAD_OBJECT', 'Документ в архиве');
  } else {
    const i = await db.catalogItem.findFirst({ where: { id: ref.id, catalogCode: SYSTEMS_CATALOG, deletedAt: null }, select: { archivedAt: true, value: true } });
    if (!i) throw badRequest('BAD_OBJECT', 'Нет такой системы в справочнике «Системы»');
    if (i.archivedAt) throw badRequest('BAD_OBJECT', `Система «${i.value}» в архиве`);
  }
}

const objectData = (ref: ObjectRef) => ({
  recordId: ref.type === 'record' ? ref.id : null,
  documentId: ref.type === 'document' ? ref.id : null,
  systemItemId: ref.type === 'system' ? ref.id : null,
});

// ---------------------------------------------------------------- ответы

function toItem(e: Row, objects: Map<string, ObjectInfo>, today: string) {
  const ref = objectOf(e);
  const obj = objects.get(`${ref.type}:${ref.id}`);
  const state = evidenceState(e.status, isoDay(e.validUntil), today);
  const validUntil = isoDay(e.validUntil);
  return {
    id: e.id,
    number: e.number,
    kind: e.kind as EvidenceKind,
    kindName: EVIDENCE_KIND_NAMES[e.kind as EvidenceKind] ?? e.kind,
    title: e.title,
    object: { type: ref.type, id: ref.id, label: obj?.label ?? '—', registerId: obj?.registerId ?? null },
    template: e.template ? { id: e.template.id, name: e.template.name } : null,
    result: checksSummary(e.checks as CheckItem[] | null),
    files: e.files.map((l) => ({ id: l.file.id, name: l.file.originalName, mime: l.file.mime })),
    uploadedBy: e.uploader,
    owner: e.owner,
    confirmedBy: e.confirmedBy,
    createdAt: e.createdAt.toISOString(),
    validUntil,
    daysLeft: validUntil && e.status === 'accepted' ? daysBetween(today, validUntil) : null,
    status: e.status as 'pending' | 'accepted' | 'rejected',
    state,
    stateName: EVIDENCE_STATE_NAMES[state],
    archived: e.archivedAt !== null,
    version: e.version,
  };
}
export type EvidenceItem = ReturnType<typeof toItem>;

// ---------------------------------------------------------------- реестр

export interface ListQuery {
  archived: boolean;
  state?: EvidenceState;
  kind?: EvidenceKind;
  templateId?: string;
  object?: ObjectRef;
  q?: string;
  limit: number;
  cursor?: string;
}

const ORDER: Record<EvidenceState, number> = { pending: 0, expired: 1, expiring: 2, rejected: 3, accepted: 4 };

export async function listEvidence(db: Db, q: ListQuery) {
  const today = todayIso();
  const rows = await db.evidence.findMany({
    where: {
      deletedAt: null,
      archivedAt: q.archived ? { not: null } : null,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.templateId ? { templateId: q.templateId } : {}),
      ...(q.object ? objectData(q.object) : {}),
    },
    include,
    orderBy: { number: 'desc' },
  });
  const objects = await objectInfos(db, rows.map(objectOf));
  const needle = q.q?.trim().toLowerCase();
  const items = rows
    .map((e) => toItem(e, objects, today))
    .filter((x) => (!q.state || x.state === q.state)
      && (!needle || `${x.title} ${x.object.label} ${x.files.map((f) => f.name).join(' ')}`.toLowerCase().includes(needle)))
    // Сначала то, что требует внимания: на проверке, истекло, истекает.
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.number - a.number);
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const counts = Object.fromEntries(Object.keys(EVIDENCE_STATE_NAMES).map((s) => [s, 0])) as Record<EvidenceState, number>;
  for (const x of items) counts[x.state]++;
  return {
    items: items.slice(offset, offset + q.limit),
    nextCursor: items.length > offset + q.limit ? String(offset + q.limit) : null,
    total: items.length,
    counts,
  };
}

/** Счётчики у пункта меню и на мониторинге. */
export async function evidenceSummary(db: Db) {
  const today = todayIso();
  const rows = await db.evidence.findMany({ where: { deletedAt: null, archivedAt: null }, select: { status: true, validUntil: true } });
  const counts = { pending: 0, expiring: 0, expired: 0 };
  for (const r of rows) {
    const s = evidenceState(r.status, isoDay(r.validUntil), today);
    if (s === 'pending' || s === 'expiring' || s === 'expired') counts[s]++;
  }
  return counts;
}

// ---------------------------------------------------------------- карточка

async function getRow(db: Db, id: string): Promise<Row> {
  const e = await db.evidence.findFirst({ where: { id, deletedAt: null }, include });
  if (!e) throw notFound('Доказательство');
  return e;
}

/** Проверяющий не принимает своё: загрузил доказательство или приложил к нему действующий файл. */
function ownWork(e: Row, userId: string): boolean {
  return e.uploadedBy === userId || e.files.some((l) => l.addedBy === userId);
}

export async function getEvidence(db: Db, actor: { id: string; perms: ReadonlySet<string> }, id: string) {
  const today = todayIso();
  const e = await getRow(db, id);
  const objects = await objectInfos(db, [objectOf(e)]);
  // История — по праву «История в карточках» (релиз 1.2.0, ADR-0021); без права список пуст.
  const history = !actor.perms.has('history.view') ? [] : await db.auditLog.findMany({
    where: { entity: 'evidence', entityId: id },
    include: { user: { select: { fullName: true } } },
    orderBy: { id: 'desc' },
    take: 200,
  });
  const reviewer = actor.perms.has('evidence.review');
  const own = ownWork(e, actor.id);
  const active = e.archivedAt === null;
  return {
    ...toItem(e, objects, today),
    basis: e.template?.basis ?? '',
    checks: (e.checks as CheckItem[] | null) ?? null,
    fileList: e.files.map((l) => ({ ...fileDto(l.file), addedAt: l.addedAt.toISOString(), addedBy: l.addedBy })),
    decision: e.decision ? {
      label: e.decision.option.label,
      documentTitle: e.decision.documentTitle,
      documentNumber: e.decision.documentNumber,
      documentDate: isoDay(e.decision.documentDate) as string,
      reviewDue: isoDay(e.decision.reviewDue),
    } : null,
    reviewedBy: e.reviewer,
    reviewedAt: e.reviewedAt?.toISOString() ?? null,
    reviewComment: e.reviewComment,
    can: {
      review: active && e.status === 'pending' && reviewer && !own,
      addFiles: active && e.kind !== 'decision',
      removeFiles: active && e.status === 'pending' && e.files.length > 1 && (e.uploadedBy === actor.id || reviewer),
      archive: true,
    },
    /** Почему нельзя проверить (для подсказки в карточке). */
    reviewBlocked: active && e.status === 'pending' && reviewer && own
      ? 'Вы загрузили это доказательство или приложили к нему файл — проверяет другой сотрудник'
      : null,
    history: history.map((h) => ({
      id: h.id.toString(),
      at: h.at.toISOString(),
      actor: h.user?.fullName ?? 'Система',
      summary: ((h.diff ?? {}) as { summary?: string }).summary ?? h.action,
    })),
  };
}

// ---------------------------------------------------------------- проверки ввода

function cleanTitle(v: string): string {
  const t = trimmed(v);
  if (!t) throw badRequest('EMPTY_TITLE', 'Укажите, что подтверждает доказательство');
  if (t.length > TITLE_MAX) throw badRequest('TOO_LONG', `Название — не длиннее ${TITLE_MAX} символов`);
  return t;
}

async function checkOwner(db: Db, id: string): Promise<void> {
  const u = await db.user.findFirst({ where: { id, isActive: true, ...IB_WORK }, select: { id: true } });
  if (!u) throw badRequest('BAD_OWNER', 'Ответственным может быть только активный сотрудник с доступом к разделам ИБ');
}

function fileCount(ids: readonly string[]): void {
  if (!ids.length) throw badRequest('NO_FILES', 'Приложите хотя бы один файл: скриншот, выгрузку настроек или документ');
  if (ids.length > MAX_FILES) throw badRequest('TOO_MANY_FILES', `Не больше ${MAX_FILES} файлов за раз`);
}

async function audit(tx: Db, actor: Actor, id: string, action: string, summary: string, after?: Record<string, unknown>) {
  await auditSettings(tx, actor, { action: `evidence.${action}`, entity: 'evidence', entityId: id, summary, after });
}

async function linkFiles(tx: Db, actor: Actor, evidenceId: string, fileIds: readonly string[]) {
  const files = await claimFiles(tx, actor.id, fileIds);
  const existing = await tx.evidenceFile.findMany({ where: { evidenceId, fileId: { in: files.map((f) => f.id) } }, select: { fileId: true } });
  if (existing.length) throw conflict('FILE_ALREADY_ADDED', 'Этот файл уже был приложен к доказательству. Загрузите его заново');
  // Порядок — как приложил пользователь (fileIds): строки одного запроса получают added_at с шагом 1 мс, иначе у них
  // одинаковое время и порядок в карточке (и какой файл показан первым) случаен.
  const ordered = [...files].sort((a, b) => fileIds.indexOf(a.id) - fileIds.indexOf(b.id));
  const base = Date.now();
  await tx.evidenceFile.createMany({ data: ordered.map((f, i) => ({ evidenceId, fileId: f.id, addedBy: actor.id, addedAt: new Date(base + i) })) });
  return ordered;
}

// ---------------------------------------------------------------- создание

export interface CreateInput {
  kind: 'form' | 'file';
  object: ObjectRef;
  templateId?: string;
  values?: Record<string, unknown>;
  title?: string;
  confirmedBy?: string;
  /** Только у файла: «действует до»; у формы — дата загрузки + срок шаблона. */
  validUntil?: string | null;
  ownerId?: string;
  fileIds: string[];
}

export async function createEvidence(db: Db, actor: Actor, input: CreateInput): Promise<string> {
  return withTx(db, async (tx) => {
    fileCount(input.fileIds);
    await checkObject(tx, input.object);
    const ownerId = input.ownerId ?? actor.id;
    await checkOwner(tx, ownerId);
    const today = todayIso();
    const confirmedBy = trimmed(input.confirmedBy ?? '');
    if (confirmedBy.length > CONFIRMED_MAX) throw badRequest('TOO_LONG', `«Подтвердил» — не длиннее ${CONFIRMED_MAX} символов`);
    let data: Prisma.EvidenceUncheckedCreateInput;
    if (input.kind === 'form') {
      if (!input.templateId) throw badRequest('NO_TEMPLATE', 'Выберите шаблон формы');
      const t = await tx.formTemplate.findFirst({
        where: { id: input.templateId, deletedAt: null },
        include: { fields: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
      });
      if (!t) throw badRequest('NO_TEMPLATE', 'Нет такого шаблона формы');
      if (t.archivedAt) throw badRequest('NO_TEMPLATE', `Шаблон «${t.name}» в архиве`);
      if (!t.fields.length) throw badRequest('EMPTY_TEMPLATE', `В шаблоне «${t.name}» нет полей. Добавьте их в настройках`);
      if (!confirmedBy) throw badRequest('NO_CONFIRMED_BY', 'Укажите, кто подтвердил со стороны ДИКТ: ФИО и должность');
      const fields: TemplateField[] = t.fields.map((f) => ({
        id: f.id, label: f.label, checkKind: f.checkKind as TemplateField['checkKind'], threshold: f.threshold === null ? null : Number(f.threshold),
      }));
      const { checks, problems } = buildChecks(fields, input.values ?? {});
      if (problems.length) {
        throw new AppError(400, 'FORM_INCOMPLETE', `Заполните форму: ${problems.map((p) => `«${p.label}» — ${p.message}`).join('; ')}`, { problems });
      }
      const objects = await objectInfos(tx, [input.object]);
      const label = objects.get(`${input.object.type}:${input.object.id}`)?.label ?? '';
      data = {
        kind: 'form', title: input.title ? cleanTitle(input.title) : cleanTitle(`${t.name}: ${label}`.slice(0, TITLE_MAX)),
        templateId: t.id, checks: checks as unknown as Prisma.InputJsonValue,
        validUntil: dayDate(addMonthsIso(today, t.validMonths)),
        confirmedBy, ownerId, uploadedBy: actor.id, ...objectData(input.object),
      };
    } else {
      if (input.templateId || input.values) throw badRequest('BAD_KIND', 'Шаблон формы бывает только у формы подтверждения');
      const validUntil = input.validUntil ?? null;
      if (validUntil !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || validUntil < today)) {
        throw badRequest('BAD_DATE', '«Действует до» — дата не раньше сегодняшней');
      }
      data = {
        kind: 'file', title: cleanTitle(input.title ?? ''), validUntil: validUntil ? dayDate(validUntil) : null,
        confirmedBy, ownerId, uploadedBy: actor.id, ...objectData(input.object),
      };
    }
    const e = await tx.evidence.create({ data, select: { id: true, number: true, title: true } });
    const files = await linkFiles(tx, actor, e.id, input.fileIds);
    // Новая форма по тому же объекту и шаблону — задача «исправить» по отклонённой закрывается.
    if (input.kind === 'form') {
      const older = await tx.evidence.findMany({
        where: { id: { not: e.id }, templateId: input.templateId, status: 'rejected', ...objectData(input.object) },
        select: { id: true },
      });
      await closeEvidenceTasks(tx, older.map((o) => o.id), 'rejected', `Загружена новая форма — доказательство #${e.number}`);
    }
    const summary = checksSummary((data.checks ?? null) as CheckItem[] | null);
    await audit(tx, actor, e.id, 'created',
      `Доказательство #${e.number} «${e.title}» загружено${summary ? `, соответствие ${summary.passed} из ${summary.total}` : ''}; файлы: ${files.map((f) => f.originalName).join(', ')}`,
      { kind: input.kind, object: input.object, files: files.map((f) => ({ id: f.id, name: f.originalName, sha256: f.sha256 })) });
    return e.id;
  });
}

/** Доказательство из решения другого отдела: документ-основание — тот же файл; сразу «принято». */
export async function createDecisionEvidence(tx: Db, actor: Actor, input: { decisionId: string; recordId: string; fileId: string; title: string }) {
  const now = new Date();
  const e = await tx.evidence.create({
    data: {
      kind: 'decision', title: cleanTitle(input.title.slice(0, TITLE_MAX)), recordId: input.recordId, decisionId: input.decisionId,
      ownerId: actor.id, uploadedBy: actor.id, status: 'accepted', reviewedBy: actor.id, reviewedAt: now,
    },
    select: { id: true, number: true },
  });
  await tx.evidenceFile.create({ data: { evidenceId: e.id, fileId: input.fileId, addedBy: actor.id } });
  await audit(tx, actor, e.id, 'created', `Доказательство #${e.number} «${input.title}»: решение внесено с документом-основанием`, { kind: 'decision', decisionId: input.decisionId });
  return e;
}

// ---------------------------------------------------------------- проверка

export interface ReviewInput { version: number; decision: 'accept' | 'reject'; comment?: string }

export async function reviewEvidence(db: Db, actor: Actor, id: string, input: ReviewInput): Promise<void> {
  await withTx(db, async (tx) => {
    const e = await getRow(tx, id);
    if (e.version !== input.version) throw versionConflict();
    if (e.archivedAt) throw conflict('ARCHIVED', 'Доказательство в архиве');
    if (e.status !== 'pending') throw conflict('NOT_PENDING', 'Доказательство уже проверено. Обновите страницу');
    if (ownWork(e, actor.id)) {
      throw new AppError(403, 'SEPARATION_OF_DUTIES', 'Вы загрузили это доказательство или приложили к нему файл — проверяет другой сотрудник');
    }
    const comment = (input.comment ?? '').trim();
    if (comment.length > COMMENT_MAX) throw badRequest('TOO_LONG', `Комментарий — не длиннее ${COMMENT_MAX} символов`);
    if (input.decision === 'reject' && !comment) throw badRequest('EMPTY_COMMENT', 'Напишите, что не так: комментарий увидит загрузивший');
    const now = new Date();
    const status = input.decision === 'accept' ? 'accepted' : 'rejected';
    const res = await tx.evidence.updateMany({
      where: { id, version: input.version, status: 'pending' },
      data: { status, reviewedBy: actor.id, reviewedAt: now, reviewComment: comment, version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.evidence.findFirst({ where: { id, deletedAt: null } }), 'Доказательство');
    const who = (await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { fullName: true } })).fullName;
    if (status === 'accepted') {
      await closeEvidenceTasks(tx, [id], 'rejected', `Доказательство #${e.number} принято`);
      // Новая форма по тому же объекту и шаблону заменяет прежние: их задачи «обновить» закрываются.
      if (e.kind === 'form') {
        const older = await tx.evidence.findMany({
          where: { id: { not: id }, templateId: e.templateId, status: 'accepted', recordId: e.recordId, documentId: e.documentId, systemItemId: e.systemItemId },
          select: { id: true },
        });
        await closeEvidenceTasks(tx, older.map((o) => o.id), 'expiring', `Принята новая форма — доказательство #${e.number}`);
      }
      await audit(tx, actor, id, 'accepted',
        `Доказательство #${e.number} принято${e.validUntil ? `, действует до ${formatDateRu(isoDay(e.validUntil) as string)}` : ''}${comment ? `: ${comment}` : ''}`);
    } else {
      const due = new Date(`${todayIso(now)}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + REJECT_TASK_DAYS);
      const t = await evidenceTask(tx, {
        evidenceId: id, reason: 'rejected', userId: e.uploadedBy, label: 'Загрузивший доказательство',
        title: `Исправить и загрузить заново: ${e.title}`,
        description: `Доказательство #${e.number} отклонено (${who}):\n${comment}\n\nПриложите исправленный файл к доказательству или загрузите новую форму — задача закроется сама.`,
        repeatComment: `Повторно отклонено (${who}): ${comment}`,
        due: isoDay(due) as string,
      });
      await audit(tx, actor, id, 'rejected', `Доказательство #${e.number} отклонено: ${comment}. Загрузившему — задача`, { comment, taskId: t.taskId });
    }
  });
}

// ---------------------------------------------------------------- файлы

/** Добавить файлы: принятое или отклонённое доказательство снова уходит на проверку. */
export async function addEvidenceFiles(db: Db, actor: Actor, id: string, input: { version: number; fileIds: string[] }): Promise<void> {
  await withTx(db, async (tx) => {
    fileCount(input.fileIds);
    const e = await getRow(tx, id);
    if (e.version !== input.version) throw versionConflict();
    if (e.archivedAt) throw conflict('ARCHIVED', 'Доказательство в архиве. Верните его, чтобы добавить файлы');
    if (e.kind === 'decision') throw conflict('DECISION_EVIDENCE', 'Решение другого отдела меняется только новым решением с документом');
    const res = await tx.evidence.updateMany({
      where: { id, version: input.version },
      data: { status: 'pending', reviewedBy: null, reviewedAt: null, reviewComment: '', version: { increment: 1 } },
    });
    if (res.count === 0) throw versionConflict();
    const files = await linkFiles(tx, actor, id, input.fileIds);
    if (e.status === 'rejected') await closeEvidenceTasks(tx, [id], 'rejected', `К доказательству #${e.number} добавлен файл — оно снова на проверке`);
    await audit(tx, actor, id, 'files_added',
      `Доказательство #${e.number}: добавлен файл ${files.map((f) => `«${f.originalName}»`).join(', ')}${e.status !== 'pending' ? ' — снова на проверке' : ''}`,
      { files: files.map((f) => ({ id: f.id, name: f.originalName, sha256: f.sha256 })), statusBefore: e.status });
  });
}

/** Отвязать файл — только у доказательства на проверке (загрузивший или проверяющий), последний файл не убирается. */
export async function removeEvidenceFile(db: Db, actor: Actor & { perms: ReadonlySet<string> }, id: string, fileId: string, version: number): Promise<void> {
  await withTx(db, async (tx) => {
    const e = await getRow(tx, id);
    if (e.version !== version) throw versionConflict();
    if (e.archivedAt) throw conflict('ARCHIVED', 'Доказательство в архиве');
    if (e.status !== 'pending') throw conflict('NOT_PENDING', 'Файлы убираются только у доказательства на проверке: принятое и отклонённое остаются как есть');
    if (e.uploadedBy !== actor.id && !actor.perms.has('evidence.review')) {
      throw new AppError(403, 'FORBIDDEN', 'Убрать файл может загрузивший доказательство или проверяющий');
    }
    const link = e.files.find((l) => l.fileId === fileId);
    if (!link) throw notFound('Файл доказательства');
    if (e.files.length <= 1) throw conflict('LAST_FILE', 'Это единственный файл доказательства. Сначала добавьте другой');
    const res = await tx.evidence.updateMany({ where: { id, version }, data: { version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    await tx.evidenceFile.update({ where: { evidenceId_fileId: { evidenceId: id, fileId } }, data: { removedAt: new Date(), removedBy: actor.id } });
    const deleted = await deleteIfUnreferenced(tx, actor, fileId, `убран из доказательства #${e.number}`);
    await audit(tx, actor, id, 'file_removed',
      `Доказательство #${e.number}: убран файл «${link.file.originalName}»${deleted ? '' : ' (файл остаётся: на него есть другие ссылки)'}`,
      { fileId, name: link.file.originalName, sha256: link.file.sha256, fileDeleted: deleted });
  });
}

// ---------------------------------------------------------------- правка и архив

export async function updateEvidence(db: Db, actor: Actor, id: string, input: { version: number; title?: string; ownerId?: string }): Promise<void> {
  await withTx(db, async (tx) => {
    const e = await getRow(tx, id);
    if (e.version !== input.version) throw versionConflict();
    if (e.archivedAt) throw conflict('ARCHIVED', 'Доказательство в архиве. Верните его, чтобы изменить');
    const data: Prisma.EvidenceUncheckedUpdateManyInput = {};
    const changes: { label: string; from: string; to: string }[] = [];
    if (input.title !== undefined) {
      const t = cleanTitle(input.title);
      if (t !== e.title) { data.title = t; changes.push({ label: 'Название', from: e.title, to: t }); }
    }
    if (input.ownerId !== undefined && input.ownerId !== e.ownerId) {
      await checkOwner(tx, input.ownerId);
      const u = await tx.user.findUniqueOrThrow({ where: { id: input.ownerId }, select: { fullName: true } });
      data.ownerId = input.ownerId;
      changes.push({ label: 'Ответственный', from: e.owner.fullName, to: u.fullName });
    }
    if (!changes.length) return;
    const res = await tx.evidence.updateMany({ where: { id, version: input.version }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    await audit(tx, actor, id, 'updated', `Доказательство #${e.number}: ${changes.map((c) => `«${c.label}»`).join(', ')}`, { changes });
  });
}

export async function setEvidenceArchived(db: Db, actor: Actor, id: string, version: number, archived: boolean): Promise<void> {
  await withTx(db, async (tx) => {
    const e = await getRow(tx, id);
    if (e.version !== version) throw versionConflict();
    if ((e.archivedAt !== null) === archived) return;
    const res = await tx.evidence.updateMany({ where: { id, version }, data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    await audit(tx, actor, id, archived ? 'archived' : 'restored', `Доказательство #${e.number} ${archived ? 'отправлено в архив' : 'возвращено из архива'}`);
  });
}

// ---------------------------------------------------------------- покрытие

/** Покрытие систем формами шаблона: по каждой системе — последняя неотклонённая форма и её состояние. */
export async function coverage(db: Db, templateId: string) {
  const t = await db.formTemplate.findFirst({ where: { id: templateId, deletedAt: null }, select: { id: true, name: true, basis: true } });
  if (!t) throw notFound('Шаблон формы');
  const today = todayIso();
  const systems = await db.catalogItem.findMany({
    where: { catalogCode: SYSTEMS_CATALOG, deletedAt: null, archivedAt: null },
    select: { id: true, value: true },
    orderBy: [{ sortOrder: 'asc' }, { value: 'asc' }],
  });
  const forms = await db.evidence.findMany({
    where: { templateId, deletedAt: null, archivedAt: null, status: { not: 'rejected' }, systemItemId: { in: systems.map((s) => s.id) } },
    select: { id: true, number: true, systemItemId: true, status: true, validUntil: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return {
    template: t,
    items: systems.map((s) => {
      const e = forms.find((f) => f.systemItemId === s.id);
      const state = e ? evidenceState(e.status, isoDay(e.validUntil), today) : null;
      return {
        system: s,
        evidenceId: e?.id ?? null,
        number: e?.number ?? null,
        state,
        stateName: state ? EVIDENCE_STATE_NAMES[state] : 'Нет формы',
        validUntil: e ? isoDay(e.validUntil) : null,
      };
    }),
  };
}

export { objectOf };
