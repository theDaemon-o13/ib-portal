// Документы (этап 6, ADR-0010): реестр внутренних документов ИБ, версии, маршрут согласования, пересмотр.
// Права: маршруты пускают любого вошедшего (requireAuth), а кто что может — решает этот сервис:
// этап «Автор» — владелец или docs.manage; этапы 1–3 — право этапа (docs.approve.*), но не владелец документа,
// не супер-администратор (ни через какую роль) и не тот, кто уже согласовал другой этап этой версии
// (разделение полномочий). Этап, который некому согласовать, кроме владельца, пропускается с записью в истории.
// Без ib.work видны только утверждённые документы, «ждёт вас» и согласованные вами в текущем круге.
// Итоговый PDF (этап 7): автор прикладывает его при отправке на согласование, все этапы согласуют этот файл
// (sha256 — в истории каждого решения); замена PDF в маршруте возвращает его к началу.
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { DOCUMENT_TYPES_CATALOG } from '../../lib/catalogs.js';
import { withTx, isUniqueViolation, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { formatDateRu } from '../../lib/register-values.js';
import { claimFiles, deleteIfUnreferenced } from '../files/links.js';
import { todayIso } from '../../lib/today.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { closeDocumentTasks, documentTask } from './tasks.js';
import {
  addMonthsIso, DEFAULT_REVIEW_MONTHS, docStatus, isDocUrl, LAST_STAGE, needsReview, STAGES, stageName, DOC_STATUS_NAMES,
  type DocStatus,
} from './status.js';

export const TITLE_MAX = 300;
export const EDITION_MAX = 20;
export const NOTE_MAX = 4000;
export const COMMENT_MAX = 4000;
export const URL_MAX = 2000;
export const LIST_LIMIT = 500;

const IB_WORK = { roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } } as const;

// ---------------------------------------------------------------- кто что может

export interface DocAccess {
  userId: string;
  perms: ReadonlySet<string>;
  /** Есть роль «Супер-администратор» (в сумме с любыми другими ролями). */
  superAdmin: boolean;
  ibWork: boolean;
  manage: boolean;
}

/** Права читаются из БД в той же транзакции, что и действие: снятая минуту назад роль уже не действует. */
export async function accessOf(db: Db, userId: string): Promise<DocAccess> {
  const links = await db.userRole.findMany({
    where: { userId, user: { isActive: true } },
    select: { role: { select: { code: true, permissions: { select: { permissionCode: true } } } } },
  });
  const perms = new Set(links.flatMap((l) => l.role.permissions.map((p) => p.permissionCode)));
  return {
    userId,
    perms,
    superAdmin: links.some((l) => l.role.code === 'super_admin'),
    ibWork: perms.has('ib.work'),
    manage: perms.has('docs.manage'),
  };
}

/**
 * Взгляд отдела ИБ на реестр документов (дашборд и мониторинг, этап 8): все неархивные документы,
 * без «моих» согласований. Пользователь-заглушка: результат одинаков для всех, кому он виден, и кэшируется.
 */
export const DEPARTMENT_VIEW: DocAccess = {
  userId: '00000000-0000-0000-0000-000000000000', perms: new Set(['ib.work']), superAdmin: false, ibWork: true, manage: false,
};

const permName = (code: string) => PERMISSIONS.find((p) => p.code === code)?.name ?? code;

const versionSelect = {
  id: true, no: true, edition: true, title: true, onlyofficeUrl: true, changeNote: true, stage: true, round: true,
  approvedAt: true, createdAt: true, pdfFileId: true,
  pdf: { select: { id: true, originalName: true, sha256: true, size: true } },
} as const;
const docInclude = {
  type: { select: { id: true, value: true } },
  owner: { select: { id: true, fullName: true } },
  approvedVersion: { select: versionSelect },
  workingVersion: { select: versionSelect },
} as const;
type DocRow = Prisma.DocumentGetPayload<{ include: typeof docInclude }>;
type VersionRow = NonNullable<DocRow['workingVersion']>;

/** Мои решения по рабочим версиям: «согласовано мной в текущем круге» и разделение полномочий. */
type MyDecisions = Map<string, { stage: number; round: number }[]>;

async function myDecisions(db: Db, userId: string, versionIds: string[]): Promise<MyDecisions> {
  const map: MyDecisions = new Map();
  if (!versionIds.length) return map;
  const rows = await db.documentApproval.findMany({
    where: { actorId: userId, versionId: { in: versionIds }, decision: { in: ['submitted', 'approved'] } },
    select: { versionId: true, stage: true, round: true },
  });
  for (const r of rows) map.set(r.versionId, [...(map.get(r.versionId) ?? []), { stage: r.stage, round: r.round }]);
  return map;
}

type Verdict = { ok: true } | { ok: false; code: string; reason: string };

