// Документы (этап 6, ADR-0010; маршрут 1.11.0 — ADR-0042, до него 1.2.0 — ADR-0024): реестр документов ИБ, версии, маршрут, пересмотр.
// Права: маршруты пускают любого вошедшего (requireAuth), а кто что может — решает этот сервис (status.ts, MOVES):
// автор — владелец или docs.manage; старший — над владельцем (ADR-0020); начальник ИБ — пользователь с отметкой
// «Является начальником ИБ» (1.4.0, ADR-0027; одна на портал, супер-администратору не ставится). Свой документ
// начальник ИБ одобряет сам — другого начальника ИБ не бывает — с отметкой «без независимого согласования».
// Без ib.work видны только подписанные документы, «ждёт вас» и те, где вы действовали в текущем круге.
// Файлы — только на этапе 24 (подписанный PDF, исходный .docx, .docx переводов); на 21–23 документ — ссылка OnlyOffice.
import { randomUUID } from 'node:crypto';
import { workUsersWhere } from '../../lib/work-users.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { DOCUMENT_TYPES_CATALOG } from '../../lib/catalogs.js';
import { withTx, isUniqueViolation, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { MIME_BY_EXT } from '../../lib/file-type.js';
import { seniorIdsOf, subordinateIdsOf } from '../../lib/hierarchy.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { formatDateRu } from '../../lib/register-values.js';
import { claimFiles, deleteIfUnreferenced } from '../files/links.js';
import { todayIso } from '../../lib/today.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { notifyDocComment, notifyReturned } from './notify.js';
import { notify } from '../notifications/service.js';
import { closeDocumentTasks, closeTasks, createStageTask, documentTask, moveStageTaskDue, OWNER_LABEL, setTaskCandidates } from './tasks.js';
import { readPortalParam } from '../settings/portal-params.js';
import { addWorkingDays, isoDate, parseIsoDate } from '../../lib/working-days.js';
import { loadFullWorkCalendar } from '../calendar/service.js';
import {
  addMonthsIso, compareTypes, DEFAULT_REVIEW_MONTHS, DOC_STAGE_DAYS_KEY, docComparator, docStatus, dueMatches, stageState, stageTaskDescription, stageTaskText, FIRST_STAGE, inRoute, isDocUrl, LEGACY_STAGE_NAMES, MOVES, needsReview,
  PARTIES_STAGE, placeName, RETURN_ACTIONS, ROUTE, ROUTE_V2_NAMES, SIGN_STAGE, STATE_NAMES, stageDaysKey, stageHolders, stageName, stateOf, TRANSLATION_STAGE, allowedActions, DOC_STATUS_NAMES,
  type DocAction, type DocRole, type DocStatus, type DocDueFilter, type DocSort, type HolderCtx, type Holders, type Person, type RouteState, type StageDays, type StageTaskRole,
} from './status.js';

export const TITLE_MAX = 300;
export const EDITION_MAX = 20;
export const NOTE_MAX = 4000;
export const COMMENT_MAX = 4000;
export const URL_MAX = 2000;
export const LIST_LIMIT = 500;

/** Участвующие в работе (ADR-0036): активные сотрудники ИБ, без служебных учётных записей. */
const WORK_USER = workUsersWhere();

// ---------------------------------------------------------------- кто что может

export interface DocAccess {
  userId: string;
  perms: ReadonlySet<string>;
  /** Есть роль «Супер-администратор» (в сумме с любыми другими ролями). */
  superAdmin: boolean;
  ibWork: boolean;
  manage: boolean;
  /** Отметка «Является начальником ИБ» (1.4.0): этапы и действия начальника ИБ. */
  ibHead: boolean;
}

/** Права читаются из БД в той же транзакции, что и действие: снятая минуту назад роль уже не действует. */
export async function accessOf(db: Db, userId: string): Promise<DocAccess> {
  const [links, user] = await Promise.all([
    db.userRole.findMany({
      where: { userId, user: { isActive: true } },
      select: { role: { select: { code: true, permissions: { select: { permissionCode: true } } } } },
    }),
    db.user.findUnique({ where: { id: userId }, select: { isActive: true, isIbHead: true } }),
  ]);
  const perms = new Set(links.flatMap((l) => l.role.permissions.map((p) => p.permissionCode)));
  return {
    userId,
    perms,
    superAdmin: links.some((l) => l.role.code === 'super_admin'),
    ibWork: perms.has('ib.work'),
    manage: perms.has('docs.manage'),
    ibHead: user?.isActive === true && user.isIbHead,
  };
}

/**
 * Взгляд отдела ИБ на реестр документов (дашборд и мониторинг, этап 8): все неархивные документы,
 * без «моих» согласований. Пользователь-заглушка: результат одинаков для всех, кому он виден, и кэшируется.
 */
export const DEPARTMENT_VIEW: DocAccess = {
  userId: '00000000-0000-0000-0000-000000000000', perms: new Set(['ib.work']), superAdmin: false, ibWork: true, manage: false, ibHead: false,
};

const permName = (code: string) => PERMISSIONS.find((p) => p.code === code)?.name ?? code;

const versionSelect = {
  id: true, no: true, edition: true, title: true, onlyofficeUrl: true, changeNote: true, stage: true, round: true,
  approvedAt: true, signedOn: true, cancelledAt: true, createdAt: true, pdfFileId: true,
  routeState: true, sourceDocxFileId: true, orderNo: true, orderDate: true,
  pdf: { select: { id: true, originalName: true, sha256: true, size: true } },
  sourceDocx: { select: { id: true, originalName: true, sha256: true, size: true } },
} as const;
const docInclude = {
  type: { select: { id: true, value: true } },
  owner: { select: { id: true, fullName: true, isActive: true } },
  approvedVersion: { select: versionSelect },
  workingVersion: { select: versionSelect },
} as const;
export type DocRow = Prisma.DocumentGetPayload<{ include: typeof docInclude }>;
type VersionRow = NonNullable<DocRow['workingVersion']>;

/** Условия переходов по версии: ответственные лица этапа 22, переводы этапа 23, файлы этапа 24, открытые блокеры. */
export interface RouteFacts {
  parties: number;
  /** Лица, которые ещё не согласовали. */
  pending: number;
  /** Ближайший срок несогласовавшего лица (YYYY-MM-DD). */
  nearestDue: string | null;
  openBlockers: number;
  /** Этап 23: языки перевода и сколько из них без ссылки OnlyOffice. */
  translations: number;
  missingTranslations: number;
  /** Языки без ссылки и ближайший срок среди них — задача автору на этапе 23. */
  missingLanguages: string[];
  translationDue: string | null;
  /** Этап 24: языки без Word перевода (обязателен, решение владельца 6). */
  translationsWithoutDocx: string[];
}
const NO_FACTS: RouteFacts = {
  parties: 0, pending: 0, nearestDue: null, openBlockers: 0, translations: 0, missingTranslations: 0, missingLanguages: [], translationDue: null, translationsWithoutDocx: [],
};

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
    // Перевод готов, когда есть ссылка OnlyOffice (1.11.0; файлы перевода — только на этапе 24).
    db.$queryRaw<{ version_id: string; has_link: boolean; has_docx: boolean; language: string; due: Date }[]>`
      SELECT t.version_id::text, t.language, t.due_date AS due, t.onlyoffice_url <> '' AS has_link, t.source_docx_file_id IS NOT NULL AS has_docx
      FROM document_translations t WHERE t.version_id = ANY(${ids}::uuid[]) AND t.removed_at IS NULL ORDER BY t.added_at, t.id`,
  ]);
  const get = (id: string) => map.get(id) ?? { ...NO_FACTS };
  for (const p of parties) map.set(p.version_id, { ...get(p.version_id), parties: Number(p.total), pending: Number(p.pending), nearestDue: p.due?.toISOString().slice(0, 10) ?? null });
  for (const b of blockers) map.set(b.version_id, { ...get(b.version_id), openBlockers: Number(b.open) });
  for (const t of translations) {
    const f = get(t.version_id);
    const due = t.due.toISOString().slice(0, 10);
    map.set(t.version_id, {
      ...f,
      translations: f.translations + 1,
      missingTranslations: f.missingTranslations + (t.has_link ? 0 : 1),
      translationsWithoutDocx: t.has_docx ? f.translationsWithoutDocx : [...f.translationsWithoutDocx, t.language],
      ...(t.has_link ? {} : {
        missingLanguages: [...f.missingLanguages, t.language],
        translationDue: f.translationDue === null || due < f.translationDue ? due : f.translationDue,
      }),
    });
  }
  return map;
}

