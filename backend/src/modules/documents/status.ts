// Документы (этап 6; маршрут 1.2.0 — ADR-0024): этапы маршрута, статус и дата пересмотра — чистые функции без БД.

/**
 * Маршрут 1.11.0 (ADR-0042): этапы 21–24. Номера не 1–4 и не 11–14 нарочно: backend 1.10.0 после отката не узнаёт
 * этих этапов и не двигает документ (в его маршруте их нет), а не принимает «Согласование» за «Проверку сотрудниками».
 * Начальник ИБ проверяет документ только в двух точках: при выходе из драфта и при повторной проверке после доработки.
 */
export const ROUTE = [
  { stage: 21, name: 'Драфт' },
  { stage: 22, name: 'Согласование' },
  { stage: 23, name: 'Перевод' },
  { stage: 24, name: 'Утверждение' },
] as const;

export const FIRST_STAGE = 21;
export const PARTIES_STAGE = 22;
export const TRANSLATION_STAGE = 23;
/** Единственный этап с файлами: подписанный PDF, исходный .docx, .docx переводов. */
export const SIGN_STAGE = 24;
export const ROUTE_STAGES: readonly number[] = ROUTE.map((s) => s.stage);
export const inRoute = (stage: number) => ROUTE_STAGES.includes(stage);

/** Состояние внутри этапа: 21 — драфт или «На проверке у начальника ИБ», 22 — согласование или «На повторной проверке». */
export const ROUTE_STATES = ['draft', 'head_review', 'parties', 'head_recheck'] as const;
export type RouteState = (typeof ROUTE_STATES)[number];
export const STATE_NAMES: Record<RouteState, string> = {
  draft: 'Драфт',
  head_review: 'На проверке у начальника ИБ',
  parties: 'Согласование',
  head_recheck: 'На повторной проверке у начальника ИБ',
};
/** Состояние у версии на этапе: 21 и 22 — из колонки (нет — первое состояние этапа), остальные — null. */
export function stateOf(v: { stage: number; routeState: string | null }): RouteState | null {
  if (v.stage === FIRST_STAGE) return v.routeState === 'head_review' ? 'head_review' : 'draft';
  if (v.stage === PARTIES_STAGE) return v.routeState === 'head_recheck' ? 'head_recheck' : 'parties';
  return null;
}

/** Маршрут 1.2.0 (этапы 11–16, ADR-0024): только для подписей в истории и у старых версий. */
export const ROUTE_V2_NAMES: Record<number, string> = {
  11: 'Драфт', 12: 'Проверка сотрудниками', 13: 'Согласование начальника ИБ', 14: 'Согласование с ответственными лицами', 15: 'Перевод', 16: 'Подписание',
};
/** Старый маршрут (до 1.2.0): только для подписей в истории и у версий, утверждённых до обновления. */
export const LEGACY_STAGE_NAMES: Record<number, string> = {
  0: 'Автор', 1: 'Начальник ИБ', 2: 'Юридический отдел', 3: 'Утверждение правлением',
};
/** Перенос рабочих версий при обновлении на 1.2.0 (решение владельца): 0 → 11, 1 → 13, 2 и 3 → 14. */
export const ROUTE_FROM_LEGACY: Record<number, number> = { 0: 11, 1: 13, 2: 14, 3: 14 };

/**
 * Перенос на маршрут 1.11.0 (решение владельца): 11 и 12 → 21 «Драфт», 13 → 21 «На проверке у начальника ИБ» (задача
 * начальника сохраняется), 14 → 22 (все лица согласовали — «На повторной проверке»), 15 → 23, 16 → 24.
 */
export function routeV3Of(stage: number, partiesAllApproved: boolean): { stage: number; state: RouteState | null } | null {
  const v2 = stage <= 3 ? ROUTE_FROM_LEGACY[stage] : stage;
  switch (v2) {
    case 11: case 12: return { stage: 21, state: 'draft' };
    case 13: return { stage: 21, state: 'head_review' };
    case 14: return { stage: 22, state: partiesAllApproved ? 'head_recheck' : 'parties' };
    case 15: return { stage: 23, state: null };
    case 16: return { stage: 24, state: null };
    default: return null;
  }
}

export const stageName = (stage: number): string =>
  ROUTE.find((s) => s.stage === stage)?.name ?? ROUTE_V2_NAMES[stage] ?? LEGACY_STAGE_NAMES[stage] ?? `этап ${stage}`;

/** «Драфт — На проверке у начальника ИБ»: этап и, если отличается, состояние. */
export function placeName(stage: number, state: RouteState | null): string {
  if (!state || STATE_NAMES[state] === stageName(stage)) return stageName(stage);
  return `${stageName(stage)} — ${STATE_NAMES[state]}`;
}