/** Может ли пользователь действовать на текущем этапе рабочей версии (отправить, согласовать, вернуть). */
function verdict(a: DocAccess, d: DocRow, mine: MyDecisions): Verdict {
  const w = d.workingVersion;
  if (!w) return { ok: false, code: 'NOT_IN_ROUTE', reason: 'Документ не на согласовании' };
  if (d.archivedAt) return { ok: false, code: 'DOC_ARCHIVED', reason: 'Документ в архиве' };
  const st = STAGES[w.stage];
  if (!st) return { ok: false, code: 'NOT_IN_ROUTE', reason: 'Неизвестный этап' };
  if (st.perm === null) {
    if (d.ownerId !== a.userId && !a.manage) {
      return { ok: false, code: 'FORBIDDEN', reason: `Этап «Автор» — владелец документа (${d.owner.fullName}) или пользователь с правом «${permName('docs.manage')}»` };
    }
  } else {
    if (!a.perms.has(st.perm)) {
      return { ok: false, code: 'FORBIDDEN', reason: `Этап «${st.name}» согласует пользователь с правом «${permName(st.perm)}»` };
    }
    if (d.ownerId === a.userId) {
      return { ok: false, code: 'SEPARATION_OF_DUTIES', reason: 'Владелец не согласует этапы своего документа, кроме «Автор»: так сохраняется разделение полномочий' };
    }
    if (a.superAdmin) {
      return { ok: false, code: 'SEPARATION_OF_DUTIES', reason: 'Супер-администратор не согласует документы: так сохраняется разделение полномочий' };
    }
  }
  const other = (mine.get(w.id) ?? []).find((x) => x.stage !== w.stage);
  if (other) {
    return { ok: false, code: 'SEPARATION_OF_DUTIES', reason: `Вы уже согласовали этап «${stageName(other.stage)}» этой версии: один человек не согласует два этапа` };
  }
  return { ok: true };
}

/** «Ждёт вас»: этап автора — только владельцу; этапы 1–3 — тем, кто может их согласовать. */
function waitsFor(a: DocAccess, d: DocRow, mine: MyDecisions): boolean {
  const w = d.workingVersion;
  if (!w || d.archivedAt) return false;
  if (w.stage === 0 && d.ownerId !== a.userId) return false;
  return verdict(a, d, mine).ok;
}

/**
 * Какую версию пользователь видит. С ib.work — всё (рабочую, если есть). Без ib.work: рабочую — если она ждёт его
 * или он согласовал её в текущем круге; иначе утверждённую; архив и черновики без утверждённой версии — нет.
 */