/** Пользователь, для которого считаются действия: права и его подчинённые. */
interface Who {
  a: DocAccess;
  subordinates: ReadonlySet<string>;
  /** Версии, по которым пользователь принимал решения, и в каких кругах. */
  acted: ReadonlyMap<string, readonly number[]>;
  /** Условия переходов по рабочим версиям. */
  facts: ReadonlyMap<string, RouteFacts>;
  /** Кто действует на текущем этапе («Сейчас у», шаг 5 релиза 1.4.0) — по документам, переданным в whoOf. */
  holders: ReadonlyMap<string, Holders>;
  /** Из чего считаны holders: для «кто действует» под каждым этапом карточки. */
  holderCtx: ReadonlyMap<string, HolderCtx>;
}

/** Начальник ИБ — по отметке; супер-администратору её не ставят (409), проверка здесь — на случай испорченных данных. */
const isHead = (a: DocAccess) => a.ibHead && !a.superAdmin;

const HEADS_WHERE: Prisma.UserWhereInput = { isActive: true, isIbHead: true };

/**
 * docs — документы, для которых нужны «Сейчас у» и «ждут вас» (stageHolders). Старшие над владельцем запрашиваются
 * только там, где они действуют (этап 15 без переводов в работе) или для всего маршрута карточки (allStages).
 */
async function whoOf(
  db: Db, a: DocAccess, versionIds: readonly string[], factIds: readonly string[] = versionIds,
  docs: readonly DocRow[] = [], allStages = false,
): Promise<Who> {
  const [subs, rows, facts] = await Promise.all([
    subordinateIdsOf(db, a.userId),
    versionIds.length
      ? db.documentApproval.findMany({ where: { actorId: a.userId, versionId: { in: [...versionIds] }, decision: { not: 'migrated' } }, select: { versionId: true, round: true } })
      : [],
    routeFacts(db, [...new Set([...factIds, ...docs.flatMap((d) => (d.workingVersionId ? [d.workingVersionId] : []))])]),
  ]);
  const acted = new Map<string, number[]>();
  for (const r of rows) acted.set(r.versionId, [...(acted.get(r.versionId) ?? []), r.round]);
  const { holders, ctx } = await holdersOf(db, docs, facts, allStages);
  return { a, subordinates: new Set(subs), acted, facts, holders, holderCtx: ctx };
}

/** «Сейчас у» по документам: начальник ИБ (одна отметка), старшие над владельцем; переводы — есть ли язык без файла. */
async function holdersOf(db: Db, docs: readonly DocRow[], facts: ReadonlyMap<string, RouteFacts>, allStages: boolean) {
  const holders = new Map<string, Holders>();
  const ctx = new Map<string, HolderCtx>();
  const live = docs.flatMap((d) => {
    const v = activeWorking(d);
    return v || allStages ? [{ d, v, f: (v && facts.get(v.id)) || NO_FACTS }] : [];
  });
  if (!live.length) return { holders, ctx };
  // Старшие над владельцем в маршруте 1.11.0 не действуют (только блокеры): нужны лишь для карточки.
  const needSeniors = new Set(live.filter(() => allStages).map(({ d }) => d.ownerId));
  const owners = [...needSeniors];
  const [head, seniorLists] = await Promise.all([
    db.user.findFirst({ where: HEADS_WHERE, select: { id: true, fullName: true } }),
    Promise.all(owners.map((o) => seniorIdsOf(db, o))),
  ]);
  const seniorIds = new Map(owners.map((o, i) => [o, seniorLists[i] ?? []]));
  const peopleIds = [...new Set([...seniorIds.values()].flat())];
  const people = peopleIds.length
    ? await db.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, fullName: true, isActive: true } })
    : [];
  const person = (id: string): Person | null => {
    const u = people.find((x) => x.id === id);
    return u ? { id: u.id, fullName: u.fullName, ...(u.isActive ? {} : { inactive: true }) } : null;
  };
  for (const { d, v } of live) {
    const c: HolderCtx = {
      // Отключённый автор остаётся в «Сейчас у» с пометкой: документ ждёт, пока владельца не сменят.
      owner: { id: d.owner.id, fullName: d.owner.fullName, ...(d.owner.isActive ? {} : { inactive: true }) },
      head: head ? { id: head.id, fullName: head.fullName } : null,
      // Старшие — только активные: отключённый не переведёт документ дальше.
      seniors: (seniorIds.get(d.ownerId) ?? []).flatMap((id) => (people.find((x) => x.id === id)?.isActive ? [person(id) as Person] : [])),
    };
    ctx.set(d.id, c);
    if (v) holders.set(d.id, stageHolders(v.stage, stateOf(v), c));
  }
  return { holders, ctx };
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


/** Действия маршрута по ролям пользователя (без условий данных). Версия не на маршруте 1.11.0 — действий нет. */
function roleActions(w: Who, d: DocRow): DocAction[] {
  const v = activeWorking(d);
  if (!v || !inRoute(v.stage)) return [];
  return allowedActions(v.stage, stateOf(v), rolesOf(w, d));
}

/**
 * Почему переход вперёд сейчас невозможен по данным; null — можно. Открытый блокер останавливает любой шаг вперёд
 * и «Утвердить»; кнопки этапа 22 — только когда все ответственные лица (хотя бы одно) отметили согласование;
 * 23 → 24 — когда у каждого языка есть ссылка; «Утвердить» — с PDF и .docx основного языка и .docx каждого перевода.
 */
function gate(w: Who, d: DocRow, action: DocAction | 'sign'): { code: string; reason: string } | null {
  const v = activeWorking(d);
  if (!v || (action !== 'sign' && RETURN_ACTIONS.includes(action))) return null;
  const f = w.facts.get(v.id) ?? NO_FACTS;
  if (f.openBlockers > 0) return { code: 'BLOCKERS_OPEN', reason: `Открытых блокеров: ${f.openBlockers}. Снимите их, чтобы двигать документ дальше` };
  if (action === 'request_recheck' || action === 'to_translation') {
    if (f.parties === 0) return { code: 'NO_PARTIES', reason: 'Добавьте ответственных лиц и отметьте их согласование' };
    if (f.pending > 0) return { code: 'PARTIES_PENDING', reason: `Не все ответственные лица согласовали: осталось ${f.pending}` };
  }
  if (action === 'to_approval' && f.missingTranslations > 0) {
    return { code: 'TRANSLATION_LINK_MISSING', reason: `Не у всех языков есть ссылка на перевод: ${f.missingLanguages.join(', ')}` };
  }
  if (action === 'sign') {
    const missing = [...(v.pdfFileId ? [] : ['подписанный PDF']), ...(v.sourceDocxFileId ? [] : ['исходный документ Word']), ...f.translationsWithoutDocx.map((l) => `Word перевода (${l})`)];
    if (missing.length) return { code: 'APPROVAL_FILES_REQUIRED', reason: `Загрузите: ${missing.join(', ')}` };
  }
  return null;
}

/** Действия маршрута, доступные пользователю сейчас: по ролям и по данным. */
function actionsOf(w: Who, d: DocRow): DocAction[] {
  return roleActions(w, d).filter((x) => gate(w, d, x) === null);
}

/** Этап 24: файлы, дату и «Утвердить» — автор или начальник ИБ (правило этапа 16, решение владельца 1). */
function signRole(w: Who, d: DocRow): boolean {
  const v = activeWorking(d);
  if (!v || v.stage !== SIGN_STAGE) return false;
  const roles = rolesOf(w, d);
  return roles.has('author') || roles.has('head');
}
const canSign = (w: Who, d: DocRow) => signRole(w, d) && gate(w, d, 'sign') === null;

/**
 * «Ждёт вас» (цифра у «Документы» и пометка в реестре): пользователь среди тех, кто действует на текущем этапе
 * (stageHolders — та же функция, что «Сейчас у»). Право видеть документ не считается: читателя без действия
 * документ не ждёт. docs.manage может действовать за автора, но документ его не ждёт.
 */
function waitsFor(w: Who, d: DocRow): boolean {
  if (!activeWorking(d)) return false;
  return (w.holders.get(d.id)?.people ?? []).some((p) => p.id === w.a.userId);
}

/**
 * Какую версию пользователь видит. С ib.work — всё (рабочую, если есть). Без ib.work: рабочую — если она ждёт его
 * или он действовал по ней в текущем круге; иначе подписанную; архив и документы без подписанной версии — нет.
 */
