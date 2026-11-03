// Документы (этап 6; маршрут 1.2.0 — ADR-0024): этапы маршрута, статус и дата пересмотра — чистые функции без БД.

/**
 * Маршрут 1.2.0: этапы 11–16. Номера не 1–6 нарочно: backend 1.1.0 после отката не узнаёт этих этапов и не двигает
 * документ, а не принимает «Проверку сотрудниками» за этап «Начальник ИБ» (ADR-0024).
 */
export const ROUTE = [
  { stage: 11, name: 'Драфт' },
  { stage: 12, name: 'Проверка сотрудниками' },
  { stage: 13, name: 'Согласование начальника ИБ' },
  { stage: 14, name: 'Согласование с ответственными лицами' },
  { stage: 15, name: 'Перевод' },
  { stage: 16, name: 'Подписание' },
] as const;

export const FIRST_STAGE = 11;
export const SIGN_STAGE = 16;

/** Старый маршрут (до 1.2.0): только для подписей в истории и у версий, утверждённых до обновления. */
export const LEGACY_STAGE_NAMES: Record<number, string> = {
  0: 'Автор', 1: 'Начальник ИБ', 2: 'Юридический отдел', 3: 'Утверждение правлением',
};
/** Перенос рабочих версий при обновлении (решение владельца): 0 → 11, 1 → 13, 2 и 3 → 14. */
export const ROUTE_FROM_LEGACY: Record<number, number> = { 0: 11, 1: 13, 2: 14, 3: 14 };

export const stageName = (stage: number): string =>
  ROUTE.find((s) => s.stage === stage)?.name ?? LEGACY_STAGE_NAMES[stage] ?? `этап ${stage}`;

/** Действия маршрута: переход вперёд или возврат на доработку (этап 16 — отдельное действие «подписать»). */
export const DOC_ACTIONS = ['to_review', 'to_head', 'approve', 'ack_final', 'to_signing', 'return'] as const;
export type DocAction = (typeof DOC_ACTIONS)[number];

/**
 * Кто может действие: author — владелец или docs.manage; senior — старший над владельцем (ADR-0020);
 * head — начальник ИБ: отметка «Является начальником ИБ» (1.4.0), не супер-администратор.
 */
export type DocRole = 'author' | 'senior' | 'head';

export const MOVES: Record<DocAction, { from: readonly number[]; to: number; label: string; who: readonly DocRole[] }> = {
  to_review: { from: [11], to: 12, label: 'Отправить на проверку сотрудникам', who: ['author'] },
  to_head: { from: [12], to: 13, label: 'На согласование начальнику ИБ', who: ['author', 'senior'] },
  approve: { from: [13], to: 14, label: 'Согласовать', who: ['head'] },
  ack_final: { from: [14], to: 15, label: 'Ознакомлен с финальной версией', who: ['head'] },
  to_signing: { from: [15], to: 16, label: 'На подписание', who: ['head', 'senior'] },
  return: { from: [13, 14, 15], to: 11, label: 'Вернуть на доработку', who: ['head'] },
};

/** Человек в «Сейчас у» и под этапом карточки; inactive — отключён (показывается «<ФИО> (отключён)»). */
export interface Person { id: string; fullName: string; inactive?: boolean }

/** Кто действует на этапе: люди; missingHead — этап начальника ИБ, а отметка «Начальник ИБ» никому не стоит. */
export interface Holders { people: Person[]; missingHead: boolean }

export interface HolderCtx {
  owner: Person;
  /** Держатель отметки «Является начальником ИБ» (активный); null — не назначен. */
  head: Person | null;
  /** Активные старшие над владельцем (ADR-0020). */
  seniors: readonly Person[];
  /** Есть язык перевода без файла (этап 15): файлы прикладывает автор (1.4.0, переводчик — не пользователь портала). */
  translationsMissing: boolean;
}

const uniq = (list: readonly Person[]) => list.filter((p, i) => list.findIndex((x) => x.id === p.id) === i);

/**
 * «Сейчас у» (релиз 1.4.0, шаг 5): кто действует на этапе. Одна функция для «Сейчас у» в списке и карточке, для
 * «кто действует» под этапами и для «ждут вас» (цифра у «Документы»): документ ждёт пользователя, только если он здесь.
 *   11, 12, 16 — автор (владелец): правит драфт, отправляет дальше, подписывает. На 12 перевести дальше может и старший
 *               над автором, на 16 подписать — и начальник ИБ, но ждёт документ автора (решение владельца 8);
 *   13, 14     — начальник ИБ (отметка); нет отметки — «Начальник ИБ не назначен»;
 *   15         — есть язык без файла — автор (прикладывает файлы перевода; переводчик не пользователь портала, 1.4.0);
 *               файлы есть (или языков нет) — начальник ИБ и старшие над автором.
 */
export function stageHolders(stage: number, c: HolderCtx): Holders {
  if (stage === 13 || stage === 14) return c.head ? { people: [c.head], missingHead: false } : { people: [], missingHead: true };
  if (stage === 15) {
    if (c.translationsMissing) return { people: [c.owner], missingHead: false };
    const people = uniq([...(c.head ? [c.head] : []), ...c.seniors]);
    return { people, missingHead: people.length === 0 };
  }
  if (stage === 11 || stage === 12 || stage === SIGN_STAGE) return { people: [c.owner], missingHead: false };
  return { people: [], missingHead: false };
}