function shownVersion(a: DocAccess, d: DocRow, mine: MyDecisions): VersionRow | null {
  if (a.ibWork) return d.workingVersion ?? d.approvedVersion;
  if (d.archivedAt) return null;
  const w = d.workingVersion;
  if (w && (waitsFor(a, d, mine) || (mine.get(w.id) ?? []).some((x) => x.round === w.round))) return w;
  return d.approvedVersion;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const isoDay = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

const pdfDto = (v: Pick<VersionRow, 'pdf'>) => (v.pdf ? { id: v.pdf.id, name: v.pdf.originalName, sha256: v.pdf.sha256, size: Number(v.pdf.size) } : null);

function versionDto(v: VersionRow) {
  return {
    id: v.id, no: v.no, edition: v.edition, title: v.title, onlyofficeUrl: v.onlyofficeUrl, changeNote: v.changeNote,
    stage: v.stage, stageName: stageName(v.stage), round: v.round, approvedAt: iso(v.approvedAt), createdAt: v.createdAt.toISOString(),
    /** Итоговый PDF версии; у утверждённой без него — «текст не зафиксирован». */
    pdf: pdfDto(v),
    textFrozen: v.pdf !== null,
  };
}

function toItem(a: DocAccess, d: DocRow, mine: MyDecisions, shown: VersionRow, today: string) {
  const reviewDue = isoDay(d.reviewDue);
  const working = a.ibWork || shown === d.workingVersion ? d.workingVersion : null;
  const status: DocStatus = docStatus({ hasApproved: d.approvedVersion !== null, workingStage: working?.stage ?? null, reviewDue }, today);
  return {
    id: d.id,
    number: d.number,
    title: shown.title,
    edition: shown.edition,
    versionNo: shown.no,
    type: d.type,
    owner: d.owner,
    approvedVersionNo: d.approvedVersion?.no ?? null,
    approvedAt: iso(d.approvedVersion?.approvedAt ?? null),
    reviewMonths: d.reviewMonths,
    reviewDue,
    status,
    statusName: DOC_STATUS_NAMES[status],
    /** Этап рабочей версии (если она видна): 0 — автор … 3 — правление. */
    stage: working?.stage ?? null,
    stageName: working ? stageName(working.stage) : null,
    waitingForMe: waitsFor(a, d, mine),
    archived: d.archivedAt !== null,
    version: d.version,
  };
}
export type DocItem = ReturnType<typeof toItem>;

// ---------------------------------------------------------------- реестр

export interface DocListQuery {
  archived: boolean;
  status?: DocStatus;
  typeId?: string;
  q?: string;
  waiting?: boolean;
  /** Только «к пересмотру» (needsReview) — ссылка с дашборда. */
  review?: boolean;
  limit: number;
  cursor?: string;
}

async function loadVisible(db: Db, a: DocAccess, where: Prisma.DocumentWhereInput) {
  const rows = await db.document.findMany({ where, include: docInclude, orderBy: { number: 'asc' } });
  const mine = await myDecisions(db, a.userId, rows.flatMap((d) => (d.workingVersionId ? [d.workingVersionId] : [])));
  const out: { d: DocRow; shown: VersionRow }[] = [];
  for (const d of rows) {
    const shown = shownVersion(a, d, mine);
    if (shown) out.push({ d, shown });
  }
  return { rows: out, mine };
}

export async function listDocuments(db: Db, a: DocAccess, q: DocListQuery) {
  const today = todayIso();
  // Без ib.work архив не виден.
  if (q.archived && !a.ibWork) return { items: [], nextCursor: null, total: 0, archivedTotal: 0 };
  const { rows, mine } = await loadVisible(db, a, { archivedAt: q.archived ? { not: null } : null, ...(q.typeId ? { typeId: q.typeId } : {}) });
  const needle = q.q?.trim().toLowerCase();
  const items = rows
    .map(({ d, shown }) => toItem(a, d, mine, shown, today))
    .filter((x) => (!q.status || x.status === q.status) && (!q.waiting || x.waitingForMe) && (!needle || x.title.toLowerCase().includes(needle))
      && (!q.review || needsReview(x, today)))
    // Сначала то, что ждёт вас, затем просроченный пересмотр, дальше по названию.
    .sort((x, y) => Number(y.waitingForMe) - Number(x.waitingForMe)
      || Number(y.status === 'review_overdue') - Number(x.status === 'review_overdue')
      || x.title.localeCompare(y.title, 'ru'));
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const archivedTotal = a.ibWork ? await db.document.count({ where: { archivedAt: { not: null } } }) : 0;
  return {
    items: items.slice(offset, offset + q.limit),
    nextCursor: items.length > offset + q.limit ? String(offset + q.limit) : null,
    total: items.length,
    archivedTotal,
  };
}

/** Счётчик у пункта «Документы»: ждут вас (всем); просроченный пересмотр — только сотрудникам ИБ. */
export async function documentSummary(db: Db, a: DocAccess) {
  const today = todayIso();
  const { rows, mine } = await loadVisible(db, a, { archivedAt: null });
  const waitingForMe = rows.filter(({ d }) => waitsFor(a, d, mine)).length;
  const reviewOverdue = a.ibWork ? rows.filter(({ d }) => (isoDay(d.reviewDue) ?? today) < today).length : 0;
  return { waitingForMe, reviewOverdue };
}

// ---------------------------------------------------------------- карточка

async function getRow(db: Db, id: string) {
  const d = await db.document.findUnique({ where: { id }, include: docInclude });
  if (!d) throw notFound('Документ');
  return d;
}

/** Кто может согласовать этап: имена активных пользователей с правом (без супер-администраторов и владельца). */
async function approversByStage(db: Db, d: DocRow) {
  const users = await db.user.findMany({
    where: { isActive: true, roles: { some: { role: { permissions: { some: { permissionCode: { in: STAGES.flatMap((s) => (s.perm ? [s.perm] : [])) } } } } } } },
    select: {
      id: true,
      fullName: true,
      roles: { select: { role: { select: { code: true, permissions: { select: { permissionCode: true } } } } } },
    },
    orderBy: { fullName: 'asc' },
  });
  return STAGES.map((s) => {
    if (s.perm === null) return { names: [d.owner.fullName], hint: `владелец или право «${permName('docs.manage')}»` };
    const perm = s.perm;
    const names = users
      .filter((u) => u.id !== d.ownerId && !u.roles.some((r) => r.role.code === 'super_admin') && u.roles.some((r) => r.role.permissions.some((p) => p.permissionCode === perm)))
      .map((u) => u.fullName);
    return { names, hint: `право «${permName(perm)}»` };
  });
}

export async function getDocument(db: Db, a: DocAccess, id: string) {
  const today = todayIso();
  const d = await getRow(db, id);
  const mine = await myDecisions(db, a.userId, d.workingVersionId ? [d.workingVersionId] : []);
  const shown = shownVersion(a, d, mine);
  if (!shown) throw notFound('Документ');
  const workingShown = shown === d.workingVersion;

  const allVersions = await db.documentVersion.findMany({ where: { documentId: id }, select: versionSelect, orderBy: { no: 'desc' } });
  const visibleVersions = allVersions.filter((v) => v.approvedAt !== null || a.ibWork || (workingShown && v.id === shown.id));
  const visibleIds = new Set(visibleVersions.map((v) => v.id));
  const history = await db.documentApproval.findMany({
    where: { documentId: id, versionId: { in: [...visibleIds] } },
    include: { actor: { select: { fullName: true } } },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
  });

  // Маршрут показанной версии: кто согласовал этапы в текущем круге.
  const roundActs = history.filter((h) => h.versionId === shown.id && h.round === shown.round && ['submitted', 'approved', 'skipped'].includes(h.decision));
  const approvers = await approversByStage(db, d);
  const route = STAGES.map((s, i) => {
    const act = roundActs.find((h) => h.stage === s.stage);
    const state = shown.approvedAt !== null || s.stage < shown.stage ? 'done' : s.stage === shown.stage ? 'current' : 'todo';
    return {
      stage: s.stage, name: s.name, state: state as 'done' | 'current' | 'todo',
      approvers: approvers[i]?.names ?? [], hint: approvers[i]?.hint ?? '',
      actedBy: act && act.decision !== 'skipped' ? act.actor.fullName : null, actedAt: act ? act.at.toISOString() : null,
      /** Этап пропущен: согласовать мог только владелец документа. */
      skipped: act?.decision === 'skipped' ? act.comment : null,
    };
  });

  // Последнее решение по показанной версии — возврат: замечание видно в карточке и без права на историю (ADR-0021).
  const lastAct = history.find((h) => h.versionId === shown.id);
  const returned = lastAct?.decision === 'returned'
    ? { at: lastAct.at.toISOString(), actor: lastAct.actor.fullName, stageName: stageName(lastAct.stage), comment: lastAct.comment }
    : null;

  const v = verdict(a, d, mine);
  const isOwner = d.ownerId === a.userId;
  const active = d.archivedAt === null;
  const w = d.workingVersion;
  const can = {
    edit: active && workingShown && w !== null && w.stage === 0 && (isOwner || a.manage),
    submit: active && workingShown && w !== null && w.stage === 0 && v.ok,
    approve: active && workingShown && w !== null && w.stage > 0 && v.ok,
    revise: active && d.approvedVersion !== null && w === null && (isOwner || a.manage),
    /** Приложить или заменить итоговый PDF рабочей версии (на этапах 1–3 — маршрут заново). */
    attachPdf: active && workingShown && w !== null && (isOwner || a.manage),
    manage: a.manage,
  };
  return {
    ...toItem(a, d, mine, shown, today),
    current: versionDto(shown),
    working: workingShown && w ? versionDto(w) : null,
    approved: d.approvedVersion ? versionDto(d.approvedVersion) : null,
    route,
    can,
    /** Почему вы не можете действовать на текущем этапе (для подсказки в карточке). */
    blockedReason: active && workingShown && w !== null && !v.ok ? v.reason : null,
    returned,
    versions: visibleVersions.map((x) => ({
      no: x.no, edition: x.edition, title: x.title, onlyofficeUrl: x.onlyofficeUrl, approvedAt: iso(x.approvedAt), changeNote: x.changeNote,
      pdf: pdfDto(x), textFrozen: x.pdf !== null,
    })),
    // Подробная история — по праву «История в карточках» (ADR-0021); блок маршрута (route) — всем, кто видит документ.
    history: !a.perms.has('history.view') ? [] : history.map((h) => ({
      id: h.id, at: h.at.toISOString(), actor: h.actor.fullName, stage: h.stage, stageName: stageName(h.stage),
      decision: h.decision as 'submitted' | 'approved' | 'returned' | 'revision_started' | 'skipped', comment: h.comment, versionNo: h.versionNo, round: h.round,
      pdfSha256: h.pdfSha256,
    })),
  };
}

/** Видит ли пользователь версию (для выдачи её PDF): те же правила, что у списка версий карточки. */
export async function versionVisible(db: Db, a: DocAccess, versionId: string): Promise<boolean> {
  const v = await db.documentVersion.findUnique({ where: { id: versionId }, select: { documentId: true, approvedAt: true } });
  if (!v) return false;
  const d = await getRow(db, v.documentId);
  const mine = await myDecisions(db, a.userId, d.workingVersionId ? [d.workingVersionId] : []);
  const shown = shownVersion(a, d, mine);
  if (!shown) return false;
  return a.ibWork || v.approvedAt !== null || (shown === d.workingVersion && shown.id === versionId);
}

// ---------------------------------------------------------------- проверки ввода

function cleanTitle(v: string) {
  const t = trimmed(v);
  if (!t) throw badRequest('EMPTY_TITLE', 'Укажите название документа');
  if (t.length > TITLE_MAX) throw badRequest('TOO_LONG', `Название — не длиннее ${TITLE_MAX} символов`);
  return t;
}
function cleanEdition(v: string) {
  const t = trimmed(v);
  if (t.length > EDITION_MAX) throw badRequest('TOO_LONG', `Редакция — не длиннее ${EDITION_MAX} символов`);
  return t;
}
/** Настройки документов из .env: префикс ссылок OnlyOffice (ONLYOFFICE_URL_PREFIX, ADR-0010). */
export interface DocPolicy {
  urlPrefix?: string;
}

function cleanUrl(v: string, policy: DocPolicy) {
  const t = v.trim();
  const prefix = policy.urlPrefix ?? '';
  if (!isDocUrl(t, prefix)) {
    throw badRequest('BAD_URL', prefix
      ? `Ссылка на файл в OnlyOffice должна начинаться с ${prefix}`
      : 'Ссылка на файл в OnlyOffice — адрес, который начинается с http:// или https://');
  }
  return t;
}
function cleanNote(v: string) {
  const t = v.trim();
  if (t.length > NOTE_MAX) throw badRequest('TOO_LONG', `Что изменено — не длиннее ${NOTE_MAX} символов`);
  return t;
}
function cleanMonths(v: number) {
  if (!Number.isInteger(v) || v < 1 || v > 60) throw badRequest('BAD_MONTHS', 'Цикл пересмотра — от 1 до 60 месяцев');
  return v;
}

async function checkType(db: Db, id: string, current?: string) {
  const item = await db.catalogItem.findFirst({ where: { id, catalogCode: DOCUMENT_TYPES_CATALOG, deletedAt: null } });
  if (!item) throw badRequest('BAD_VALUE', 'Нет такого типа документа');
  if (item.archivedAt && id !== current) throw badRequest('BAD_VALUE', `Тип «${item.value}» в архиве — выберите другой`);
  return item;
}

/** Владелец — активный пользователь с ib.work: ему ставятся задачи пересмотра и доработки. */
async function checkOwner(db: Db, id: string, current?: string) {
  if (id === current) return;
  const u = await db.user.findFirst({ where: { id, isActive: true, ...IB_WORK }, select: { id: true } });
  if (!u) throw badRequest('BAD_OWNER', 'Владельцем документа может быть только активный сотрудник с доступом к разделам ИБ');
}

const forbiddenWith = (code: string, reason: string) => new AppError(403, code, reason);

// ---------------------------------------------------------------- создание и правка

export interface NewDocumentInput {
  title: string;
  typeId: string;
  ownerId: string;
  onlyofficeUrl: string;
  edition?: string;
  changeNote?: string;
  reviewMonths?: number;
}

/** Создать документ (право docs.manage проверяет маршрут): версия 1, черновик на этапе «Автор». */
export async function createDocument(db: Db, actor: Actor, input: NewDocumentInput, policy: DocPolicy = {}): Promise<string> {
  return withTx(db, async (tx) => {
    const title = cleanTitle(input.title);
    const onlyofficeUrl = cleanUrl(input.onlyofficeUrl, policy);
    const edition = cleanEdition(input.edition ?? '');
    const changeNote = cleanNote(input.changeNote ?? '');
    const reviewMonths = cleanMonths(input.reviewMonths ?? DEFAULT_REVIEW_MONTHS);
    await checkType(tx, input.typeId);
    await checkOwner(tx, input.ownerId);
    // Документ и версия ссылаются друг на друга: внешний ключ на версию проверяется в конце транзакции.
    const id = randomUUID();
    const versionId = randomUUID();
    const doc = await tx.document.create({
      data: { id, typeId: input.typeId, ownerId: input.ownerId, reviewMonths, workingVersionId: versionId, createdBy: actor.id },
    });
    await tx.documentVersion.create({ data: { id: versionId, documentId: id, no: 1, edition, title, onlyofficeUrl, changeNote, createdBy: actor.id } });
    // Проверить ссылку сейчас, а не при COMMIT; затем вернуть отложенный режим для следующих документов в транзакции.
    await tx.$executeRaw`SET CONSTRAINTS "documents_working_version_id_fkey" IMMEDIATE`;
    await tx.$executeRaw`SET CONSTRAINTS "documents_working_version_id_fkey" DEFERRED`;
    await auditSettings(tx, actor, {
      action: 'document.created', entity: 'document', entityId: id,
      summary: `Документ #${doc.number} «${title}» создан (версия 1)`,
      after: { title, typeId: input.typeId, ownerId: input.ownerId, reviewMonths, onlyofficeUrl, edition },
    });
    return id;
  });
}

export interface DocumentPatch {
  version: number;
  title?: string;
  edition?: string;
  onlyofficeUrl?: string;
  changeNote?: string;
  typeId?: string;
  ownerId?: string;
  reviewMonths?: number;
}

interface Change { label: string; from: string; to: string }

/**
 * Правка: содержимое (название, редакция, ссылка, что изменено) — только у черновика на этапе «Автор»,
 * владельцем или docs.manage; тип, владелец и цикл пересмотра — docs.manage.
 * Утверждённую версию не правят: для этого создаётся новая версия (revise).
 */
export async function updateDocument(db: Db, actor: Actor, id: string, input: DocumentPatch, policy: DocPolicy = {}) {
  return withTx(db, async (tx) => {
    const a = await accessOf(tx, actor.id);
    const d = await getRow(tx, id);
    if (d.version !== input.version) throw versionConflict();
    if (d.archivedAt) throw conflict('DOC_ARCHIVED', 'Документ в архиве. Верните его из архива, чтобы изменить');
    const changes: Change[] = [];
    const contentKeys = ['title', 'edition', 'onlyofficeUrl', 'changeNote'] as const;
    if (contentKeys.some((k) => input[k] !== undefined)) {
      const w = d.workingVersion;
      if (!w) throw conflict('DOC_APPROVED', 'Утверждённая версия не меняется. Создайте новую версию — она пройдёт маршрут заново');
      if (w.stage > 0) throw conflict('DOC_IN_ROUTE', `Документ на этапе «${stageName(w.stage)}». Изменить его можно после возврата на доработку`);
      if (d.ownerId !== a.userId && !a.manage) throw forbiddenWith('FORBIDDEN', 'Черновик правит владелец документа или пользователь с правом «Документы: управление»');
      const data: Prisma.DocumentVersionUpdateInput = {};
      if (input.title !== undefined) {
        const v = cleanTitle(input.title);
        if (v !== w.title) { data.title = v; changes.push({ label: 'Название', from: w.title, to: v }); }
      }
      if (input.edition !== undefined) {
        const v = cleanEdition(input.edition);
        if (v !== w.edition) { data.edition = v; changes.push({ label: 'Редакция', from: w.edition || '—', to: v || '—' }); }
      }
      if (input.onlyofficeUrl !== undefined) {
        const v = cleanUrl(input.onlyofficeUrl, policy);
        if (v !== w.onlyofficeUrl) { data.onlyofficeUrl = v; changes.push({ label: 'Ссылка OnlyOffice', from: w.onlyofficeUrl, to: v }); }
      }
      if (input.changeNote !== undefined) {
        const v = cleanNote(input.changeNote);
        if (v !== w.changeNote) { data.changeNote = v; changes.push({ label: 'Что изменено', from: w.changeNote ? 'было' : '—', to: v ? 'изменено' : '—' }); }
      }
      if (Object.keys(data).length) await tx.documentVersion.update({ where: { id: w.id }, data });
    }
    const docData: Prisma.DocumentUncheckedUpdateManyInput = {};
    if (input.typeId !== undefined || input.ownerId !== undefined || input.reviewMonths !== undefined) {
      if (!a.manage) throw forbiddenWith('FORBIDDEN', 'Тип, владельца и цикл пересмотра меняет пользователь с правом «Документы: управление»');
      if (input.typeId !== undefined && input.typeId !== d.typeId) {
        const t = await checkType(tx, input.typeId, d.typeId);
        docData.typeId = t.id;
        changes.push({ label: 'Тип', from: d.type.value, to: t.value });
      }
      if (input.ownerId !== undefined && input.ownerId !== d.ownerId) {
        await checkOwner(tx, input.ownerId, d.ownerId);
        const u = await tx.user.findUniqueOrThrow({ where: { id: input.ownerId }, select: { fullName: true } });
        docData.ownerId = input.ownerId;
        changes.push({ label: 'Владелец', from: d.owner.fullName, to: u.fullName });
      }
      if (input.reviewMonths !== undefined && input.reviewMonths !== d.reviewMonths) {
        const m = cleanMonths(input.reviewMonths);
        docData.reviewMonths = m;
        changes.push({ label: 'Цикл пересмотра', from: `${d.reviewMonths} мес.`, to: `${m} мес.` });
        // Дата пересмотра — от даты утверждения действующей версии.
        if (d.approvedVersion?.approvedAt) {
          const due = addMonthsIso(todayIso(d.approvedVersion.approvedAt), m);
          docData.reviewDue = new Date(`${due}T00:00:00Z`);
          changes.push({ label: 'Пересмотр до', from: d.reviewDue ? formatDateRu(isoDay(d.reviewDue) as string) : '—', to: formatDateRu(due) });
        }
      }
    }
    if (changes.length) {
      const res = await tx.document.updateMany({ where: { id, version: input.version }, data: { ...docData, version: { increment: 1 } } });
      if (res.count === 0) throw versionConflict();
      await auditSettings(tx, actor, {
        action: 'document.updated', entity: 'document', entityId: id,
        summary: `Документ #${d.number}: ${changes.map((c) => `«${c.label}»`).join(', ')}`,
        after: { changes },
      });
    }
  });
}

// ---------------------------------------------------------------- маршрут

export interface RouteInput {
  version: number;
  /** Этап, который пользователь видел на экране: если документ уже на другом этапе — 409. */
  stage: number;
  comment?: string;
  /** Отправка на согласование: итоговый PDF (если ещё не приложен или заменяется). */
  pdfFileId?: string;
}

const PDF_MIME = ['application/pdf'];

/** Приложить PDF к рабочей версии; прежний PDF без других ссылок помечается удалённым. Возвращает sha256. */
async function setPdf(tx: Db, actor: Actor, w: VersionRow, fileId: string): Promise<{ sha256: string; name: string; changed: boolean }> {
  const [f] = await claimFiles(tx, actor.id, [fileId], { mimes: PDF_MIME, what: 'Итоговый PDF' });
  if (!f) throw badRequest('PDF_REQUIRED', 'Приложите итоговый PDF документа');
  if (w.pdfFileId === f.id) return { sha256: f.sha256, name: f.originalName, changed: false };
  await tx.documentVersion.update({ where: { id: w.id }, data: { pdfFileId: f.id } });
  if (w.pdfFileId) await deleteIfUnreferenced(tx, actor, w.pdfFileId, `заменён итоговый PDF версии ${w.no}`);
  return { sha256: f.sha256, name: f.originalName, changed: true };
}

const pdfRequired = () => conflict('PDF_REQUIRED', 'У версии нет итогового PDF. Автор прикладывает его и отправляет документ на согласование заново');

/** Общее для действий маршрута: свежие права, версия документа, текущий этап и проверка «кто может». */
async function routeContext(tx: Db, actor: Actor, id: string, input: RouteInput) {
  const a = await accessOf(tx, actor.id);
  const d = await getRow(tx, id);
  const w = d.workingVersion;
  if (!w) throw conflict('NOT_IN_ROUTE', 'Документ не на согласовании. Обновите страницу');
  if (d.version !== input.version) throw versionConflict();
  if (w.stage !== input.stage) throw conflict('STAGE_CHANGED', `Документ уже на этапе «${stageName(w.stage)}». Обновите страницу`);
  const mine = await myDecisions(tx, a.userId, [w.id]);
  const v = verdict(a, d, mine);
  if (!v.ok) {
    if (v.code === 'DOC_ARCHIVED') throw conflict(v.code, v.reason);
    throw forbiddenWith(v.code, v.reason);
  }
  // Захватить документ: параллельное действие с той же версией получит 409.
  const res = await tx.document.updateMany({ where: { id, version: input.version }, data: { version: { increment: 1 } } });
  if (res.count === 0) throw versionConflict();
  return { d, w };
}

async function addDecision(tx: Db, data: Prisma.DocumentApprovalUncheckedCreateInput) {
  try {
    await withTx(tx, (t) => t.documentApproval.create({ data }));
  } catch (err) {
    if (isUniqueViolation(err)) throw versionConflict();
    throw err;
  }
}

/** Этап «Автор»: отправить на согласование. Открытая задача доработки закрывается. */
export async function submitDocument(db: Db, actor: Actor, id: string, input: RouteInput) {
  return withTx(db, async (tx) => {
    if (input.stage !== 0) throw conflict('STAGE_CHANGED', 'Отправить на согласование можно только с этапа «Автор». Обновите страницу');
    const { d, w } = await routeContext(tx, actor, id, input);
    let sha256 = w.pdf?.sha256 ?? null;
    if (input.pdfFileId) {
      const pdf = await setPdf(tx, actor, w, input.pdfFileId);
      sha256 = pdf.sha256;
      w.pdfFileId = input.pdfFileId;
    }
    if (!sha256) throw badRequest('PDF_REQUIRED', 'Приложите итоговый PDF документа: все этапы согласуют именно этот файл');
    await addDecision(tx, { documentId: id, versionId: w.id, versionNo: w.no, round: w.round, stage: 0, decision: 'submitted', comment: '', actorId: actor.id, pdfSha256: sha256 });
    await closeDocumentTasks(tx, id, 'returned', `Документ отправлен на согласование (версия ${w.no})`);
    await auditSettings(tx, actor, {
      action: 'document.submitted', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}» (версия ${w.no}) отправлен на согласование, PDF sha256 ${sha256.slice(0, 12)}…`,
      after: { versionNo: w.no, round: w.round, pdfSha256: sha256 },
    });
    await moveTo(tx, actor, d, w, 1, sha256);
  });
}

/** Согласовать текущий этап (1–3). После этапа «Утверждение правлением» версия утверждена. */
export async function approveDocument(db: Db, actor: Actor, id: string, input: RouteInput) {
  return withTx(db, async (tx) => {
    if (input.stage < 1 || input.stage > LAST_STAGE) throw conflict('STAGE_CHANGED', 'Этот этап не согласуют. Обновите страницу');
    const { d, w } = await routeContext(tx, actor, id, input);
    // Версия ушла на согласование до этапа 7 без PDF: утверждать нечего зафиксированного (проверка в сервисе;
    // триггер в БД — релизом-«сужением» перед первой выкладкой).
    const sha256 = w.pdf?.sha256;
    if (!sha256) throw pdfRequired();
    await addDecision(tx, { documentId: id, versionId: w.id, versionNo: w.no, round: w.round, stage: w.stage, decision: 'approved', comment: (input.comment ?? '').trim().slice(0, COMMENT_MAX), actorId: actor.id, pdfSha256: sha256 });
    if (w.stage < LAST_STAGE) {
      await auditSettings(tx, actor, {
        action: 'document.approved_stage', entity: 'document', entityId: id,
        summary: `Документ #${d.number} «${w.title}» (версия ${w.no}): этап «${stageName(w.stage)}» согласован`,
        after: { versionNo: w.no, round: w.round, stage: w.stage },
      });
    }
    await moveTo(tx, actor, d, w, w.stage + 1, sha256);
  });
}