function shownVersion(w: Who, d: DocRow): VersionRow | null {
  if (w.a.ibWork) return activeWorking(d) ?? d.workingVersion ?? d.approvedVersion;
  if (d.archivedAt) return null;
  const v = activeWorking(d);
  // С 1.4.0 переводчик — не пользователь портала: рабочая версия ему как переводчику не видна (решение владельца 9).
  if (v && (waitsFor(w, d) || (w.acted.get(v.id) ?? []).includes(v.round))) return v;
  return d.approvedVersion;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const isoDay = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

const pdfDto = (v: Pick<VersionRow, 'pdf'>) => (v.pdf ? { id: v.pdf.id, name: v.pdf.originalName, sha256: v.pdf.sha256, size: Number(v.pdf.size) } : null);

function versionDto(v: VersionRow) {
  return {
    id: v.id, no: v.no, edition: v.edition, title: v.title, onlyofficeUrl: v.onlyofficeUrl, changeNote: v.changeNote,
    stage: v.stage, stageName: stageName(v.stage), round: v.round, approvedAt: iso(v.approvedAt), createdAt: v.createdAt.toISOString(),
    /** Состояние внутри этапа (1.11.0): «На проверке у начальника ИБ», «На повторной проверке». */
    state: inRoute(v.stage) ? stateOf(v) : null,
    placeName: inRoute(v.stage) ? placeName(v.stage, stateOf(v)) : stageName(v.stage),
    signedOn: isoDay(v.signedOn),
    /** Исходный документ Word (этап 24) и приказ об утверждении. */
    docx: v.sourceDocx ? { id: v.sourceDocx.id, name: v.sourceDocx.originalName, sha256: v.sourceDocx.sha256, size: Number(v.sourceDocx.size) } : null,
    orderNo: v.orderNo,
    orderDate: isoDay(v.orderDate),
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
    /** Этап рабочей версии (если она видна): 21 «Драфт» … 24 «Утверждение»; stageName — с состоянием внутри этапа. */
    stage: working?.stage ?? null,
    stageName: working ? (inRoute(working.stage) ? placeName(working.stage, stateOf(working)) : stageName(working.stage)) : null,
    waitingForMe: waitsFor(w, d),
    /** «Сейчас у»: кто действует на текущем этапе (если рабочая версия видна); missingHead — «Начальник ИБ не назначен». */
    holders: working ? (w.holders.get(d.id) ?? null) : null,
    /** Этап 22: ближайший срок несогласовавшего ответственного лица и просрочен ли он (сотрудникам ИБ). */
    partiesDue: working?.stage === PARTIES_STAGE && w.a.ibWork ? (w.facts.get(working.id)?.nearestDue ?? null) : null,
    partiesOverdue: working?.stage === PARTIES_STAGE && w.a.ibWork ? (w.facts.get(working.id)?.nearestDue ?? today) < today : false,
    openBlockers: working && w.a.ibWork ? (w.facts.get(working.id)?.openBlockers ?? 0) : 0,
    archived: d.archivedAt !== null,
    version: d.version,
  };
}
export type DocItem = ReturnType<typeof toItem>;

// ---------------------------------------------------------------- «ждёт вас»: уведомления

/** Текст «ждёт вас»: только две проверки начальника ИБ (1.11.0) — остальное автор делает сам. */
const WAITING_TITLE: Partial<Record<RouteState, (label: string) => string>> = {
  head_review: (l) => `Документ ${l} ждёт вашей проверки`,
  head_recheck: (l) => `Документ ${l} доработан и ждёт повторной проверки`,
};

/**
 * «Ждёт вас»: начальнику ИБ — когда документ отправлен на проверку или повторную проверку (stageHolders). Одно
 * уведомление на состояние (версия, круг, этап, состояние — dedupe_key). О своём действии — нет (notify).
 */
export async function notifyWaiting(db: Db, docId: string, actorId: string | null): Promise<void> {
  const d = await db.document.findFirst({ where: { id: docId, deletedAt: null }, include: docInclude });
  const v = d ? activeWorking(d) : null;
  const state = v ? stateOf(v) : null;
  const title = state ? WAITING_TITLE[state] : undefined;
  if (!d || !v || !state || !title) return;
  const people = (await holdersOf(db, [d], await routeFacts(db, [v.id]), false)).holders.get(d.id)?.people ?? [];
  if (!people.length) return;
  await notify(db, {
    kind: 'doc_waiting', to: people.map((p) => p.id), documentId: d.id, actorId,
    title: title(`#${d.number} «${v.title}»`), dedupeKey: `doc_waiting:${v.id}:${v.round}:${v.stage}:${state}`,
  });
}

// ---------------------------------------------------------------- задачи этапов маршрута (1.6.3; общая задача — 1.6.4)

/** Метка задачи этапа без ответственного, когда отметка «Является начальником ИБ» никому не поставлена. */
export const NO_HEAD_LABEL = 'Начальник ИБ (не назначен)';
/** Метки общих задач (1.6.4): кому они предназначены. «Проверка сотрудниками» — задачи до 1.11.0 (этап 12 убран). */
export const REVIEW_GROUP_LABEL = 'Проверка сотрудниками';
/** Состояние общей задачи — состояние маршрута с этим суффиксом (задачи до 1.11.0). */
const GROUP = '#group';

interface StageTarget {
  /** Состояние задачи: состояние маршрута. */
  state: string;
  /** Исполнитель; задача без ответственного — null. */
  assigneeId: string | null;
  label: string | null;
  role: StageTaskRole;
  candidates: string[] | null;
}

/**
 * Кому задача в текущем месте маршрута: «Сейчас у» (stageHolders) — автор или, в двух проверках, начальник ИБ.
 * Драфт (21) — только первый драфт, заведённый за другого владельца (после возврата у автора задача «Доработать
 * документ»). Без ib.work или отключённый — задача без ответственного с меткой; начальник ИБ не назначен — тоже.
 */
async function stageTargets(db: Db, d: DocRow, v: VersionRow, state: string): Promise<StageTarget[]> {
  const place = stateOf(v);
  if (v.stage === FIRST_STAGE && place === 'draft' && !(v.no === 1 && v.round === 1 && d.createdBy !== d.ownerId)) return [];
  const h = (await holdersOf(db, [d], new Map(), false)).holders.get(d.id) ?? { people: [], missingHead: false };
  const ids = h.people.map((p) => p.id);
  const ib = new Set((await db.user.findMany({ where: { id: { in: ids }, ...WORK_USER }, select: { id: true } })).map((u) => u.id));
  const person = h.people.find((p) => ib.has(p.id));
  if (person) return [{ state, assigneeId: person.id, label: null, role: 'holder', candidates: null }];
  const missing = h.people[0];
  if (missing) return [{ state, assigneeId: null, label: missing.id === d.ownerId ? OWNER_LABEL : missing.fullName, role: 'holder', candidates: null }];
  if (h.missingHead) return [{ state, assigneeId: null, label: NO_HEAD_LABEL, role: 'holder', candidates: null }];
  return [];
}

/** Срок задачи этапа: 22 — ближайший срок лица, 23 с языками — ближайший срок языка без ссылки, иначе — N рабочих дней. */
async function stageDue(db: Db, stage: number, state: RouteState | null, f: RouteFacts): Promise<{ due: string | null; derived: string | null }> {
  if (stage === PARTIES_STAGE && state === 'parties') return { due: f.nearestDue, derived: 'сроки ответственных лиц' };
  if (stage === TRANSLATION_STAGE && f.translations > 0) return { due: f.translationDue, derived: 'сроки переводов' };
  const key = stageDaysKey(stage, state);
  const days = key ? (await readPortalParam<StageDays>(db, DOC_STAGE_DAYS_KEY))[key] : null;
  if (!days) return { due: null, derived: null };
  return { due: isoDate(addWorkingDays(parseIsoDate(todayIso()), days, await loadFullWorkCalendar(db))), derived: null };
}

type OpenStageTask = { id: string; number: number; statusId: string; assigneeId: string | null; documentState: string | null; dueDate: Date | null; candidates: { userId: string }[] };

/** Задача подходит цели: то же состояние и тот же исполнитель; общая — взята кем-то из списка или ещё никем. */
function fits(t: OpenStageTask, x: StageTarget): boolean {
  if (t.documentState !== x.state) return false;
  if (x.candidates) return t.assigneeId === null || x.candidates.includes(t.assigneeId);
  return t.assigneeId === x.assigneeId;
}

/**
 * Задачи этапа приводятся к текущему состоянию маршрута. Документ ушёл на другой этап (круг, фазу) — прежние задачи
 * закрываются системой («Выполнено»); сменился ответственный — задача прежнего закрывается и уходит в архив (это не его
 * работа, в отчёт по выполненным не идёт). Недостающие создаются; у общей задачи список приводится к составу. Закрытая
 * вручную задача того же состояния повторно не создаётся. Вызывается в транзакции каждого действия, которое меняет этап,
 * ответственных, лиц или переводы. closing — комментарий, когда рабочей версии нет (подписан, удалён, в архиве, пересмотр
 * отменён).
 */
export async function syncStageTasks(db: Db, docId: string, closing = 'Маршрут документа завершён'): Promise<void> {
  const d = await db.document.findUnique({ where: { id: docId }, include: docInclude });
  const open: OpenStageTask[] = await db.task.findMany({
    where: { documentId: docId, documentReason: 'stage', completedAt: null, archivedAt: null, deletedAt: null },
    select: { id: true, number: true, statusId: true, assigneeId: true, documentState: true, dueDate: true, candidates: { select: { userId: true } } },
  });
  const v = d && !d.deletedAt ? activeWorking(d) : null;
  if (!d || !v) {
    await closeTasks(db, open, closing);
    return;
  }
  const f = (await routeFacts(db, [v.id])).get(v.id) ?? NO_FACTS;
  const place = inRoute(v.stage) ? stateOf(v) : null;
  const state = stageState(v, place);
  // Версия не на маршруте 1.11.0 (данные до переноса) — задач этапов нет.
  const targets = inRoute(v.stage) ? await stageTargets(db, d, v, state) : [];
  const kept = open.filter((t) => targets.some((x) => fits(t, x)));
  const stale = open.filter((t) => !kept.includes(t));
  const baseOf = (s: string | null) => (s ?? '').replace(GROUP, '');
  await closeTasks(db, stale.filter((t) => baseOf(t.documentState) !== state), `Документ: «${placeName(v.stage, place)}»`);
  await closeTasks(db, stale.filter((t) => baseOf(t.documentState) === state), 'Ответственный по этапу сменился', { archive: true });
  const { due, derived } = await stageDue(db, v.stage, place, f);
  // Срок из сроков лиц или переводов идёт за ними; срок «N рабочих дней» после создания не трогается — его правят в задаче.
  if (derived) {
    for (const t of kept) {
      const was = t.dueDate?.toISOString().slice(0, 10) ?? null;
      if (was !== due) await moveStageTaskDue(db, t, was, due, derived);
    }
  }
  const label = `#${d.number} «${v.title}»`;
  for (const x of targets) {
    const have = kept.find((t) => fits(t, x));
    if (have) {
      if (x.candidates) await setTaskCandidates(db, have.id, have.candidates.map((c) => c.userId), x.candidates);
      continue;
    }
    // Задачу того же состояния закрыли вручную (или удалили) — не возвращаем; закрытую системой (сменился ответственный и вернулся) — создаём снова.
    const before = await db.task.findFirst({
      where: {
        documentId: docId, documentReason: 'stage', documentState: x.state, ...(x.candidates ? {} : { assigneeId: x.assigneeId }),
        transitions: { none: { kind: 'system', fromStatusId: { not: null } } },
      },
      select: { id: true },
    });
    if (before) continue;
    const text = stageTaskText(v.stage, place, { label, versionNo: v.no, languages: f.missingLanguages });
    await createStageTask(db, {
      documentId: docId, state: x.state, assigneeId: x.assigneeId, recipientLabel: x.label, title: text.title, due, candidates: x.candidates ?? [],
      description: stageTaskDescription({ label, type: d.type.value, stage: v.stage, state: place, versionNo: v.no, requirement: text.requirement }),
    }, d.number);
  }
}

/** Отметка начальника ИБ передана или снята, пользователь отключён: задачи этапов всех документов в работе. */
export async function syncAllStageTasks(db: Db): Promise<void> {
  const docs = await db.document.findMany({ where: { deletedAt: null, archivedAt: null, workingVersionId: { not: null } }, select: { id: true } });
  for (const d of docs) await syncStageTasks(db, d.id);
}

// ---------------------------------------------------------------- реестр

export interface DocListQuery {
  archived: boolean;
  status?: DocStatus;
  typeId?: string;
  /** Владелец (автор) документа. */
  ownerId?: string;
  /** Срок пересмотра: прошёл или в ближайшие N дней; dueTo — не позже даты. */
  due?: DocDueFilter;
  dueTo?: string;
  q?: string;
  waiting?: boolean;
  /** Только «к пересмотру» (needsReview) — ссылка с дашборда. */
  review?: boolean;
  /** Порядок: по типам (сначала «Политика») или по алфавиту; без него — сначала «ждёт вас», затем просроченный пересмотр. */
  sort?: DocSort;
  limit: number;
  cursor?: string;
}

async function loadVisible(db: Db, a: DocAccess, where: Prisma.DocumentWhereInput) {
  const rows = await db.document.findMany({ where: { ...where, deletedAt: null }, include: docInclude, orderBy: { number: 'asc' } });
  const working = rows.flatMap((d) => (d.workingVersionId ? [d.workingVersionId] : []));
  const who = await whoOf(db, a, a.ibWork ? [] : working, working, rows);
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
  if (q.archived && !a.ibWork) return { items: [], nextCursor: null, total: 0, archivedTotal: 0, facets: { owners: [], types: [] } };
  const { rows, who } = await loadVisible(db, a, { archivedAt: q.archived ? { not: null } : null });
  const needle = q.q?.trim().toLowerCase();
  const all = rows.map(({ d, shown }) => toItem(who, d, shown, today));
  const items = all
    .filter((x) => (!q.typeId || x.type.id === q.typeId) && (!q.ownerId || x.owner.id === q.ownerId)
      && (!q.status || x.status === q.status) && (!q.waiting || x.waitingForMe) && (!needle || x.title.toLowerCase().includes(needle))
      && (!q.review || needsReview(x, today)) && dueMatches(x.reviewDue, today, q.due, q.dueTo))
    .sort(q.sort ? docComparator(q.sort)
      // Сначала то, что ждёт вас, затем просроченный пересмотр, дальше по названию.
      : (x, y) => Number(y.waitingForMe) - Number(x.waitingForMe)
        || Number(y.status === 'review_overdue') - Number(x.status === 'review_overdue')
        || x.title.localeCompare(y.title, 'ru'));
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const archivedTotal = a.ibWork ? await db.document.count({ where: { archivedAt: { not: null }, deletedAt: null } }) : 0;
  return {
    items: items.slice(offset, offset + q.limit),
    nextCursor: items.length > offset + q.limit ? String(offset + q.limit) : null,
    total: items.length,
    archivedTotal,
    facets: listFacets(all),
  };
}

/** Значения фильтров «Автор» и «Тип» — из видимых пользователю документов (архив — отдельно), без учёта других фильтров. */
function listFacets(items: DocItem[]) {
  const owners = new Map(items.map((x) => [x.owner.id, { id: x.owner.id, fullName: x.owner.fullName }]));
  const types = new Map(items.map((x) => [x.type.id, x.type]));
  return {
    owners: [...owners.values()].sort((x, y) => x.fullName.localeCompare(y.fullName, 'ru')),
    types: [...types.values()].sort((x, y) => compareTypes(x.value, y.value)),
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
  21: `автор: владелец или право «${permName('docs.manage')}»; проверяет начальник ИБ (отметка в карточке пользователя)`,
  22: 'автор ведёт ответственных лиц; повторно проверяет начальник ИБ',
  23: 'автор: языки и ссылки на переводы',
  24: 'автор или начальник ИБ',
};
const STATE_HINTS: Partial<Record<RouteState, string>> = {
  head_review: 'начальник ИБ (отметка в карточке пользователя)',
  head_recheck: 'начальник ИБ (отметка в карточке пользователя)',
};

/** Решения, которыми этап пройден: кто перевёл документ дальше. */
const PASSED = ['submitted', 'approved', 'skipped', 'moved', 'signed'];

/** Файлы прежнего маршрута (до 1.11.0): драфт, согласованная начальником ИБ, финальная. Только просмотр. */
const FILE_KIND_NAMES: Record<string, string> = {
  draft: 'Файл драфта',
  head_approved: 'Версия при согласовании начальником ИБ',
  final: 'Финальная версия',
};

type FileRow = {
  id: string; kind: string; round: number; addedAt: Date; fileId: string; adder: { fullName: string };
  file: { id: string; originalName: string; sha256: string; size: bigint; mime: string };
};

/**
 * Файлы версии в карточке (1.4.0): один файл — одна строка. Файл автора, согласованный начальником ИБ, привязан
 * дважды (draft и head_approved) — показывается один раз с обеими отметками (marks). id и kind — первой привязки;
 * снять можно, пока он — файл автора на этапах 11–12 (снимается привязка draft, отметка согласования остаётся).
 */
function mergeFileRows(rows: readonly FileRow[], authorFiles: boolean) {
  const byFile = new Map<string, FileRow[]>();
  for (const r of rows) byFile.set(r.fileId, [...(byFile.get(r.fileId) ?? []), r]);
  return [...byFile.values()].map((group) => {
    const first = group[0] as FileRow;
    const draftRow = group.find((r) => r.kind === 'draft');
    return {
      id: (draftRow ?? first).id, kind: first.kind as 'draft' | 'head_approved' | 'final', kindName: FILE_KIND_NAMES[first.kind] ?? first.kind,
      /** Все отметки файла: «Файл драфта», «Версия при согласовании начальником ИБ», «Финальная версия». */
      marks: group.map((r) => FILE_KIND_NAMES[r.kind] ?? r.kind),
      round: first.round,
      file: { id: first.file.id, name: first.file.originalName, sha256: first.file.sha256, size: Number(first.file.size), mime: first.file.mime },
      addedBy: first.adder.fullName, addedAt: first.addedAt.toISOString(),
      removable: authorFiles && !!draftRow,
    };
  });
}

export async function getDocument(db: Db, a: DocAccess, id: string) {
  const today = todayIso();
  const d = await getRow(db, id);
  const who = await whoOf(db, a, d.workingVersionId ? [d.workingVersionId] : [], undefined, [d], true);
  const shown = shownVersion(who, d);
  if (!shown) throw notFound('Документ');
  const working = activeWorking(d);
  const workingShown = working !== null && shown === working;

  const allVersions = await db.documentVersion.findMany({ where: { documentId: id }, select: versionSelect, orderBy: { no: 'desc' } });
  const visibleVersions = allVersions.filter((v) => v.approvedAt !== null || a.ibWork || v.id === shown.id);
  const visibleIds = new Set(visibleVersions.map((v) => v.id));
  const history = await db.documentApproval.findMany({
    where: { documentId: id, versionId: { in: [...visibleIds] } },
    include: { actor: { select: { fullName: true } }, file: { select: { id: true, originalName: true, sha256: true, size: true, mime: true } } },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
  });
  const fileDto = (f: { id: string; originalName: string; sha256: string; size: bigint; mime: string } | null) =>
    (f ? { id: f.id, name: f.originalName, sha256: f.sha256, size: Number(f.size), mime: f.mime } : null);

  // Маршрут показанной версии: кто прошёл этапы в текущем круге. Версия прежнего маршрута — с его этапами (без «кто действует»).
  const current = inRoute(shown.stage);
  const stages = shown.stage <= 3 ? Object.keys(LEGACY_STAGE_NAMES).map(Number)
    : shown.stage <= 16 ? Object.keys(ROUTE_V2_NAMES).map(Number) : ROUTE.map((s) => s.stage);
  // Этап пройден решением, которое увело документ на следующий этап (одобрение, «на перевод», утверждение).
  const roundActs = history.filter((h) => h.versionId === shown.id && h.round === shown.round && PASSED.includes(h.decision)
    && (h.toStage === null || h.toStage !== h.stage));
  const holderCtx = who.holderCtx.get(d.id);
  const shownState = current ? stateOf(shown) : null;
  const route = stages.map((stage) => {
    const act = roundActs.find((h) => h.stage === stage);
    const state = shown.approvedAt !== null || stage < shown.stage ? 'done' : stage === shown.stage ? 'current' : 'todo';
    // Кто действует сейчас — та же stageHolders, что «Сейчас у»; пройденный — кто и когда (actedBy, actedAt).
    const placeState = stage === shown.stage ? shownState : stage === FIRST_STAGE ? 'draft' : stage === PARTIES_STAGE ? 'parties' : null;
    const h = !current || !holderCtx || state !== 'current' ? { people: [], missingHead: false } : stageHolders(stage, placeState, holderCtx);
    return {
      stage, name: stageName(stage), state: state as 'done' | 'current' | 'todo',
      /** Состояние внутри текущего этапа: «На проверке у начальника ИБ», «На повторной проверке». */
      place: state === 'current' && placeState ? STATE_NAMES[placeState] : null,
      approvers: h.people.map((p) => (p.inactive ? `${p.fullName} (отключён)` : p.fullName)), missingHead: h.missingHead,
      hint: !current ? '' : (state === 'current' && placeState ? STATE_HINTS[placeState] : undefined) ?? HINTS[stage] ?? '',
      actedBy: act && act.decision !== 'skipped' ? act.actor.fullName : null, actedAt: act ? act.at.toISOString() : null,
      /** Этап пропущен (старый маршрут: согласовать мог только владелец). */
      skipped: act?.decision === 'skipped' ? act.comment : null,
      /** Свой документ одобрил начальник ИБ — другого согласующего не было (13, с 1.11.0 — 21 и 22). */
      selfApproved: history.some((x) => x.versionId === shown.id && x.round === shown.round && x.stage === stage && x.selfApproved),
    };
  });

  // Последнее решение по показанной версии — возврат: замечание видно в карточке и без права на историю (ADR-0021).
  const lastAct = history.find((h) => h.versionId === shown.id);
  const returned = lastAct?.decision === 'returned'
    ? {
      at: lastAct.at.toISOString(), actor: lastAct.actor.fullName, stageName: stageName(lastAct.stage), comment: lastAct.comment,
      /** Записка к возврату (1.4.0), если приложена. */
      file: lastAct.file ? { id: lastAct.file.id, name: lastAct.file.originalName, sha256: lastAct.file.sha256, size: Number(lastAct.file.size), mime: lastAct.file.mime } : null,
    }
    : null;

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
          rechecks: { include: { actor: { select: { fullName: true } } }, orderBy: { at: 'desc' } },
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
    // Переводы (Г4) — сотрудникам ИБ; с 1.4.0 переводчик не пользователь портала.
    a.ibWork
      ? db.documentTranslation.findMany({
        where: { versionId: shown.id, removedAt: null },
        include: {
          files: { where: { removedAt: null }, include: { file: { select: { id: true, originalName: true, sha256: true, size: true, mime: true } } }, orderBy: { addedAt: 'asc' } },
          deadlineChanges: { include: { actor: { select: { fullName: true } } }, orderBy: { at: 'desc' } },
          sourceDocx: { select: { id: true, originalName: true, sha256: true, size: true, mime: true } },
          signedPdf: { select: { id: true, originalName: true, sha256: true, size: true, mime: true } },
        },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      })
      : [],
  ]);

  const actions = workingShown ? actionsOf(who, d) : [];
  const roles = rolesOf(who, d);
  const author = roles.has('author');
  const active = d.archivedAt === null;
  const at = (stage: number) => workingShown && working.stage === stage;
  const place = workingShown ? stateOf(working) : null;
  const sign = workingShown && canSign(who, d);
  const can = {
    /** Поля карточки и ссылка OnlyOffice: автор в драфте (не на проверке у начальника ИБ). */
    edit: at(FIRST_STAGE) && place === 'draft' && author,
    /** Действия маршрута (MOVES): кнопки карточки. */
    actions,
    /** «Утвердить» (этап 24): автор или начальник ИБ, когда загружены обязательные файлы. */
    sign,
    /** Файлы — только на этапе 24 (решение владельца): PDF и .docx основного языка, .docx и PDF переводов. */
    approvalFiles: at(SIGN_STAGE) && signRole(who, d),
    /** Файлы драфта прежнего маршрута больше не прикладываются (1.11.0). */
    draftFiles: false,
    /** Комментарии сотрудников ИБ к рабочей версии — на любом этапе. */
    comment: workingShown && inRoute(working.stage) && a.ibWork,
    revise: active && d.approvedVersion !== null && working === null && author,
    /** Отменить пересмотр: рабочая версия уходит в историю, действующей остаётся подписанная (решение владельца 8). */
    cancelRevision: workingShown && d.approvedVersion !== null && (author || roles.has('head')),
    /** Мягкое удаление: только документ без подписанной версии (docs.delete). */
    delete: a.perms.has('docs.delete') && d.approvedVersion === null,
    /** Ответственные лица: ведёт автор в драфте (21, не на проверке) и на 22 (в согласовании, не на повторной проверке). */
    parties: ((at(FIRST_STAGE) && place === 'draft') || (at(PARTIES_STAGE) && place === 'parties')) && author,
    /** Отметка согласования, перенос срока, «Запросить повторно» — только с этапа 22 (решение владельца 11). */
    approveParties: at(PARTIES_STAGE) && place === 'parties' && author,
    /** Блокеры: автор, старшие над автором, начальник ИБ — на любом этапе маршрута. */
    blockers: workingShown && (author || roles.has('senior') || roles.has('head')),
    /** Переводы: раздел и языки — только на этапе 23, ведёт автор (замечание владельца 05.11.2026). */
    translations: at(TRANSLATION_STAGE) && author,
    manage: a.manage,
  };
  const stuck = workingShown && inRoute(working.stage) && actions.length === 0 && !sign;
  // Шаг по роли есть, но не выполнено условие (блокеры, ответственные лица, переводы, файлы) — объяснить, что мешает.
  const gated = workingShown ? [...roleActions(who, d), ...(signRole(who, d) ? ['sign' as const] : [])].map((x) => gate(who, d, x)).find((g) => g !== null) ?? null : null;
  const legacyFiles = mergeFileRows(fileRows, false);
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
      : `«${placeName(working.stage, place)}» — ${(place ? STATE_HINTS[place] : undefined) ?? HINTS[working.stage] ?? ''}`,
    returned,
    /** Файлы прежнего маршрута (до 1.11.0): только просмотр и скачивание. */
    files: legacyFiles,
    comments: commentRows.map((c) => ({ id: c.id, author: c.author.fullName, body: c.body, at: c.createdAt.toISOString() })),
    parties: partyRows.map((p) => {
      const due = isoDay(p.dueDate) ?? '';
      return {
        id: p.id, fullName: p.fullName, department: p.department, email: p.email, user: p.user, dueDate: due,
        /** Срок на этапе 1 — дней от перехода на этап 2 (решение владельца 11); на этапе 1 срок не идёт. */
        dueDays: p.dueDays,
        overdue: p.approvedAt === null && due < today && shown.stage === PARTIES_STAGE,
        approvedAt: iso(p.approvedAt), approvedBy: p.approver?.fullName ?? null, approveComment: p.approveComment,
        approvedOn: isoDay(p.approvedOn),
        /** «до доработки от <дата>»: начальник ИБ вернул документ с повторной проверки после этой отметки. */
        reworkedAt: iso(p.reworkedAt),
        rechecks: p.rechecks.map((r) => ({
          prevApprovedOn: isoDay(r.prevApprovedOn), prevApprovedAt: r.prevApprovedAt.toISOString(), reworkedAt: iso(r.reworkedAt),
          fromDue: isoDay(r.fromDue) ?? '', toDue: isoDay(r.toDue) ?? '', comment: r.comment, actor: r.actor.fullName, at: r.at.toISOString(),
        })),
        files: p.files.map((f) => ({
          id: f.id, file: { id: f.file.id, name: f.file.originalName, sha256: f.file.sha256, size: Number(f.file.size), mime: f.file.mime },
        })),
        deadlines: p.deadlineChanges.map((c) => ({ from: isoDay(c.fromDate) ?? '', to: isoDay(c.toDate) ?? '', comment: c.comment, actor: c.actor.fullName, at: c.at.toISOString() })),
      };
    }),
    translations: translationRows.map((t) => {
      const due = isoDay(t.dueDate) ?? '';
      return {
        /** Имя переводчика текстом (1.4.0); у строк до 1.4.0 заполнено миграцией из ФИО учётной записи. */
        id: t.id, language: t.language, translatorName: t.translatorName, dueDate: due,
        /** Ссылка на перевод в OnlyOffice (1.11.0): перевод готов, когда она есть. Файлы до 1.11.0 — files. */
        onlyofficeUrl: t.onlyofficeUrl,
        done: t.onlyofficeUrl !== '' || (shown.stage <= 16 && t.files.length > 0),
        overdue: t.onlyofficeUrl === '' && due < today && shown.stage === TRANSLATION_STAGE,
        /** Этап 24: Word перевода (обязателен) и подписанный PDF (по желанию). */
        docx: fileDto(t.sourceDocx),
        pdf: fileDto(t.signedPdf),
        files: t.files.map((f) => ({
          id: f.id, file: { id: f.file.id, name: f.file.originalName, sha256: f.file.sha256, size: Number(f.file.size), mime: f.file.mime },
        })),
        deadlines: t.deadlineChanges.map((c) => ({ from: isoDay(c.fromDate) ?? '', to: isoDay(c.toDate) ?? '', comment: c.comment, actor: c.actor.fullName, at: c.at.toISOString() })),
        /** Файлы перевода — только на этапе 24 (Word обязателен, PDF по желанию). */
        canUpload: can.approvalFiles,
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
      docx: x.sourceDocx ? { id: x.sourceDocx.id, name: x.sourceDocx.originalName, sha256: x.sourceDocx.sha256, size: Number(x.sourceDocx.size) } : null,
      orderNo: x.orderNo, orderDate: isoDay(x.orderDate),
    })),
    // Подробная история — по праву «История в карточках» (ADR-0021); блок маршрута (route) — всем, кто видит документ.
    history: !a.perms.has('history.view') ? [] : history.map((h) => ({
      id: h.id, at: h.at.toISOString(),
      // Перенос при обновлении сделала система, а не владелец документа (actor_id обязателен).
      actor: h.decision === 'migrated' ? 'Система' : h.actor.fullName,
      stage: h.stage, stageName: stageName(h.stage),
      toStage: h.toStage, toStageName: h.toStage !== null ? stageName(h.toStage) : null,
      decision: h.decision as HistoryDecision, comment: h.comment, versionNo: h.versionNo, round: h.round,
      /** Точный вид решения маршрута 1.11.0 (head_approved, unchanged_confirmed, …); у прежних решений — null. */
      event: h.event,
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
  const shown = shownVersion(await whoOf(db, a, d.workingVersionId ? [d.workingVersionId] : [], undefined, [d]), d);
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
  const u = await db.user.findFirst({ where: { id, ...WORK_USER }, select: { id: true } });
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
    await tx.documentVersion.create({ data: { id: versionId, documentId: id, no: 1, edition, title, onlyofficeUrl, changeNote, stage: FIRST_STAGE, routeState: 'draft', createdBy: actor.id } });
    // Проверить ссылку сейчас, а не при COMMIT; затем вернуть отложенный режим для следующих документов в транзакции.
    await tx.$executeRaw`SET CONSTRAINTS "documents_working_version_id_fkey" IMMEDIATE`;
    await tx.$executeRaw`SET CONSTRAINTS "documents_working_version_id_fkey" DEFERRED`;
    await auditSettings(tx, actor, {
      action: 'document.created', entity: 'document', entityId: id,
      summary: `Документ #${doc.number} «${title}» создан (версия 1)`,
      after: { title, typeId: input.typeId, ownerId: input.ownerId, reviewMonths, onlyofficeUrl, edition },
    });
    await syncStageTasks(tx, id);
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
      // Сменился владелец — задачи этапа переходят к новому.
      if (docData.ownerId) await syncStageTasks(tx, id);
    }
  });
}