/**
 * Переход фиксирует файл версии (pdf или docx): 13 → 14 — файл автора как «версия при согласовании начальником ИБ»
 * (без загрузки, 1.4.0), 14 → 15 — «финальная» (загружает начальник ИБ).
 */
export const FIXED_FILE: Partial<Record<DocAction, { kind: 'head_approved' | 'final'; name: string }>> = {
  approve: { kind: 'head_approved', name: 'Версия при согласовании начальником ИБ' },
  ack_final: { kind: 'final', name: 'Финальная версия' },
};

/** Действия, доступные пользователю на этапе (без проверок данных — файлов, лиц, переводов). */
export function allowedActions(stage: number, roles: ReadonlySet<DocRole>): DocAction[] {
  return DOC_ACTIONS.filter((a) => MOVES[a].from.includes(stage) && MOVES[a].who.some((r) => roles.has(r)));
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
  if (!d.hasApproved) return d.workingStage === null || d.workingStage === FIRST_STAGE || d.workingStage === 0 ? 'draft' : 'in_approval';
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

// ---------------------------------------------------------------- задачи по этапам маршрута (1.6.3)

/**
 * Состояние маршрута для задачи этапа: версия, круг, этап и фаза этапа 15. Другое состояние — задача прежнего этапа
 * закрывается, новая создаётся; то же состояние — повтора нет (как dedupe_key у «ждёт вас»).
 */
export function stageState(v: { id: string; round: number; stage: number }, phase: StagePhase | null): string {
  return `${v.id}:${v.round}:${v.stage}${phase ? `:${phase}` : ''}`;
}

/** Фаза этапа 15: не хватает файлов перевода — у автора; переводы готовы — у начальника ИБ и старших. */
export type StagePhase = 'translate' | 'ready';
/** Чья задача на этапе: тот, кто продвигает документ («Сейчас у»), или проверяющий сотрудник на этапе 12. */
export type StageTaskRole = 'holder' | 'reviewer';

/** Сроки задач этапов по умолчанию, рабочие дни (решение владельца 03.11.2026); «Параметры портала». */
export const DOC_STAGE_DAYS_KEY = 'documents.stageDays';
export const DEFAULT_STAGE_DAYS = { '11': 5, '12': 3, '13': 3, '15': 3, '16': 5 } as const;
export type StageDays = Record<keyof typeof DEFAULT_STAGE_DAYS, number>;
/** Роль, которая проверяет документ на этапе 12 (1.6.4); не выбрана — все сотрудники ИБ. «Параметры портала». */
export const DOC_REVIEW_ROLE_KEY = 'documents.reviewRole';

export interface StageTaskText {
  title: string;
  requirement: string;
}

/** Название и «что требуется» задачи этапа. label — «#12 «Политика ИБ»», languages — языки без файла (этап 15). */
export function stageTaskText(
  stage: number, phase: StagePhase | null, role: StageTaskRole, x: { label: string; versionNo: number; languages: readonly string[] },
): StageTaskText {
  const t = (verb: string, requirement: string) => ({ title: `${verb}: документ ${x.label}`, requirement });
  if (role === 'reviewer') return t('Проверить', 'прочитать документ и оставить комментарии в его карточке, пока он на проверке сотрудниками.');
  switch (stage) {
    case 11: return t('Подготовить драфт', 'приложить файл документа (pdf или docx) и отправить его на проверку сотрудникам.');
    case 12: return t('Учесть комментарии', 'учесть комментарии сотрудников, при необходимости заменить файл и отправить документ на согласование начальнику ИБ.');
    case 13: return t('Согласовать', `согласовать версию ${x.versionNo} или вернуть документ на доработку с комментарием.`);
    case 14: return t('Согласовать с ответственными лицами', 'добавить ответственных лиц, если их ещё нет, отметить их согласование и принять финальную версию.');
    case 15: return phase === 'translate'
      ? t('Приложить переводы', `приложить файлы перевода${x.languages.length ? `: ${x.languages.join(', ')}` : ''}.`)
      : t('Отправить на подписание', 'переводы готовы — отправить документ на подписание.');
    case SIGN_STAGE: return t('Загрузить подписанный документ', 'загрузить подписанный PDF и указать дату подписания.');
    default: return t('Документ', 'продвинуть документ по маршруту.');
  }
}

/** Описание задачи этапа: документ, тип, этап, что требуется. */
export function stageTaskDescription(x: { label: string; type: string; stage: number; versionNo: number; requirement: string }): string {
  const pos = ROUTE.findIndex((s) => s.stage === x.stage);
  return [
    `Документ: ${x.label}`,
    `Тип: ${x.type}`,
    `Этап: ${stageName(x.stage)}${pos >= 0 ? ` (${pos + 1} из ${ROUTE.length})` : ''}, версия ${x.versionNo}`,
    `Что требуется: ${x.requirement}`,
    '',
    'Действие выполняется в карточке документа («Документы»). Задача закроется сама, когда документ перейдёт на следующий этап.',
  ].join('\n');
}