/**
 * Этап, который некому согласовать, кроме владельца: у владельца есть право этапа, а других активных
 * пользователей с этим правом (не супер-администраторов) нет. Тогда этап не требуется — иначе документ встанет.
 */
async function skipReason(tx: Db, d: DocRow, stage: number): Promise<string | null> {
  const perm = STAGES[stage]?.perm;
  if (!perm) return null;
  const owner = await accessOf(tx, d.ownerId);
  if (!owner.perms.has(perm)) return null;
  const others = await tx.user.count({
    where: {
      id: { not: d.ownerId },
      isActive: true,
      AND: [
        { roles: { some: { role: { permissions: { some: { permissionCode: perm } } } } } },
        { roles: { none: { role: { code: 'super_admin' } } } },
      ],
    },
  });
  if (others > 0) return null;
  return `Не требуется: автор — ${stageName(stage)}. Владелец документа ${d.owner.fullName} имеет право «${permName(perm)}», других согласующих нет`;
}

/**
 * Перевести рабочую версию на этап next. Этапы, где согласовать может только владелец, пропускаются
 * с записью «skipped» в истории (кто владелец, почему пропущен); после последнего этапа — утверждение.
 */
async function moveTo(tx: Db, actor: Actor, d: DocRow, w: VersionRow, next: number, pdfSha256: string) {
  let stage = next;
  for (; stage <= LAST_STAGE; stage++) {
    const reason = await skipReason(tx, d, stage);
    if (!reason) break;
    await addDecision(tx, { documentId: d.id, versionId: w.id, versionNo: w.no, round: w.round, stage, decision: 'skipped', comment: reason, actorId: d.ownerId, pdfSha256 });
    await auditSettings(tx, actor, {
      action: 'document.stage_skipped', entity: 'document', entityId: d.id,
      summary: `Документ #${d.number} «${w.title}» (версия ${w.no}): этап «${stageName(stage)}» не требуется — автор ${d.owner.fullName}`,
      after: { versionNo: w.no, round: w.round, stage, ownerId: d.ownerId, reason },
    });
  }
  if (stage <= LAST_STAGE) {
    await tx.documentVersion.update({ where: { id: w.id }, data: { stage } });
    return;
  }
  // Утверждение: версия становится действующей и больше не меняется (триггер), цикл пересмотра — от сегодня.
  const now = new Date();
  const due = addMonthsIso(todayIso(now), d.reviewMonths);
  await tx.documentVersion.update({ where: { id: w.id }, data: { stage: LAST_STAGE, approvedAt: now } });
  await tx.document.update({
    where: { id: d.id },
    data: { approvedVersionId: w.id, workingVersionId: null, reviewDue: new Date(`${due}T00:00:00Z`) },
  });
  await closeDocumentTasks(tx, d.id, 'review', `Версия ${w.no} утверждена, следующий пересмотр — до ${formatDateRu(due)}`);
  await auditSettings(tx, actor, {
    action: 'document.approved', entity: 'document', entityId: d.id,
    summary: `Документ #${d.number} «${w.title}» (версия ${w.no}) утверждён, пересмотр до ${formatDateRu(due)}`,
    after: { versionNo: w.no, round: w.round, reviewDue: due, pdfSha256 },
  });
}