// ---------------------------------------------------------------- маршрут

export interface MoveInput {
  version: number;
  /** Этап, который пользователь видел на экране: если документ уже на другом этапе — 409. */
  stage: number;
  comment?: string;
  /** «Отправить на перевод»: автор подтверждает, что документ не изменялся после проверки начальником ИБ. */
  confirmUnchanged?: boolean;
  /** До 1.11.0 — файл версии и записка к возврату. С 1.11.0 файлы на этапах 21–23 не принимаются (409). */
  fileId?: string;
}

const PDF_MIME = [MIME_BY_EXT.pdf];
const DOCX_MIME = [MIME_BY_EXT.docx];
/** Файлы — только на этапе 24 (решение владельца 05.11.2026); на 21–23 документ — ссылка OnlyOffice. */
export const filesOnlyAtApproval = () => conflict('FILES_ONLY_AT_APPROVAL', 'Файлы прикладываются только на этапе «Утверждение»: до него документ — ссылка OnlyOffice');

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
function moveDenied(action: DocAction, who: Who): AppError {
  if (MOVES[action].who.includes('head') && who.a.superAdmin && who.a.ibHead) {
    return forbiddenWith('SEPARATION_OF_DUTIES', 'Супер-администратор не согласует документы: так сохраняется разделение полномочий');
  }
  const from = MOVES[action].from;
  const hint = (from.state ? STATE_HINTS[from.state] : undefined) ?? HINTS[from.stage] ?? '';
  return forbiddenWith('FORBIDDEN', `«${MOVES[action].label}» — ${hint}`);
}

