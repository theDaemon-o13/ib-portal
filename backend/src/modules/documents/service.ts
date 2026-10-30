// Документы (этап 6, ADR-0010; маршрут 1.2.0 — ADR-0024): реестр внутренних документов ИБ, версии, маршрут, пересмотр.
// Права: маршруты пускают любого вошедшего (requireAuth), а кто что может — решает этот сервис (status.ts, MOVES):
// автор — владелец или docs.manage; старший — над владельцем (ADR-0020); начальник ИБ — docs.approve.head, но не
// супер-администратор (ни через какую роль). Свой документ на этапе 13 начальник ИБ согласует сам, только если
// другого начальника ИБ нет, — с отметкой «без независимого согласования».
// Без ib.work видны только подписанные документы, «ждёт вас» и те, где вы действовали в текущем круге.
// Текст фиксируется файлами: 13 → 14 — версия, одобренная начальником ИБ, 14 → 15 — финальная, 16 — подписанный PDF.
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { DOCUMENT_TYPES_CATALOG } from '../../lib/catalogs.js';
import { withTx, isUniqueViolation, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { MIME_BY_EXT } from '../../lib/file-type.js';
import { subordinateIdsOf } from '../../lib/hierarchy.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { formatDateRu } from '../../lib/register-values.js';
import { claimFiles, deleteIfUnreferenced } from '../files/links.js';
import { todayIso } from '../../lib/today.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { notifyDocComment, notifyReturned, notifyStage } from './notify.js';
import { closeDocumentTasks, documentTask } from './tasks.js';
import {
  addMonthsIso, DEFAULT_REVIEW_MONTHS, docStatus, FIRST_STAGE, FIXED_FILE, isDocUrl, LEGACY_STAGE_NAMES, MOVES, needsReview,
  ROUTE, SIGN_STAGE, stageName, allowedActions, DOC_STATUS_NAMES, type DocAction, type DocRole, type DocStatus,
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
  approvedAt: true, signedOn: true, cancelledAt: true, createdAt: true, pdfFileId: true,
  pdf: { select: { id: true, originalName: true, sha256: true, size: true } },
} as const;
const docInclude = {
  type: { select: { id: true, value: true } },
  owner: { select: { id: true, fullName: true } },
  approvedVersion: { select: versionSelect },
  workingVersion: { select: versionSelect },
} as const;
export type DocRow = Prisma.DocumentGetPayload<{ include: typeof docInclude }>;
type VersionRow = NonNullable<DocRow['workingVersion']>;

/** Условия переходов по версии (этап Г3): ответственные лица этапа 14 и открытые блокеры. */
export interface RouteFacts {
  parties: number;
  /** Лица, которые ещё не согласовали. */
  pending: number;
  /** Ближайший срок несогласовавшего лица (YYYY-MM-DD). */
  nearestDue: string | null;
  openBlockers: number;
  /** Этап 15 (Г4): языки перевода и сколько из них без файла. */
  translations: number;
  missingTranslations: number;
  /** Переводчики языков без файла: документ ждёт их. */
  pendingTranslators: readonly string[];
  /** Все переводчики версии: им виден документ на маршруте. */
  translators: readonly string[];
}
const NO_FACTS: RouteFacts = { parties: 0, pending: 0, nearestDue: null, openBlockers: 0, translations: 0, missingTranslations: 0, pendingTranslators: [], translators: [] };

async function routeFacts(db: Db, versionIds: readonly string[]): Promise<Map<string, RouteFacts>> {
  const map = new Map<string, RouteFacts>();
  if (!versionIds.length) return map;
  const ids = [...new Set(versionIds)];
  const [parties, blockers, translations] = await Promise.all([
    db.$queryRaw<{ version_id: string; total: bigint; pending: bigint; due: Date | null }[]>`
      SELECT version_id::text, count(*) AS total, count(*) FILTER (WHERE approved_at IS NULL) AS pending,
             min(due_date) FILTER (WHERE approved_at IS NULL) AS due
      FROM document_parties WHERE version_id = ANY(${ids}::uuid[]) AND removed_at IS NULL GROUP BY version_id`,
    db.$queryRaw<{ version_id: string; open: bigint }[]>`
      SELECT version_id::text, count(*) AS open FROM document_blockers
      WHERE version_id = ANY(${ids}::uuid[]) AND resolved_at IS NULL GROUP BY version_id`,
    db.$queryRaw<{ version_id: string; translator_id: string; has_file: boolean }[]>`
      SELECT t.version_id::text, t.translator_id::text,
             EXISTS (SELECT 1 FROM document_files f WHERE f.translation_id = t.id AND f.removed_at IS NULL) AS has_file
      FROM document_translations t WHERE t.version_id = ANY(${ids}::uuid[]) AND t.removed_at IS NULL`,
  ]);
  const get = (id: string) => map.get(id) ?? { ...NO_FACTS };
  for (const p of parties) map.set(p.version_id, { ...get(p.version_id), parties: Number(p.total), pending: Number(p.pending), nearestDue: p.due?.toISOString().slice(0, 10) ?? null });
  for (const b of blockers) map.set(b.version_id, { ...get(b.version_id), openBlockers: Number(b.open) });
  for (const t of translations) {
    const f = get(t.version_id);
    map.set(t.version_id, {
      ...f,
      translations: f.translations + 1,
      missingTranslations: f.missingTranslations + (t.has_file ? 0 : 1),
      pendingTranslators: t.has_file ? f.pendingTranslators : [...f.pendingTranslators, t.translator_id],
      translators: [...f.translators, t.translator_id],
    });
  }
  return map;
}

/** Пользователь, для которого считаются действия: права, его подчинённые, есть ли другой начальник ИБ. */
interface Who {
  a: DocAccess;
  subordinates: ReadonlySet<string>;
  /** Есть другой активный пользователь с docs.approve.head (не супер-администратор): свой документ согласует он. */
  otherHead: boolean;
  /** Версии, по которым пользователь принимал решения, и в каких кругах. */
  acted: ReadonlyMap<string, readonly number[]>;
  /** Условия переходов по рабочим версиям. */
  facts: ReadonlyMap<string, RouteFacts>;
}

const isHead = (a: DocAccess) => a.perms.has('docs.approve.head') && !a.superAdmin;

const HEADS_WHERE: Prisma.UserWhereInput = {
  isActive: true,
  AND: [
    { roles: { some: { role: { permissions: { some: { permissionCode: 'docs.approve.head' } } } } } },
    { roles: { none: { role: { code: 'super_admin' } } } },
  ],
};

async function whoOf(db: Db, a: DocAccess, versionIds: readonly string[], factIds: readonly string[] = versionIds): Promise<Who> {
  const [subs, others, rows, facts] = await Promise.all([
    subordinateIdsOf(db, a.userId),
    isHead(a) ? db.user.count({ where: { ...HEADS_WHERE, id: { not: a.userId } } }) : 0,
    versionIds.length
      ? db.documentApproval.findMany({ where: { actorId: a.userId, versionId: { in: [...versionIds] }, decision: { not: 'migrated' } }, select: { versionId: true, round: true } })
      : [],
    routeFacts(db, factIds),
  ]);
  const acted = new Map<string, number[]>();
  for (const r of rows) acted.set(r.versionId, [...(acted.get(r.versionId) ?? []), r.round]);
  return { a, subordinates: new Set(subs), otherHead: others > 0, acted, facts };
}

export function rolesOf(w: Who, d: DocRow): Set<DocRole> {
  const roles = new Set<DocRole>();
  if (d.ownerId === w.a.userId || w.a.manage) roles.add('author');
  if (w.subordinates.has(d.ownerId)) roles.add('senior');
  if (isHead(w.a)) roles.add('head');
  return roles;
}

/** Рабочая версия, с которой можно действовать: есть, не отменена, документ не в архиве. */
export const activeWorking = (d: DocRow): VersionRow | null => (d.archivedAt || !d.workingVersion || d.workingVersion.cancelledAt ? null : d.workingVersion);

/** Свой документ на этапе 13: при другом начальнике ИБ согласует он (решение владельца 6). */
const ownApprovalBlocked = (w: Who, d: DocRow) => d.ownerId === w.a.userId && w.otherHead;

/** Действия маршрута по ролям пользователя (без условий данных). */
function roleActions(w: Who, d: DocRow): DocAction[] {
  const v = activeWorking(d);
  if (!v) return [];
  return allowedActions(v.stage, rolesOf(w, d)).filter((x) => !(x === 'approve' && ownApprovalBlocked(w, d)));
}

/**
 * Почему переход вперёд сейчас невозможен по данным; null — можно. Открытый блокер останавливает любой шаг вперёд
 * и подписание; 14 → 15 — только когда все ответственные лица (хотя бы одно) согласовали (этап Г3).
 */
function gate(w: Who, d: DocRow, action: DocAction | 'sign'): { code: string; reason: string } | null {
  const v = activeWorking(d);
  if (!v || action === 'return') return null;
  const f = w.facts.get(v.id) ?? NO_FACTS;
  if (f.openBlockers > 0) return { code: 'BLOCKERS_OPEN', reason: `Открытых блокеров: ${f.openBlockers}. Снимите их, чтобы двигать документ дальше` };
  if (action === 'ack_final' && f.parties === 0) return { code: 'NO_PARTIES', reason: 'Добавьте ответственных лиц и отметьте их согласование' };
  if (action === 'ack_final' && f.pending > 0) return { code: 'PARTIES_PENDING', reason: `Не все ответственные лица согласовали: осталось ${f.pending}` };
  if (action === 'to_signing' && f.missingTranslations > 0) {
    return { code: 'TRANSLATIONS_MISSING', reason: `Не у всех языков есть файл перевода: осталось ${f.missingTranslations}` };
  }
  return null;
}

/** Действия маршрута, доступные пользователю сейчас: по ролям и по данным. */
function actionsOf(w: Who, d: DocRow): DocAction[] {
  return roleActions(w, d).filter((x) => gate(w, d, x) === null);
}

/** Этап 16: подписанный PDF и дату загружают автор и начальник ИБ (решение владельца 1). */
function signRole(w: Who, d: DocRow): boolean {
  const v = activeWorking(d);
  if (!v || v.stage !== SIGN_STAGE) return false;
  const roles = rolesOf(w, d);
  return roles.has('author') || roles.has('head');
}
const canSign = (w: Who, d: DocRow) => signRole(w, d) && gate(w, d, 'sign') === null;

/**
 * «Ждёт вас»: этапы автора (11, 12, 16) — только владельцу; остальные — тем, кто может действовать.
 * docs.manage и начальник ИБ могут действовать за автора, но документ их не ждёт.
 */
function waitsFor(w: Who, d: DocRow): boolean {
  const v = activeWorking(d);
  if (!v) return false;
  if (v.stage === 11 || v.stage === 12 || v.stage === SIGN_STAGE) return d.ownerId === w.a.userId;
  // Этап 15: переводчика ждёт его язык, пока нет файла перевода (Г4).
  if (v.stage === 15 && (w.facts.get(v.id)?.pendingTranslators ?? []).includes(w.a.userId)) return true;
  // Только возврат (свой документ при другом начальнике ИБ) — не ждёт: ждут тех, кто может перевести дальше.
  return actionsOf(w, d).some((x) => x !== 'return');
}

/**
 * Какую версию пользователь видит. С ib.work — всё (рабочую, если есть). Без ib.work: рабочую — если она ждёт его
 * или он действовал по ней в текущем круге; иначе подписанную; архив и документы без подписанной версии — нет.
 */
function shownVersion(w: Who, d: DocRow): VersionRow | null {
  if (w.a.ibWork) return activeWorking(d) ?? d.workingVersion ?? d.approvedVersion;
  if (d.archivedAt) return null;
  const v = activeWorking(d);
  if (v && (waitsFor(w, d) || (w.acted.get(v.id) ?? []).includes(v.round) || isTranslator(w, v))) return v;
  return d.approvedVersion;
}

/** Переводчик языка этой версии (Г4): ему документ виден и без ib.work. */
const isTranslator = (w: Who, v: VersionRow) => (w.facts.get(v.id)?.translators ?? []).includes(w.a.userId);

const iso = (d: Date | null) => d?.toISOString() ?? null;
const isoDay = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

const pdfDto = (v: Pick<VersionRow, 'pdf'>) => (v.pdf ? { id: v.pdf.id, name: v.pdf.originalName, sha256: v.pdf.sha256, size: Number(v.pdf.size) } : null);

function versionDto(v: VersionRow) {
  return {
    id: v.id, no: v.no, edition: v.edition, title: v.title, onlyofficeUrl: v.onlyofficeUrl, changeNote: v.changeNote,
    stage: v.stage, stageName: stageName(v.stage), round: v.round, approvedAt: iso(v.approvedAt), createdAt: v.createdAt.toISOString(),
    signedOn: isoDay(v.signedOn),
    cancelledAt: iso(v.cancelledAt),
    /** Итоговый PDF версии; на маршруте 1.2.0 — подписанный. У утверждённой без него — «текст не зафиксирован». */
    pdf: pdfDto(v),
    textFrozen: v.pdf !== null,
  };
}

function toItem(w: Who, d: DocRow, shown: VersionRow, today: string) {
  const reviewDue = isoDay(d.reviewDue);
  const working = w.a.ibWork || shown === d.workingVersion ? activeWorking(d) : null;
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
    signedOn: isoDay(d.approvedVersion?.signedOn ?? null),
    reviewMonths: d.reviewMonths,
    reviewDue,
    status,
    statusName: DOC_STATUS_NAMES[status],
    /** Этап рабочей версии (если она видна): 11 «Драфт» … 16 «Подписание». */
    stage: working?.stage ?? null,
    stageName: working ? stageName(working.stage) : null,
    waitingForMe: waitsFor(w, d),
    /** Этап 14: ближайший срок несогласовавшего ответственного лица и просрочен ли он (сотрудникам ИБ). */
    partiesDue: working && w.a.ibWork ? (w.facts.get(working.id)?.nearestDue ?? null) : null,
    partiesOverdue: working && w.a.ibWork ? (w.facts.get(working.id)?.nearestDue ?? today) < today : false,
    openBlockers: working && w.a.ibWork ? (w.facts.get(working.id)?.openBlockers ?? 0) : 0,
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
  const rows = await db.document.findMany({ where: { ...where, deletedAt: null }, include: docInclude, orderBy: { number: 'asc' } });
  const working = rows.flatMap((d) => (d.workingVersionId ? [d.workingVersionId] : []));
  const who = await whoOf(db, a, a.ibWork ? [] : working, working);
  const out: { d: DocRow; shown: VersionRow }[] = [];
  for (const d of rows) {
    const shown = shownVersion(who, d);
    if (shown) out.push({ d, shown });
  }
  return { rows: out, who };
}

export async function listDocuments(db: Db, a: DocAccess, q: DocListQuery) {
  const today = todayIso();
  // Без ib.work архив не виден.
  if (q.archived && !a.ibWork) return { items: [], nextCursor: null, total: 0, archivedTotal: 0 };
  const { rows, who } = await loadVisible(db, a, { archivedAt: q.archived ? { not: null } : null, ...(q.typeId ? { typeId: q.typeId } : {}) });
  const needle = q.q?.trim().toLowerCase();
  const items = rows
    .map(({ d, shown }) => toItem(who, d, shown, today))
    .filter((x) => (!q.status || x.status === q.status) && (!q.waiting || x.waitingForMe) && (!needle || x.title.toLowerCase().includes(needle))
      && (!q.review || needsReview(x, today)))
    // Сначала то, что ждёт вас, затем просроченный пересмотр, дальше по названию.
    .sort((x, y) => Number(y.waitingForMe) - Number(x.waitingForMe)
      || Number(y.status === 'review_overdue') - Number(x.status === 'review_overdue')
      || x.title.localeCompare(y.title, 'ru'));
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const archivedTotal = a.ibWork ? await db.document.count({ where: { archivedAt: { not: null }, deletedAt: null } }) : 0;
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
  const { rows, who } = await loadVisible(db, a, { archivedAt: null });
  const waitingForMe = rows.filter(({ d }) => waitsFor(who, d)).length;
  const reviewOverdue = a.ibWork ? rows.filter(({ d }) => (isoDay(d.reviewDue) ?? today) < today).length : 0;
  return { waitingForMe, reviewOverdue };
}

// ---------------------------------------------------------------- карточка

/** Документ без удалённых: удалённый для всех — «не найден». */
async function getRow(db: Db, id: string) {
  const d = await db.document.findFirst({ where: { id, deletedAt: null }, include: docInclude });
  if (!d) throw notFound('Документ');
  return d;
}

export const HINTS: Record<number, string> = {
  11: `автор: владелец или право «${permName('docs.manage')}»`,
  12: 'автор или старший над автором; комментируют сотрудники ИБ',
  13: `право «${permName('docs.approve.head')}»`,
  14: `право «${permName('docs.approve.head')}»`,
  15: `право «${permName('docs.approve.head')}» или старший над автором`,
  16: `автор или право «${permName('docs.approve.head')}»`,
};

/** Решения, которыми этап пройден: кто перевёл документ дальше. */
const PASSED = ['submitted', 'approved', 'skipped', 'moved', 'signed'];

const FILE_KIND_NAMES: Record<string, string> = {
  draft: 'Файл драфта',
  head_approved: FIXED_FILE.approve?.name ?? '',
  final: FIXED_FILE.ack_final?.name ?? '',
};

export async function getDocument(db: Db, a: DocAccess, id: string) {
  const today = todayIso();
  const d = await getRow(db, id);
  const who = await whoOf(db, a, d.workingVersionId ? [d.workingVersionId] : []);
  const shown = shownVersion(who, d);
  if (!shown) throw notFound('Документ');
  const working = activeWorking(d);
  const workingShown = working !== null && shown === working;

  const allVersions = await db.documentVersion.findMany({ where: { documentId: id }, select: versionSelect, orderBy: { no: 'desc' } });
  const visibleVersions = allVersions.filter((v) => v.approvedAt !== null || a.ibWork || v.id === shown.id);
  const visibleIds = new Set(visibleVersions.map((v) => v.id));
  const history = await db.documentApproval.findMany({
    where: { documentId: id, versionId: { in: [...visibleIds] } },
    include: { actor: { select: { fullName: true } } },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
  });

  // Маршрут показанной версии: кто прошёл этапы в текущем круге. Версия старого маршрута — со старыми этапами.
  const legacy = shown.stage <= 3;
  const stages = legacy ? Object.keys(LEGACY_STAGE_NAMES).map(Number) : ROUTE.map((s) => s.stage);
  const roundActs = history.filter((h) => h.versionId === shown.id && h.round === shown.round && PASSED.includes(h.decision));
  const heads = legacy ? [] : (await db.user.findMany({ where: HEADS_WHERE, select: { fullName: true }, orderBy: { fullName: 'asc' } })).map((u) => u.fullName);
  const route = stages.map((stage) => {
    const act = roundActs.find((h) => h.stage === stage);
    const state = shown.approvedAt !== null || stage < shown.stage ? 'done' : stage === shown.stage ? 'current' : 'todo';
    const approvers = legacy ? [] : stage === 13 || stage === 14 || stage === 15 ? heads : [d.owner.fullName];
    return {
      stage, name: stageName(stage), state: state as 'done' | 'current' | 'todo',
      approvers, hint: legacy ? '' : HINTS[stage] ?? '',
      actedBy: act && act.decision !== 'skipped' ? act.actor.fullName : null, actedAt: act ? act.at.toISOString() : null,
      /** Этап пропущен (старый маршрут: согласовать мог только владелец). */
      skipped: act?.decision === 'skipped' ? act.comment : null,
      /** Этап 13 согласовал сам автор — начальник ИБ: другого согласующего не было. */
      selfApproved: act?.selfApproved ?? false,
    };
  });

  // Последнее решение по показанной версии — возврат: замечание видно в карточке и без права на историю (ADR-0021).
  const lastAct = history.find((h) => h.versionId === shown.id);
  const returned = lastAct?.decision === 'returned'
    ? { at: lastAct.at.toISOString(), actor: lastAct.actor.fullName, stageName: stageName(lastAct.stage), comment: lastAct.comment }
    : null;

  const translatorHere = workingShown && isTranslator(who, working);
  const [fileRows, commentRows, partyRows, blockerRows, translationRows] = await Promise.all([
    db.documentFile.findMany({
      where: { versionId: shown.id, removedAt: null, kind: { notIn: ['response', 'translation'] } },
      include: { file: { select: { id: true, originalName: true, sha256: true, size: true, mime: true } }, adder: { select: { fullName: true } } },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    }),
    a.ibWork
      ? db.documentComment.findMany({ where: { versionId: shown.id }, include: { author: { select: { fullName: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      : [],
    // Ответственные лица и блокеры (этап Г3) — сотрудникам ИБ.
    a.ibWork
      ? db.documentParty.findMany({
        where: { versionId: shown.id, removedAt: null },
        include: {
          user: { select: { id: true, fullName: true } },
          approver: { select: { fullName: true } },
          files: { where: { removedAt: null }, include: { file: { select: { id: true, originalName: true, sha256: true, size: true, mime: true } } }, orderBy: { addedAt: 'asc' } },
          deadlineChanges: { include: { actor: { select: { fullName: true } } }, orderBy: { at: 'desc' } },
        },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      })
      : [],
    a.ibWork
      ? db.documentBlocker.findMany({
        where: { versionId: shown.id },
        include: { opener: { select: { fullName: true } }, resolver: { select: { fullName: true } } },
        orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
      })
      : [],
    // Переводы (Г4) — сотрудникам ИБ и переводчикам этой версии.
    a.ibWork || translatorHere
      ? db.documentTranslation.findMany({
        where: { versionId: shown.id, removedAt: null },
        include: {
          translator: { select: { id: true, fullName: true } },
          files: { where: { removedAt: null }, include: { file: { select: { id: true, originalName: true, sha256: true, size: true, mime: true } } }, orderBy: { addedAt: 'asc' } },
          deadlineChanges: { include: { actor: { select: { fullName: true } } }, orderBy: { at: 'desc' } },
        },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      })
      : [],
  ]);

  const actions = workingShown ? actionsOf(who, d) : [];
  const roles = rolesOf(who, d);
  const author = roles.has('author');
  const active = d.archivedAt === null;
  const draft = workingShown && working.stage === FIRST_STAGE && author;
  const sign = workingShown && canSign(who, d);
  const can = {
    edit: draft,
    /** Действия маршрута (MOVES): кнопки карточки. */
    actions,
    sign,
    /** Файлы драфта (.docx, .pdf): добавить и снять — автор на этапе 11. */
    draftFiles: draft,
    /** Комментарии сотрудников — на этапе 12. */
    comment: workingShown && working.stage === 12 && a.ibWork,
    revise: active && d.approvedVersion !== null && working === null && author,
    /** Отменить пересмотр: рабочая версия уходит в историю, действующей остаётся подписанная (решение владельца 8). */
    cancelRevision: workingShown && d.approvedVersion !== null && (author || roles.has('head')),
    /** Мягкое удаление: только документ без подписанной версии (docs.delete). */
    delete: a.perms.has('docs.delete') && d.approvedVersion === null,
    /** Ответственные лица: ведут автор и начальник ИБ на этапах 11–14; согласование отмечают на этапе 14. */
    parties: workingShown && working.stage >= 11 && working.stage <= 14 && (author || roles.has('head')),
    approveParties: workingShown && working.stage === 14 && (author || roles.has('head')),
    /** Блокеры: автор, старшие над автором, начальник ИБ — на любом этапе маршрута. */
    blockers: workingShown && (author || roles.has('senior') || roles.has('head')),
    /** Переводы: языки ведут автор, старшие над автором и начальник ИБ на этапах 11–15. */
    translations: workingShown && working.stage >= 11 && working.stage <= 15 && (author || roles.has('senior') || roles.has('head')),
    manage: a.manage,
  };
  const stuck = workingShown && actions.length === 0 && !sign;
  // Шаг по роли есть, но не выполнено условие (блокеры, ответственные лица) — объяснить, что мешает.
  const gated = workingShown ? [...roleActions(who, d), ...(signRole(who, d) ? ['sign' as const] : [])].map((x) => gate(who, d, x)).find((g) => g !== null) ?? null : null;
  return {
    ...toItem(who, d, shown, today),
    current: versionDto(shown),
    working: workingShown ? versionDto(working) : null,
    approved: d.approvedVersion ? versionDto(d.approvedVersion) : null,
    route,
    can,
    /** Почему вы не можете действовать на текущем этапе (для подсказки в карточке). */
    blockedReason: gated ? gated.reason
      : !stuck ? null
      : working.stage === 13 && ownApprovalBlocked(who, d) && isHead(a)
        ? 'Свой документ согласует другой начальник ИБ: так сохраняется разделение полномочий'
        : `Этап «${stageName(working.stage)}» — ${HINTS[working.stage] ?? ''}`,
    returned,
    files: fileRows.map((f) => ({
      id: f.id, kind: f.kind as 'draft' | 'head_approved' | 'final', kindName: FILE_KIND_NAMES[f.kind] ?? f.kind, round: f.round,
      file: { id: f.file.id, name: f.file.originalName, sha256: f.file.sha256, size: Number(f.file.size), mime: f.file.mime },
      addedBy: f.adder.fullName, addedAt: f.addedAt.toISOString(),
      removable: draft && f.kind === 'draft',
    })),
    comments: commentRows.map((c) => ({ id: c.id, author: c.author.fullName, body: c.body, at: c.createdAt.toISOString() })),
    parties: partyRows.map((p) => {
      const due = isoDay(p.dueDate) ?? '';
      return {
        id: p.id, fullName: p.fullName, department: p.department, email: p.email, user: p.user, dueDate: due,
        overdue: p.approvedAt === null && due < today,
        approvedAt: iso(p.approvedAt), approvedBy: p.approver?.fullName ?? null, approveComment: p.approveComment,
        files: p.files.map((f) => ({
          id: f.id, file: { id: f.file.id, name: f.file.originalName, sha256: f.file.sha256, size: Number(f.file.size), mime: f.file.mime },
        })),
        deadlines: p.deadlineChanges.map((c) => ({ from: isoDay(c.fromDate) ?? '', to: isoDay(c.toDate) ?? '', comment: c.comment, actor: c.actor.fullName, at: c.at.toISOString() })),
      };
    }),
    translations: translationRows.map((t) => {
      const due = isoDay(t.dueDate) ?? '';
      const manager = author || roles.has('senior') || roles.has('head');
      return {
        id: t.id, language: t.language, translator: t.translator, dueDate: due,
        done: t.files.length > 0,
        overdue: t.files.length === 0 && due < today,
        files: t.files.map((f) => ({
          id: f.id, file: { id: f.file.id, name: f.file.originalName, sha256: f.file.sha256, size: Number(f.file.size), mime: f.file.mime },
        })),
        deadlines: t.deadlineChanges.map((c) => ({ from: isoDay(c.fromDate) ?? '', to: isoDay(c.toDate) ?? '', comment: c.comment, actor: c.actor.fullName, at: c.at.toISOString() })),
        /** Приложить и снять файл перевода — на этапе 15: переводчик, автор, старший над автором, начальник ИБ. */
        canUpload: workingShown && working.stage === 15 && (t.translatorId === a.userId || manager),
      };
    }),
    blockers: blockerRows.map((b) => ({
      id: b.id, text: b.text, openedBy: b.opener.fullName, openedAt: b.openedAt.toISOString(),
      resolvedAt: iso(b.resolvedAt), resolvedBy: b.resolver?.fullName ?? null, resolveComment: b.resolveComment,
    })),
    versions: visibleVersions.map((x) => ({
      no: x.no, edition: x.edition, title: x.title, onlyofficeUrl: x.onlyofficeUrl, approvedAt: iso(x.approvedAt), changeNote: x.changeNote,
      signedOn: isoDay(x.signedOn), cancelledAt: iso(x.cancelledAt),
      pdf: pdfDto(x), textFrozen: x.pdf !== null,
    })),
    // Подробная история — по праву «История в карточках» (ADR-0021); блок маршрута (route) — всем, кто видит документ.
    history: !a.perms.has('history.view') ? [] : history.map((h) => ({
      id: h.id, at: h.at.toISOString(),
      // Перенос при обновлении сделала система, а не владелец документа (actor_id обязателен).
      actor: h.decision === 'migrated' ? 'Система' : h.actor.fullName,
      stage: h.stage, stageName: stageName(h.stage),
      toStage: h.toStage, toStageName: h.toStage !== null ? stageName(h.toStage) : null,
      decision: h.decision as HistoryDecision, comment: h.comment, versionNo: h.versionNo, round: h.round,
      pdfSha256: h.pdfSha256, selfApproved: h.selfApproved,
    })),
  };
}

export const HISTORY_DECISIONS = ['submitted', 'approved', 'returned', 'revision_started', 'skipped', 'moved', 'signed', 'migrated', 'cancelled'] as const;
type HistoryDecision = (typeof HISTORY_DECISIONS)[number];

/** Видит ли пользователь версию (для выдачи её файлов): те же правила, что у списка версий карточки. */
export async function versionVisible(db: Db, a: DocAccess, versionId: string): Promise<boolean> {
  const v = await db.documentVersion.findUnique({ where: { id: versionId }, select: { documentId: true, approvedAt: true } });
  if (!v) return false;
  const d = await db.document.findFirst({ where: { id: v.documentId, deletedAt: null }, include: docInclude });
  if (!d) return false;
  const shown = shownVersion(await whoOf(db, a, d.workingVersionId ? [d.workingVersionId] : []), d);
  if (!shown) return false;
  return a.ibWork || v.approvedAt !== null || shown.id === versionId;
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

export const forbiddenWith = (code: string, reason: string) => new AppError(403, code, reason);

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

/** Создать документ (право docs.manage проверяет маршрут): версия 1 на этапе «Драфт». */
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
    await tx.documentVersion.create({ data: { id: versionId, documentId: id, no: 1, edition, title, onlyofficeUrl, changeNote, stage: FIRST_STAGE, createdBy: actor.id } });
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
 * Правка: содержимое (название, редакция, ссылка, что изменено) — только на этапе «Драфт»,
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
      const w = activeWorking(d);
      if (!w) throw conflict('DOC_APPROVED', 'Подписанная версия не меняется. Создайте новую версию — она пройдёт маршрут заново');
      if (w.stage !== FIRST_STAGE) throw conflict('DOC_IN_ROUTE', `Документ на этапе «${stageName(w.stage)}». Изменить его можно после возврата на доработку`);
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
        // Дата пересмотра — от даты подписания (до 1.2.0 — утверждения) действующей версии.
        if (d.approvedVersion?.approvedAt) {
          const due = addMonthsIso(isoDay(d.approvedVersion.signedOn) ?? todayIso(d.approvedVersion.approvedAt), m);
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

export interface MoveInput {
  version: number;
  /** Этап, который пользователь видел на экране: если документ уже на другом этапе — 409. */
  stage: number;
  comment?: string;
  /** 13 → 14 и 14 → 15: файл версии (pdf или docx), загруженный через POST /files. */
  fileId?: string;
}

const PDF_MIME = [MIME_BY_EXT.pdf];
const VERSION_FILE_MIME = [MIME_BY_EXT.pdf, MIME_BY_EXT.docx];

/** Общее для действий: свежие права, версия документа, текущий этап. Захватывает документ (version + 1). */
export async function routeContext(tx: Db, actor: Actor, id: string, input: { version: number; stage: number }) {
  const a = await accessOf(tx, actor.id);
  const d = await getRow(tx, id);
  if (d.archivedAt) throw conflict('DOC_ARCHIVED', 'Документ в архиве. Верните его из архива, чтобы продолжить');
  const w = activeWorking(d);
  if (!w) throw conflict('NOT_IN_ROUTE', 'Документ не на согласовании. Обновите страницу');
  if (d.version !== input.version) throw versionConflict();
  if (w.stage !== input.stage) throw conflict('STAGE_CHANGED', `Документ уже на этапе «${stageName(w.stage)}». Обновите страницу`);
  const who = await whoOf(tx, a, [w.id]);
  // Захватить документ: параллельное действие с той же версией получит 409.
  const res = await tx.document.updateMany({ where: { id, version: input.version }, data: { version: { increment: 1 } } });
  if (res.count === 0) throw versionConflict();
  return { a, d, w, who };
}

async function addDecision(tx: Db, data: Prisma.DocumentApprovalUncheckedCreateInput) {
  try {
    await withTx(tx, (t) => t.documentApproval.create({ data }));
  } catch (err) {
    if (isUniqueViolation(err)) throw versionConflict();
    throw err;
  }
}

export function cleanComment(v: string | undefined, required: string | null): string {
  const c = (v ?? '').trim();
  if (!c && required) throw badRequest('EMPTY_COMMENT', required);
  if (c.length > COMMENT_MAX) throw badRequest('TOO_LONG', `Комментарий — не длиннее ${COMMENT_MAX} символов`);
  return c;
}

/** Почему действие недоступно (403): по ролям этапа. */
function moveDenied(action: DocAction, who: Who, d: DocRow): AppError {
  if (action === 'approve' && ownApprovalBlocked(who, d) && isHead(who.a)) {
    return forbiddenWith('SEPARATION_OF_DUTIES', `Свой документ согласует другой пользователь с правом «${permName('docs.approve.head')}»: так сохраняется разделение полномочий`);
  }
  if (MOVES[action].who.includes('head') && who.a.superAdmin && who.a.perms.has('docs.approve.head')) {
    return forbiddenWith('SEPARATION_OF_DUTIES', 'Супер-администратор не согласует документы: так сохраняется разделение полномочий');
  }
  return forbiddenWith('FORBIDDEN', `«${MOVES[action].label}» — ${HINTS[MOVES[action].from[0] as number] ?? ''}`);
}

/**
 * Действие маршрута (status.ts, MOVES). Возврат — на «Драфт» с комментарием: новый круг, владельцу — задача.
 * 13 → 14 и 14 → 15 фиксируют файл версии; 11 → 12 закрывает задачу доработки.
 */
export async function moveDocument(db: Db, actor: Actor, id: string, action: DocAction, input: MoveInput) {
  return withTx(db, async (tx) => {
    const rule = MOVES[action];
    const comment = cleanComment(input.comment, action === 'return' ? 'Напишите, что нужно исправить' : null);
    const { d, w, who } = await routeContext(tx, actor, id, input);
    if (!rule.from.includes(w.stage)) throw conflict('WRONG_STAGE', `«${rule.label}» — не на этапе «${stageName(w.stage)}». Обновите страницу`);
    if (!roleActions(who, d).includes(action)) throw moveDenied(action, who, d);
    const blocked = gate(who, d, action);
    if (blocked) throw conflict(blocked.code, blocked.reason);

    const fixed = FIXED_FILE[action];
    let sha256: string | null = null;
    if (fixed) {
      if (!input.fileId) throw badRequest('FILE_REQUIRED', `Приложите файл: ${fixed.name.toLowerCase()} (pdf или docx)`);
      const [f] = await claimFiles(tx, actor.id, [input.fileId], { mimes: VERSION_FILE_MIME, what: fixed.name });
      if (!f) throw badRequest('FILE_REQUIRED', `Приложите файл: ${fixed.name.toLowerCase()}`);
      try {
        await withTx(tx, (t) => t.documentFile.create({ data: { documentId: id, versionId: w.id, round: w.round, kind: fixed.kind, fileId: f.id, addedBy: actor.id } }));
      } catch (err) {
        if (isUniqueViolation(err)) throw versionConflict();
        throw err;
      }
      sha256 = f.sha256;
    }

    const selfApproved = action === 'approve' && d.ownerId === actor.id;
    const decision = action === 'return' ? 'returned' : fixed ? 'approved' : 'moved';
    await addDecision(tx, {
      documentId: id, versionId: w.id, versionNo: w.no, round: w.round, stage: w.stage, toStage: rule.to,
      decision, comment, actorId: actor.id, pdfSha256: sha256, selfApproved,
    });
    const back = action === 'return';
    await tx.documentVersion.update({ where: { id: w.id }, data: { stage: rule.to, ...(back ? { round: w.round + 1 } : {}) } });

    if (back) {
      const who = (await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { fullName: true } })).fullName;
      await documentTask(tx, {
        documentId: id,
        reason: 'returned',
        title: `Доработать документ «${w.title}»`,
        description: `Документ #${d.number}, версия ${w.no}. ${who} вернул(а) его на доработку с этапа «${stageName(w.stage)}»:\n${comment}\n\nПосле правки отправьте документ на проверку сотрудникам заново.`,
        repeatComment: `Повторный возврат с этапа «${stageName(w.stage)}» (${who}): ${comment}`,
        workdays: 3,
      });
    }
    if (action === 'to_review') await closeDocumentTasks(tx, id, 'returned', `Документ отправлен на проверку сотрудникам (версия ${w.no})`);
    const ref = { id, number: d.number, title: w.title, ownerId: d.ownerId };
    if (back) await notifyReturned(tx, ref, actor.id, stageName(w.stage), comment);
    else await notifyStage(tx, ref, w.id, rule.to, actor.id);

    const self = selfApproved ? ' — согласовано автором (начальник ИБ), без независимого согласования' : '';
    await auditSettings(tx, actor, {
      action: back ? 'document.returned' : 'document.moved', entity: 'document', entityId: id,
      summary: back
        ? `Документ #${d.number} «${w.title}» (версия ${w.no}) возвращён на доработку с этапа «${stageName(w.stage)}»`
        : `Документ #${d.number} «${w.title}» (версия ${w.no}): «${rule.label}» («${stageName(w.stage)}» → «${stageName(rule.to)}»)${self}`,
      after: { action, versionNo: w.no, round: w.round, from: w.stage, to: rule.to, comment, fileSha256: sha256, selfApproved },
    });
  });
}

export interface SignInput {
  version: number;
  stage: number;
  /** Подписанный PDF (POST /files). */
  fileId: string;
  /** Дата подписания YYYY-MM-DD: не позже сегодня. От неё — дата пересмотра. */
  signedOn: string;
}

/** Этап 16: подписанный PDF и дата подписания — версия становится действующей; пересмотр — от даты подписания. */
export async function signDocument(db: Db, actor: Actor, id: string, input: SignInput) {
  return withTx(db, async (tx) => {
    const today = todayIso();
    const parsed = new Date(`${input.signedOn}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.signedOn) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input.signedOn) {
      throw badRequest('BAD_DATE', 'Укажите дату подписания');
    }
    if (input.signedOn > today) throw badRequest('BAD_DATE', 'Дата подписания — не позже сегодняшнего дня');
    const { d, w, who } = await routeContext(tx, actor, id, input);
    if (w.stage !== SIGN_STAGE) throw conflict('WRONG_STAGE', `Подписать можно на этапе «${stageName(SIGN_STAGE)}». Обновите страницу`);
    if (!signRole(who, d)) throw forbiddenWith('FORBIDDEN', `Подписанный PDF загружает ${HINTS[SIGN_STAGE]}`);
    const blocked = gate(who, d, 'sign');
    if (blocked) throw conflict(blocked.code, blocked.reason);
    const [f] = await claimFiles(tx, actor.id, [input.fileId], { mimes: PDF_MIME, what: 'Подписанный PDF' });
    if (!f) throw badRequest('PDF_REQUIRED', 'Приложите подписанный PDF');
    const now = new Date();
    const due = addMonthsIso(input.signedOn, d.reviewMonths);
    await tx.documentVersion.update({ where: { id: w.id }, data: { pdfFileId: f.id, approvedAt: now, signedOn: new Date(`${input.signedOn}T00:00:00Z`) } });
    if (w.pdfFileId && w.pdfFileId !== f.id) await deleteIfUnreferenced(tx, actor, w.pdfFileId, `версия ${w.no} подписана, прежний итоговый PDF заменён подписанным`);
    await tx.document.update({ where: { id }, data: { approvedVersionId: w.id, workingVersionId: null, reviewDue: new Date(`${due}T00:00:00Z`) } });
    await addDecision(tx, {
      documentId: id, versionId: w.id, versionNo: w.no, round: w.round, stage: SIGN_STAGE, decision: 'signed',
      comment: `Подписан ${formatDateRu(input.signedOn)}`, actorId: actor.id, pdfSha256: f.sha256,
    });
    await closeDocumentTasks(tx, id, 'review', `Версия ${w.no} подписана, следующий пересмотр — до ${formatDateRu(due)}`);
    await auditSettings(tx, actor, {
      action: 'document.signed', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}» (версия ${w.no}) подписан ${formatDateRu(input.signedOn)}, пересмотр до ${formatDateRu(due)}`,
      after: { versionNo: w.no, round: w.round, signedOn: input.signedOn, reviewDue: due, pdfSha256: f.sha256 },
    });
  });
}

/** Отменить пересмотр (автор или начальник ИБ, с комментарием): версия остаётся в истории как отменённая. */
export async function cancelRevision(db: Db, actor: Actor, id: string, input: { version: number; comment: string }) {
  return withTx(db, async (tx) => {
    const comment = cleanComment(input.comment, 'Напишите, почему пересмотр отменяется');
    const a = await accessOf(tx, actor.id);
    const d = await getRow(tx, id);
    if (d.version !== input.version) throw versionConflict();
    if (d.archivedAt) throw conflict('DOC_ARCHIVED', 'Документ в архиве. Верните его из архива, чтобы продолжить');
    const w = activeWorking(d);
    if (!w || !d.approvedVersion) throw conflict('NO_REVISION', 'Пересмотр не идёт: отменять нечего. Обновите страницу');
    const roles = rolesOf(await whoOf(tx, a, []), d);
    if (!roles.has('author') && !roles.has('head')) {
      throw forbiddenWith('FORBIDDEN', `Пересмотр отменяет автор (владелец или право «${permName('docs.manage')}») или пользователь с правом «${permName('docs.approve.head')}»`);
    }
    const res = await tx.document.updateMany({ where: { id, version: input.version }, data: { workingVersionId: null, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    await tx.documentVersion.update({ where: { id: w.id }, data: { cancelledAt: new Date() } });
    await addDecision(tx, { documentId: id, versionId: w.id, versionNo: w.no, round: w.round, stage: w.stage, decision: 'cancelled', comment, actorId: actor.id });
    await closeDocumentTasks(tx, id, 'returned', `Пересмотр отменён (версия ${w.no})`);
    await auditSettings(tx, actor, {
      action: 'document.revision_cancelled', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: пересмотр отменён, версия ${w.no} — в истории; действующая — ${d.approvedVersion.no}`,
      after: { versionNo: w.no, stage: w.stage, comment, approvedVersionNo: d.approvedVersion.no },
    });
  });
}

/** Файлы драфта (pdf, docx): добавляет и снимает автор на этапе 11. */
export async function addDraftFiles(db: Db, actor: Actor, id: string, input: { version: number; stage: number; fileIds: string[] }) {
  return withTx(db, async (tx) => {
    const { d, w, who } = await routeContext(tx, actor, id, input);
    if (w.stage !== FIRST_STAGE || !rolesOf(who, d).has('author')) {
      throw forbiddenWith('FORBIDDEN', `Файлы драфта прикладывает ${HINTS[FIRST_STAGE]} на этапе «${stageName(FIRST_STAGE)}»`);
    }
    const files = await claimFiles(tx, actor.id, input.fileIds, { mimes: VERSION_FILE_MIME, what: 'Файл драфта' });
    if (!files.length) throw badRequest('FILE_REQUIRED', 'Выберите файл');
    await tx.documentFile.createMany({ data: files.map((f) => ({ documentId: id, versionId: w.id, round: w.round, kind: 'draft', fileId: f.id, addedBy: actor.id })) });
    await auditSettings(tx, actor, {
      action: 'document.files_added', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}» (версия ${w.no}): файлы драфта — ${files.map((f) => `«${f.originalName}»`).join(', ')}`,
      after: { versionNo: w.no, files: files.map((f) => ({ id: f.id, name: f.originalName, sha256: f.sha256 })) },
    });
  });
}

export async function removeDraftFile(db: Db, actor: Actor, id: string, linkId: string, input: { version: number; stage: number }) {
  return withTx(db, async (tx) => {
    const { d, w, who } = await routeContext(tx, actor, id, input);
    if (w.stage !== FIRST_STAGE || !rolesOf(who, d).has('author')) {
      throw forbiddenWith('FORBIDDEN', `Файлы драфта снимает ${HINTS[FIRST_STAGE]} на этапе «${stageName(FIRST_STAGE)}»`);
    }
    const link = await tx.documentFile.findFirst({ where: { id: linkId, versionId: w.id, kind: 'draft', removedAt: null }, include: { file: { select: { originalName: true } } } });
    if (!link) throw notFound('Файл драфта');
    await tx.documentFile.update({ where: { id: link.id }, data: { removedAt: new Date(), removedBy: actor.id } });
    await deleteIfUnreferenced(tx, actor, link.fileId, `снят с драфта документа #${d.number}`);
    await auditSettings(tx, actor, {
      action: 'document.file_removed', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}» (версия ${w.no}): снят файл драфта «${link.file.originalName}»`,
      after: { versionNo: w.no, fileId: link.fileId },
    });
  });
}

/** Комментарий сотрудника ИБ на этапе 12 «Проверка сотрудниками». Документ не меняется (версия та же). */
export async function addDocumentComment(db: Db, actor: Actor, id: string, input: { body: string }) {
  return withTx(db, async (tx) => {
    const body = cleanComment(input.body, 'Напишите комментарий');
    const a = await accessOf(tx, actor.id);
    if (!a.ibWork) throw forbiddenWith('FORBIDDEN', 'Комментируют сотрудники ИБ');
    const d = await getRow(tx, id);
    const w = activeWorking(d);
    if (!w || w.stage !== 12) throw conflict('WRONG_STAGE', `Комментарии — на этапе «${stageName(12)}». Обновите страницу`);
    const c = await tx.documentComment.create({ data: { documentId: id, versionId: w.id, authorId: actor.id, body } });
    await notifyDocComment(tx, { id, number: d.number, title: w.title, ownerId: d.ownerId }, actor.id, body);
    await auditSettings(tx, actor, {
      action: 'document.commented', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}» (версия ${w.no}): комментарий`,
      after: { commentId: c.id, versionNo: w.no },
    });
  });
}

/**
 * Мягкое удаление (docs.delete проверяет маршрут): только документ без подписанной версии. Удалённый пропадает
 * отовсюду, файлы не удаляются; он ещё и в архиве — так его не покажет и backend 1.1.0 после отката.
 */
export async function deleteDocument(db: Db, actor: Actor, id: string, input: { version: number; comment?: string }) {
  return withTx(db, async (tx) => {
    const comment = cleanComment(input.comment, null);
    const d = await getRow(tx, id);
    if (d.version !== input.version) throw versionConflict();
    if (d.approvedVersion) throw conflict('DOC_SIGNED', 'У документа есть подписанная версия — его можно только отправить в архив');
    const now = new Date();
    const res = await tx.document.updateMany({
      where: { id, version: input.version, deletedAt: null },
      data: { deletedAt: now, deletedBy: actor.id, archivedAt: d.archivedAt ?? now, version: { increment: 1 } },
    });
    if (res.count === 0) throw versionConflict();
    const title = (d.workingVersion ?? d.approvedVersion)?.title ?? '';
    await closeDocumentTasks(tx, id, 'returned', 'Документ удалён');
    await auditSettings(tx, actor, {
      action: 'document.deleted', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${title}» удалён${comment ? `: ${comment}` : ''}`,
      after: { comment },
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
 * Новая версия подписанного документа (правка или пересмотр без изменений): копия действующей версии
 * на этапе «Драфт». Подписанные версии остаются в истории без изменений.
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
        stage: FIRST_STAGE,
        createdBy: actor.id,
      },
    });
    const res = await tx.document.updateMany({ where: { id, version: input.version }, data: { workingVersionId: v.id, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    await addDecision(tx, { documentId: id, versionId: v.id, versionNo: no, round: 1, stage: FIRST_STAGE, decision: 'revision_started', toStage: FIRST_STAGE, comment: v.changeNote, actorId: actor.id });
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