/** Вернуть на доработку (этапы 1–3): только с комментарием; маршрут заново, владельцу — задача. */
export async function returnDocument(db: Db, actor: Actor, id: string, input: RouteInput) {
  return withTx(db, async (tx) => {
    const comment = (input.comment ?? '').trim();
    if (!comment) throw badRequest('EMPTY_COMMENT', 'Напишите, что нужно исправить');
    if (comment.length > COMMENT_MAX) throw badRequest('TOO_LONG', `Комментарий — не длиннее ${COMMENT_MAX} символов`);
    if (input.stage < 1 || input.stage > LAST_STAGE) throw conflict('STAGE_CHANGED', 'Вернуть на доработку можно с этапов согласования. Обновите страницу');
    const { d, w } = await routeContext(tx, actor, id, input);
    await addDecision(tx, { documentId: id, versionId: w.id, versionNo: w.no, round: w.round, stage: w.stage, decision: 'returned', comment, actorId: actor.id });
    await tx.documentVersion.update({ where: { id: w.id }, data: { stage: 0, round: w.round + 1 } });
    const who = (await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { fullName: true } })).fullName;
    await documentTask(tx, {
      documentId: id,
      reason: 'returned',
      title: `Доработать документ «${w.title}»`,
      description: `Документ #${d.number}, версия ${w.no}. ${who} вернул(а) его на доработку с этапа «${stageName(w.stage)}»:\n${comment}\n\nПосле правки отправьте документ на согласование заново.`,
      repeatComment: `Повторный возврат с этапа «${stageName(w.stage)}» (${who}): ${comment}`,
      workdays: 3,
    });
    await auditSettings(tx, actor, {
      action: 'document.returned', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}» (версия ${w.no}) возвращён на доработку с этапа «${stageName(w.stage)}»`,
      after: { versionNo: w.no, round: w.round, stage: w.stage, comment },
    });
  });
}

export interface PdfInput {
  version: number;
  /** Этап, который пользователь видел на экране. */
  stage: number;
  fileId: string;
}

/**
 * Приложить или заменить итоговый PDF рабочей версии (владелец или docs.manage). На этапе «Автор» — просто
 * прикладывается; на этапах 1–3 замена возвращает маршрут к началу: новый круг, этап «Автор», согласования
 * текущего круга больше не действуют (все этапы согласуют один файл).
 */
export async function attachPdf(db: Db, actor: Actor, id: string, input: PdfInput) {
  return withTx(db, async (tx) => {
    const a = await accessOf(tx, actor.id);
    const d = await getRow(tx, id);
    const w = d.workingVersion;
    if (!w) throw conflict('DOC_APPROVED', 'Утверждённая версия не меняется: PDF прикладывается к новой версии');
    if (d.version !== input.version) throw versionConflict();
    if (w.stage !== input.stage) throw conflict('STAGE_CHANGED', `Документ уже на этапе «${stageName(w.stage)}». Обновите страницу`);
    if (d.archivedAt) throw conflict('DOC_ARCHIVED', 'Документ в архиве. Верните его из архива, чтобы изменить');
    if (d.ownerId !== a.userId && !a.manage) throw forbiddenWith('FORBIDDEN', 'Итоговый PDF прикладывает владелец документа или пользователь с правом «Документы: управление»');
    const res = await tx.document.updateMany({ where: { id, version: input.version }, data: { version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    const pdf = await setPdf(tx, actor, w, input.fileId);
    if (!pdf.changed) return;
    const restart = w.stage > 0;
    if (restart) {
      await addDecision(tx, {
        documentId: id, versionId: w.id, versionNo: w.no, round: w.round, stage: w.stage, decision: 'returned',
        comment: `Заменён итоговый PDF («${pdf.name}») — маршрут начат заново`, actorId: actor.id, pdfSha256: pdf.sha256,
      });
      await tx.documentVersion.update({ where: { id: w.id }, data: { stage: 0, round: w.round + 1 } });
    }
    await auditSettings(tx, actor, {
      action: 'document.pdf_attached', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}» (версия ${w.no}): ${w.pdfFileId ? 'заменён' : 'приложен'} итоговый PDF «${pdf.name}»${restart ? ` на этапе «${stageName(w.stage)}» — маршрут начат заново` : ''}`,
      after: { versionNo: w.no, round: w.round, pdfSha256: pdf.sha256, restarted: restart },
    });
  });
}