/** Решение в истории: прежние значения decision (их читает 1.10.0) и точный вид — event. */
const DECISION_OF: Record<DocAction, { decision: string; event: string }> = {
  submit_head: { decision: 'submitted', event: 'head_review_requested' },
  head_approve: { decision: 'approved', event: 'head_approved' },
  head_return: { decision: 'returned', event: 'head_returned' },
  request_recheck: { decision: 'submitted', event: 'head_recheck_requested' },
  to_translation: { decision: 'moved', event: 'unchanged_confirmed' },
  head_reapprove: { decision: 'approved', event: 'head_reapproved' },
  recheck_return: { decision: 'returned', event: 'recheck_returned' },
  to_approval: { decision: 'moved', event: 'translations_done' },
};
const addDaysIso = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Действие маршрута (status.ts, MOVES). Одобрение и повторное одобрение — без файла: в истории ссылка OnlyOffice,
 * кто и когда (текст по ссылке не фиксируется — ADR-0010). Возврат — с комментарием: новый круг, задача автору.
 * Одобрение драфта: сроки лиц, заданные днями на этапе 1, становятся датами от сегодня (решение владельца 11).
 * Возврат с повторной проверки: отметки лиц остаются с пометкой «до доработки от <дата>».
 */
export async function moveDocument(db: Db, actor: Actor, id: string, action: DocAction, input: MoveInput) {
  return withTx(db, async (tx) => {
    const rule = MOVES[action];
    const back = RETURN_ACTIONS.includes(action);
    if (input.fileId) throw filesOnlyAtApproval();
    const comment = cleanComment(input.comment, rule.comment ?? null);
    if (action === 'to_translation' && input.confirmUnchanged !== true) {
      throw badRequest('CONFIRM_UNCHANGED', 'Подтвердите: документ не изменялся после проверки начальником ИБ. Если изменялся — «Повторная проверка»');
    }
    const { d, w, who } = await routeContext(tx, actor, id, input);
    const from = inRoute(w.stage) ? stateOf(w) : null;
    if (rule.from.stage !== w.stage || rule.from.state !== from) {
      throw conflict('WRONG_STAGE', `«${rule.label}» — не сейчас: документ — «${placeName(w.stage, from)}». Обновите страницу`);
    }
    if (!roleActions(who, d).includes(action)) throw moveDenied(action, who);
    const blocked = gate(who, d, action);
    if (blocked) throw conflict(blocked.code, blocked.reason);

    const selfApproved = (action === 'head_approve' || action === 'head_reapprove') && d.ownerId === actor.id;
    const { decision, event } = DECISION_OF[action];
    const note = action === 'to_translation'
      ? `Автор подтвердил: документ не изменялся после проверки начальником ИБ${comment ? `. ${comment}` : ''}`
      : (action === 'head_approve' || action === 'head_reapprove') && !comment ? `Одобрено по ссылке OnlyOffice: ${w.onlyofficeUrl}` : comment;
    await addDecision(tx, {
      documentId: id, versionId: w.id, versionNo: w.no, round: w.round, stage: w.stage, toStage: rule.to.stage,
      decision, event, comment: note, actorId: actor.id, selfApproved,
    });
    await tx.documentVersion.update({
      where: { id: w.id },
      data: { stage: rule.to.stage, routeState: rule.to.state, ...(back ? { round: w.round + 1 } : {}) },
    });

    const now = new Date();
    if (action === 'head_approve') {
      // Сроки лиц этапа 1 (дней) — даты от перехода на этап 2; история сроков пополняется.
      const today = todayIso();
      const queued = await tx.documentParty.findMany({ where: { versionId: w.id, removedAt: null, dueDays: { not: null } } });
      for (const p of queued) {
        const to = addDaysIso(today, p.dueDays as number);
        await tx.documentParty.update({ where: { id: p.id }, data: { dueDate: new Date(`${to}T00:00:00Z`), dueDays: null } });
        await tx.documentDeadlineChange.create({
          data: { documentId: id, partyId: p.id, fromDate: p.dueDate, toDate: new Date(`${to}T00:00:00Z`), comment: `Срок от перехода на этап 2: ${p.dueDays} дн.`, actorId: actor.id },
        });
      }
    }
    if (action === 'recheck_return') {
      await tx.documentParty.updateMany({ where: { versionId: w.id, removedAt: null, approvedAt: { not: null }, reworkedAt: null }, data: { reworkedAt: now } });
    }

    if (back) {
      const who = (await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { fullName: true } })).fullName;
      const where = placeName(w.stage, from);
      await documentTask(tx, {
        documentId: id,
        reason: 'returned',
        title: `Доработать документ «${w.title}»`,
        description: `Документ #${d.number}, версия ${w.no}. ${who} вернул(а) его на доработку («${where}»):\n${comment}\n\n`
          + (action === 'head_return' ? 'После правки отправьте документ на проверку начальнику ИБ заново.'
            : 'После правки при необходимости запросите повторное согласование у ответственных лиц («Запросить повторно») и отправьте документ на повторную проверку.'),
        repeatComment: `Повторный возврат («${where}», ${who}): ${comment}`,
        workdays: 3,
      });
    }
    if (action === 'submit_head' || action === 'request_recheck') {
      await closeDocumentTasks(tx, id, 'returned', `Документ отправлен на ${action === 'submit_head' ? 'проверку' : 'повторную проверку'} начальнику ИБ (версия ${w.no})`);
    }
    const ref = { id, number: d.number, title: w.title, ownerId: d.ownerId };
    if (back) await notifyReturned(tx, ref, actor.id, placeName(w.stage, from), comment);
    else await notifyWaiting(tx, id, actor.id);
    await syncStageTasks(tx, id);

    const self = selfApproved ? ' — одобрено автором (начальник ИБ), без независимого согласования' : '';
    const to = placeName(rule.to.stage, rule.to.state);
    await auditSettings(tx, actor, {
      action: back ? 'document.returned' : 'document.moved', entity: 'document', entityId: id,
      summary: back
        ? `Документ #${d.number} «${w.title}» (версия ${w.no}) возвращён на доработку: «${placeName(w.stage, from)}» → «${to}»`
        : `Документ #${d.number} «${w.title}» (версия ${w.no}): «${rule.label}» («${placeName(w.stage, from)}» → «${to}»)${self}`,
      after: { action, event, versionNo: w.no, round: w.round, from: w.stage, fromState: from, to: rule.to.stage, toState: rule.to.state, comment: note, selfApproved, onlyofficeUrl: w.onlyofficeUrl },
    });
  });
}