/** Действия маршрута (утверждение на этапе 24 — отдельное действие «Утвердить»). */
export const DOC_ACTIONS = ['submit_head', 'head_approve', 'head_return', 'request_recheck', 'to_translation', 'head_reapprove', 'recheck_return', 'to_approval'] as const;
export type DocAction = (typeof DOC_ACTIONS)[number];

/**
 * Кто может действие: author — владелец или docs.manage; senior — старший над владельцем (ADR-0020, только блокеры);
 * head — начальник ИБ: отметка «Является начальником ИБ» (1.4.0), не супер-администратор.
 */
export type DocRole = 'author' | 'senior' | 'head';

interface Place { stage: number; state: RouteState | null }
export const MOVES: Record<DocAction, { from: Place; to: Place; label: string; who: readonly DocRole[]; comment?: string }> = {
  submit_head: { from: { stage: 21, state: 'draft' }, to: { stage: 21, state: 'head_review' }, label: 'Отправить на проверку начальнику ИБ', who: ['author'] },
  head_approve: { from: { stage: 21, state: 'head_review' }, to: { stage: 22, state: 'parties' }, label: 'Одобрить', who: ['head'] },
  head_return: { from: { stage: 21, state: 'head_review' }, to: { stage: 21, state: 'draft' }, label: 'Вернуть на доработку', who: ['head'], comment: 'Напишите, что нужно исправить' },
  request_recheck: { from: { stage: 22, state: 'parties' }, to: { stage: 22, state: 'head_recheck' }, label: 'Повторная проверка', who: ['author'] },
  to_translation: { from: { stage: 22, state: 'parties' }, to: { stage: 23, state: null }, label: 'Отправить на перевод', who: ['author'] },
  head_reapprove: { from: { stage: 22, state: 'head_recheck' }, to: { stage: 23, state: null }, label: 'Одобрить', who: ['head'] },
  recheck_return: { from: { stage: 22, state: 'head_recheck' }, to: { stage: 22, state: 'parties' }, label: 'Вернуть на доработку', who: ['head'], comment: 'Напишите, что нужно исправить' },
  to_approval: { from: { stage: 23, state: null }, to: { stage: 24, state: null }, label: 'На утверждение', who: ['author'] },
};
/** Действия, после которых документ уходит назад: новый круг, задача автору. */
export const RETURN_ACTIONS: readonly DocAction[] = ['head_return', 'recheck_return'];

/** Человек в «Сейчас у» и под этапом карточки; inactive — отключён (показывается «<ФИО> (отключён)»). */
export interface Person { id: string; fullName: string; inactive?: boolean }

/** Кто действует на этапе: люди; missingHead — этап начальника ИБ, а отметка «Начальник ИБ» никому не стоит. */
export interface Holders { people: Person[]; missingHead: boolean }

export interface HolderCtx {
  owner: Person;
  /** Держатель отметки «Является начальником ИБ» (активный); null — не назначен. */
  head: Person | null;
  /** Активные старшие над владельцем (ADR-0020): только блокеры, в маршруте не действуют. */
  seniors: readonly Person[];
}

/**
 * «Сейчас у»: кто действует на этапе. Одна функция для «Сейчас у», «кто действует» под этапами, «ждут вас» и задач
 * этапов. Начальник ИБ — только в двух состояниях: «На проверке» (21) и «На повторной проверке» (22). Остальное — автор.
 */
export function stageHolders(stage: number, state: RouteState | null, c: HolderCtx): Holders {
  if (state === 'head_review' || state === 'head_recheck') return c.head ? { people: [c.head], missingHead: false } : { people: [], missingHead: true };
  if (inRoute(stage)) return { people: [c.owner], missingHead: false };
  return { people: [], missingHead: false };
}

/** Действия, доступные пользователю в месте маршрута (без проверок данных — лиц, переводов, блокеров). */
export function allowedActions(stage: number, state: RouteState | null, roles: ReadonlySet<DocRole>): DocAction[] {
  return DOC_ACTIONS.filter((a) => MOVES[a].from.stage === stage && MOVES[a].from.state === state && MOVES[a].who.some((r) => roles.has(r)));
}

export const DEFAULT_REVIEW_MONTHS = 12;
/** За сколько дней до даты пересмотра владельцу ставится задача. */
export const REVIEW_NOTICE_DAYS = 30;