export interface ReviseInput {
  version: number;
  title?: string;
  edition?: string;
  onlyofficeUrl?: string;
  changeNote?: string;
}

/**
 * Новая версия утверждённого документа (правка или пересмотр без изменений): копия действующей версии
 * на этапе «Автор». Утверждённые версии остаются в истории без изменений.
 */
export async function reviseDocument(db: Db, actor: Actor, id: string, input: ReviseInput, policy: DocPolicy = {}) {
  return withTx(db, async (tx) => {
    const a = await accessOf(tx, actor.id);
    const d = await getRow(tx, id);
    if (d.version !== input.version) throw versionConflict();
    if (d.archivedAt) throw conflict('DOC_ARCHIVED', 'Документ в архиве. Верните его из архива, чтобы создать новую версию');
    const base = d.approvedVersion;
    if (!base) throw conflict('NOT_APPROVED', 'Документ ещё не утверждён: правьте черновик');
    if (d.workingVersion) throw conflict('HAS_WORKING', `Новая версия ${d.workingVersion.no} уже в работе`);
    if (d.ownerId !== a.userId && !a.manage) throw forbiddenWith('FORBIDDEN', 'Новую версию создаёт владелец документа или пользователь с правом «Документы: управление»');
    const last = await tx.documentVersion.aggregate({ where: { documentId: id }, _max: { no: true } });
    const no = (last._max.no ?? base.no) + 1;
    const v = await tx.documentVersion.create({
      data: {
        documentId: id, no,
        title: input.title !== undefined ? cleanTitle(input.title) : base.title,
        edition: input.edition !== undefined ? cleanEdition(input.edition) : base.edition,
        onlyofficeUrl: input.onlyofficeUrl !== undefined ? cleanUrl(input.onlyofficeUrl, policy) : base.onlyofficeUrl,
        changeNote: cleanNote(input.changeNote ?? ''),
        createdBy: actor.id,
      },
    });
    const res = await tx.document.updateMany({ where: { id, version: input.version }, data: { workingVersionId: v.id, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    await addDecision(tx, { documentId: id, versionId: v.id, versionNo: no, round: 1, stage: 0, decision: 'revision_started', comment: v.changeNote, actorId: actor.id });
    await auditSettings(tx, actor, {
      action: 'document.revision_started', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${v.title}»: создана версия ${no} (действующая — ${base.no})`,
      after: { versionNo: no, baseVersionNo: base.no },
    });
  });
}

/** Архив (docs.manage проверяет маршрут): документ пропадает из реестра, пересмотр не контролируется. */
export async function setDocumentArchived(db: Db, actor: Actor, id: string, version: number, archived: boolean) {
  return withTx(db, async (tx) => {
    const d = await getRow(tx, id);
    if (d.version !== version) throw versionConflict();
    if ((d.archivedAt !== null) === archived) return;
    const res = await tx.document.updateMany({ where: { id, version }, data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    const title = (d.workingVersion ?? d.approvedVersion)?.title ?? '';
    await auditSettings(tx, actor, {
      action: archived ? 'document.archived' : 'document.restored', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${title}» ${archived ? 'отправлен в архив' : 'возвращён из архива'}`,
    });
  });
}