export interface SignInput {
  version: number;
  stage: number;
  /** Дата утверждения YYYY-MM-DD: не позже сегодня. От неё — дата пересмотра. */
  signedOn: string;
  /** Приказ об утверждении (необязательно). */
  orderNo?: string;
  orderDate?: string | null;
}

const isIsoDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * «Утвердить» (этап 24): нужны подписанный PDF и исходный .docx основного языка и .docx каждого перевода (gate) —
 * версия становится действующей, документ — в реестре утверждённых; пересмотр — от даты утверждения.
 */
export async function signDocument(db: Db, actor: Actor, id: string, input: SignInput) {
  return withTx(db, async (tx) => {
    const today = todayIso();
    if (!isIsoDay(input.signedOn)) throw badRequest('BAD_DATE', 'Укажите дату утверждения');
    if (input.signedOn > today) throw badRequest('BAD_DATE', 'Дата утверждения — не позже сегодняшнего дня');
    const orderNo = (input.orderNo ?? '').trim();
    if (orderNo.length > 100) throw badRequest('TOO_LONG', 'Номер приказа — не длиннее 100 символов');
    const orderDate = input.orderDate ? input.orderDate : null;
    if (orderDate && (!isIsoDay(orderDate) || orderDate > today)) throw badRequest('BAD_DATE', 'Дата приказа — не позже сегодняшнего дня');
    const { d, w, who } = await routeContext(tx, actor, id, input);
    if (w.stage !== SIGN_STAGE) throw conflict('WRONG_STAGE', `Утвердить можно на этапе «${stageName(SIGN_STAGE)}». Обновите страницу`);
    if (!signRole(who, d)) throw forbiddenWith('FORBIDDEN', `Утверждает ${HINTS[SIGN_STAGE]}`);
    const blocked = gate(who, d, 'sign');
    if (blocked) throw conflict(blocked.code, blocked.reason);
    const pdf = await tx.file.findUniqueOrThrow({ where: { id: w.pdfFileId as string }, select: { sha256: true } });
    const now = new Date();
    const due = addMonthsIso(input.signedOn, d.reviewMonths);
    await tx.documentVersion.update({
      where: { id: w.id },
      data: { approvedAt: now, signedOn: new Date(`${input.signedOn}T00:00:00Z`), orderNo, orderDate: orderDate ? new Date(`${orderDate}T00:00:00Z`) : null },
    });
    await tx.document.update({ where: { id }, data: { approvedVersionId: w.id, workingVersionId: null, reviewDue: new Date(`${due}T00:00:00Z`) } });
    await addDecision(tx, {
      documentId: id, versionId: w.id, versionNo: w.no, round: w.round, stage: SIGN_STAGE, decision: 'signed', event: 'approved_final',
      comment: `Утверждён ${formatDateRu(input.signedOn)}${orderNo ? `, приказ № ${orderNo}${orderDate ? ` от ${formatDateRu(orderDate)}` : ''}` : ''}`,
      actorId: actor.id, pdfSha256: pdf.sha256,
    });
    await closeDocumentTasks(tx, id, 'review', `Версия ${w.no} утверждена, следующий пересмотр — до ${formatDateRu(due)}`);
    await syncStageTasks(tx, id, `Версия ${w.no} утверждена`);
    await auditSettings(tx, actor, {
      action: 'document.signed', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}» (версия ${w.no}) утверждён ${formatDateRu(input.signedOn)}, пересмотр до ${formatDateRu(due)}`,
      after: { versionNo: w.no, round: w.round, signedOn: input.signedOn, reviewDue: due, pdfSha256: pdf.sha256, orderNo, orderDate },
    });
  });
}

/** Ячейка файла этапа 24: подписанный PDF, исходный .docx основного языка, .docx или PDF перевода. */
export type ApprovalSlot = 'pdf' | 'docx' | 'translation_docx' | 'translation_pdf';

/**
 * Файл этапа 24 (автор или начальник ИБ): загрузить или заменить (fileId) и снять (null). Тип — по содержимому
 * (lib/file-type.ts при загрузке): PDF — только %PDF-, Word — только .docx без макросов.
 */
export async function setApprovalFile(db: Db, actor: Actor, id: string, input: { version: number; stage: number; slot: ApprovalSlot; translationId?: string; fileId: string | null }) {
  return withTx(db, async (tx) => {
    const { d, w, who } = await routeContext(tx, actor, id, input);
    if (w.stage !== SIGN_STAGE) throw filesOnlyAtApproval();
    if (!signRole(who, d)) throw forbiddenWith('FORBIDDEN', `Файлы утверждения загружает ${HINTS[SIGN_STAGE]}`);
    const pdfSlot = input.slot === 'pdf' || input.slot === 'translation_pdf';
    const what = { pdf: 'Подписанный PDF', docx: 'Исходный документ Word', translation_docx: 'Word перевода', translation_pdf: 'PDF перевода' }[input.slot];
    let file: { id: string; originalName: string; sha256: string } | null = null;
    if (input.fileId) {
      const [f] = await claimFiles(tx, actor.id, [input.fileId], { mimes: pdfSlot ? PDF_MIME : DOCX_MIME, what });
      if (!f) throw badRequest('FILE_REQUIRED', `${what}: выберите файл`);
      file = f;
    }
    let previous: string | null;
    let label = '';
    if (input.slot === 'pdf' || input.slot === 'docx') {
      previous = input.slot === 'pdf' ? w.pdfFileId : w.sourceDocxFileId;
      await tx.documentVersion.update({ where: { id: w.id }, data: input.slot === 'pdf' ? { pdfFileId: file?.id ?? null } : { sourceDocxFileId: file?.id ?? null } });
    } else {
      const t = input.translationId
        ? await tx.documentTranslation.findFirst({ where: { id: input.translationId, versionId: w.id, removedAt: null } })
        : null;
      if (!t) throw notFound('Перевод');
      label = ` (${t.language})`;
      previous = input.slot === 'translation_pdf' ? t.signedPdfFileId : t.sourceDocxFileId;
      await tx.documentTranslation.update({ where: { id: t.id }, data: input.slot === 'translation_pdf' ? { signedPdfFileId: file?.id ?? null } : { sourceDocxFileId: file?.id ?? null } });
    }
    if (previous && previous !== file?.id) await deleteIfUnreferenced(tx, actor, previous, `документ #${d.number}: ${what.toLowerCase()} заменён или снят`);
    await auditSettings(tx, actor, {
      action: file ? 'document.files_added' : 'document.file_removed', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}» (версия ${w.no}): ${what.toLowerCase()}${label} — ${file ? `«${file.originalName}»` : 'снят'}`,
      after: { versionNo: w.no, slot: input.slot, translationId: input.translationId ?? null, file: file ? { id: file.id, name: file.originalName, sha256: file.sha256 } : null },
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
      throw forbiddenWith('FORBIDDEN', `Пересмотр отменяет автор (владелец или право «${permName('docs.manage')}») или начальник ИБ`);
    }
    const res = await tx.document.updateMany({ where: { id, version: input.version }, data: { workingVersionId: null, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    await tx.documentVersion.update({ where: { id: w.id }, data: { cancelledAt: new Date() } });
    await addDecision(tx, { documentId: id, versionId: w.id, versionNo: w.no, round: w.round, stage: w.stage, decision: 'cancelled', comment, actorId: actor.id });
    await closeDocumentTasks(tx, id, 'returned', `Пересмотр отменён (версия ${w.no})`);
    await syncStageTasks(tx, id, `Пересмотр отменён (версия ${w.no})`);
    await auditSettings(tx, actor, {
      action: 'document.revision_cancelled', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${w.title}»: пересмотр отменён, версия ${w.no} — в истории; действующая — ${d.approvedVersion.no}`,
      after: { versionNo: w.no, stage: w.stage, comment, approvedVersionNo: d.approvedVersion.no },
    });
  });
}