export const DOC_STATUSES = ['draft', 'in_approval', 'approved', 'review_overdue', 'in_review'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const DOC_STATUS_NAMES: Record<DocStatus, string> = {
  draft: 'Черновик',
  in_approval: 'На согласовании',
  approved: 'Утверждён',
  review_overdue: 'Пересмотр просрочен',
  in_review: 'На пересмотре',
};

/**
 * Статус документа. Хранить его нельзя: «пересмотр просрочен» зависит от сегодняшней даты.
 * Просрочка важнее «на пересмотре»: пока новая версия не утверждена, срок пересмотра нарушен.
 */
export function docStatus(d: { hasApproved: boolean; workingStage: number | null; reviewDue: string | null }, today: string): DocStatus {
  if (!d.hasApproved) return d.workingStage === null || d.workingStage === FIRST_STAGE || d.workingStage === 11 || d.workingStage === 0 ? 'draft' : 'in_approval';
  if (d.reviewDue !== null && d.reviewDue < today) return 'review_overdue';
  return d.workingStage !== null ? 'in_review' : 'approved';
}

/**
 * «Документ к пересмотру» (дашборд, этап 8): пересмотр просрочен или идёт, либо утверждённый документ
 * с датой пересмотра в ближайшие REVIEW_NOTICE_DAYS дней (включительно).
 */
export function needsReview(d: { status: DocStatus; reviewDue: string | null }, today: string): boolean {
  if (d.status === 'review_overdue' || d.status === 'in_review') return true;
  if (d.status !== 'approved' || d.reviewDue === null) return false;
  const left = (Date.parse(`${d.reviewDue}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return left <= REVIEW_NOTICE_DAYS;
}

/**
 * Дата + N месяцев (YYYY-MM-DD). Если такого дня в месяце нет — последний день месяца:
 * 31.01 + 1 мес. = 28.02 (29.02 в високосный год).
 */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Ссылка на файл в OnlyOffice: только http(s), без пробелов (ADR-0010). Если задан prefix (ONLYOFFICE_URL_PREFIX) —
 * тот же протокол и сервер (с портом), путь начинается с пути префикса. Сравниваются разобранные адреса, а не
 * строки: «https://oo.bank.tj.evil/» и «https://oo.bank.tj@evil/» префиксу «https://oo.bank.tj/» не подходят.
 */
export function isDocUrl(v: string, prefix = ''): boolean {
  if (v.length > 2000 || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    if (!((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0)) return false;
    if (!prefix) return true;
    const p = new URL(prefix);
    return u.protocol === p.protocol && u.host === p.host && !u.username && !u.password && u.pathname.startsWith(p.pathname);
  } catch {
    return false;
  }
}

/** Префикс ссылок OnlyOffice из .env: пусто или адрес http(s) без логина, параметров и якоря (проверка при старте). */
export function checkDocUrlPrefix(prefix: string): string | null {
  if (!prefix) return null;
  try {
    const p = new URL(prefix);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return 'адрес должен начинаться с http:// или https://';
    if (p.username || p.password || p.search || p.hash) return 'без логина, параметров (?) и якоря (#)';
    return null;
  } catch {
    return 'не похоже на адрес, пример: https://onlyoffice.bank.local/';
  }
}

// ---------------------------------------------------------------- реестр: фильтр по сроку и порядок

/** Фильтр «Срок пересмотра»: прошёл или наступает в ближайшие N дней (сегодня включительно). */
export const DOC_DUE_FILTERS = ['overdue', 'd30', 'd90', 'd365'] as const;
export type DocDueFilter = (typeof DOC_DUE_FILTERS)[number];
const DUE_DAYS: Record<Exclude<DocDueFilter, 'overdue'>, number> = { d30: 30, d90: 90, d365: 365 };

/** Подходит ли дата пересмотра под фильтр; dueTo — «не позже даты». Без даты пересмотра (не утверждён) — нет. */
export function dueMatches(reviewDue: string | null, today: string, due?: DocDueFilter, dueTo?: string): boolean {
  if (!due && !dueTo) return true;
  if (reviewDue === null) return false;
  if (dueTo && reviewDue > dueTo) return false;
  if (!due) return true;
  if (due === 'overdue') return reviewDue < today;
  const left = (Date.parse(`${reviewDue}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return left >= 0 && left <= DUE_DAYS[due];
}

/** Порядок реестра: «type» — деревом по типам (сначала «Политика»), «title» — по алфавиту. */
export const DOC_SORTS = ['type', 'title'] as const;
export type DocSort = (typeof DOC_SORTS)[number];

/** Тип «Политика» — первым (решение владельца 03.11.2026), остальные — по алфавиту. */
export const FIRST_DOC_TYPE = 'политика';

type Sortable = { number: number; title: string; type: { value: string } };
const ru = (a: string, b: string) => a.localeCompare(b, 'ru', { sensitivity: 'base' });
const byTitle = (x: Sortable, y: Sortable) => ru(x.title, y.title) || x.number - y.number;

export function compareTypes(a: string, b: string): number {
  const first = (v: string) => Number(v.trim().toLowerCase() !== FIRST_DOC_TYPE);
  return first(a) - first(b) || ru(a.trim(), b.trim());
}

export function docComparator(sort: DocSort): (x: Sortable, y: Sortable) => number {
  return sort === 'type' ? (x, y) => compareTypes(x.type.value, y.type.value) || byTitle(x, y) : byTitle;
}

// ---------------------------------------------------------------- задачи по этапам маршрута (1.6.3, маршрут 1.11.0)

/**
 * Состояние маршрута для задачи этапа: версия, круг, этап и состояние внутри этапа. Другое состояние — задача прежнего
 * закрывается, новая создаётся; то же состояние — повтора нет (как dedupe_key у «ждёт вас»).
 */
export function stageState(v: { id: string; round: number; stage: number }, state: RouteState | null): string {
  return `${v.id}:${v.round}:${v.stage}${state ? `:${state}` : ''}`;
}

/** Ключ срока задачи: этап и, у начальника ИБ, состояние «на проверке» — 21h и 22h. */
export type StageDaysKey = '21' | '21h' | '22h' | '23' | '24';
export const stageDaysKey = (stage: number, state: RouteState | null): StageDaysKey | null =>
  state === 'head_review' ? '21h' : state === 'head_recheck' ? '22h' : stage === 21 ? '21' : stage === 23 ? '23' : stage === 24 ? '24' : null;

/**
 * Сроки задач этапов, рабочие дни; «Параметры портала». Новый ключ (1.11.0): прежний documents.stageDays (этапы 11–16)
 * остаётся для 1.10.0 после отката. Этап 22 — ближайший срок ответственного лица, 23 с языками — ближайший срок языка.
 */
export const DOC_STAGE_DAYS_KEY = 'documents.stageDays.v3';
export const DEFAULT_STAGE_DAYS: Record<StageDaysKey, number> = { '21': 5, '21h': 3, '22h': 3, '23': 3, '24': 5 };
export type StageDays = Record<StageDaysKey, number>;
/** Чья задача на этапе: тот, кто продвигает документ («Сейчас у»). */
export type StageTaskRole = 'holder';

export interface StageTaskText {
  title: string;
  requirement: string;
}

/** Название и «что требуется» задачи этапа. label — «#12 «Политика ИБ»»; languages — не используется с 1.11.0 (этап 23 — один текст). */
export function stageTaskText(stage: number, state: RouteState | null, x: { label: string; versionNo: number; languages: readonly string[] }): StageTaskText {
  const t = (verb: string, requirement: string) => ({ title: `${verb}: документ ${x.label}`, requirement });
  if (state === 'head_review') return t('Проверить', `проверить версию ${x.versionNo} по ссылке OnlyOffice: «Одобрить» или «Вернуть на доработку» с комментарием.`);
  if (state === 'head_recheck') return t('Повторно проверить', `проверить доработанную версию ${x.versionNo}: «Одобрить» — на перевод, «Вернуть на доработку» — с комментарием.`);
  switch (stage) {
    case 21: return t('Подготовить драфт', 'подготовить документ в OnlyOffice и отправить его на проверку начальнику ИБ.');
    case 22: return t('Согласовать с ответственными лицами', 'добавить ответственных лиц, отметить их согласование и отправить документ на перевод или на повторную проверку.');
    // Языки добавляются только на этапе 23 — после создания задачи: текст один, срок — ближайший срок языка без ссылки.
    case 23: return t('Перевести и отправить на утверждение', 'добавить языки перевода и ссылки на переводы в OnlyOffice, если они нужны, затем отправить документ на утверждение.');
    case SIGN_STAGE: return t('Утвердить документ', 'загрузить подписанный PDF и исходный документ Word (и Word каждого перевода), указать дату утверждения и утвердить.');
    default: return t('Документ', 'продвинуть документ по маршруту.');
  }
}

/** Описание задачи этапа: документ, тип, этап, что требуется. */
export function stageTaskDescription(x: { label: string; type: string; stage: number; state: RouteState | null; versionNo: number; requirement: string }): string {
  const pos = ROUTE.findIndex((s) => s.stage === x.stage);
  return [
    `Документ: ${x.label}`,
    `Тип: ${x.type}`,
    `Этап: ${placeName(x.stage, x.state)}${pos >= 0 ? ` (${pos + 1} из ${ROUTE.length})` : ''}, версия ${x.versionNo}`,
    `Что требуется: ${x.requirement}`,
    '',
    'Действие выполняется в карточке документа («Документы»). Задача закроется сама, когда документ перейдёт дальше.',
  ].join('\n');
}