/**
 * Файлы одного запроса — в порядке выбора: added_at с шагом 1 мс. Иначе у привязок одинаковое время, и порядок файлов
 * в карточке (и какой из них «последний» для согласования) случаен.
 */
export function inPickOrder<T extends { id: string }>(files: readonly T[], fileIds: readonly string[]): (T & { addedAt: Date })[] {
  const base = Date.now();
  return [...files].sort((a, b) => fileIds.indexOf(a.id) - fileIds.indexOf(b.id)).map((f, i) => ({ ...f, addedAt: new Date(base + i) }));
}

/** Файлы драфта прежнего маршрута (до 1.11.0): с 1.11.0 не прикладываются и не снимаются — 409 (правило файлов). */
export async function addDraftFiles(db: Db, actor: Actor, id: string, input: { version: number; stage: number; fileIds: string[] }) {
  return withTx(db, async (tx) => {
    await routeContext(tx, actor, id, input);
    throw filesOnlyAtApproval();
  });
}

export async function removeDraftFile(db: Db, actor: Actor, id: string, _linkId: string, input: { version: number; stage: number }) {
  return withTx(db, async (tx) => {
    await routeContext(tx, actor, id, input);
    throw filesOnlyAtApproval();
  });
}

/** Комментарий сотрудника ИБ к рабочей версии — на любом этапе маршрута (1.11.0). Документ не меняется (версия та же). */
export async function addDocumentComment(db: Db, actor: Actor, id: string, input: { body: string }) {
  return withTx(db, async (tx) => {
    const body = cleanComment(input.body, 'Напишите комментарий');
    const a = await accessOf(tx, actor.id);
    if (!a.ibWork) throw forbiddenWith('FORBIDDEN', 'Комментируют сотрудники ИБ');
    const d = await getRow(tx, id);
    const w = activeWorking(d);
    if (!w || !inRoute(w.stage)) throw conflict('WRONG_STAGE', 'Комментарии — к документу в работе. Обновите страницу');
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
    await syncStageTasks(tx, id, 'Документ удалён');
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
        routeState: 'draft',
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
    await syncStageTasks(tx, id);
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
    await syncStageTasks(tx, id, 'Документ отправлен в архив');
  });
}
