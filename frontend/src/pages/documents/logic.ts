// Раздел «Документы»: подписи и тона без React — проверяются юнит-тестами.
import type { DocAction, DocDetail, DocDue, DocItem, DocSort, DocStatus } from '../../api/documents';
import { formatDate } from '../registers/logic';

/** Тон плашки статуса: как в прототипе — согласование синим, просрочка красным, пересмотр оранжевым. */
export const STATUS_TONE: Record<DocStatus, string> = {
  draft: '',
  in_approval: 'acc',
  approved: 'low',
  review_overdue: 'crit',
  in_review: 'high',
};

/** «Версия 3 · ред. 3.1» — номер ставит портал, редакция — для отображения. */
export function versionLabel(v: { no: number; edition: string }): string {
  return v.edition ? `${v.no} · ред. ${v.edition}` : String(v.no);
}

/** Кнопки маршрута 1.11.0 (ADR-0042); тексты — как в backend (status.ts, MOVES). */
export const ACTION_LABEL: Record<DocAction, string> = {
  submit_head: 'Отправить на проверку начальнику ИБ',
  head_approve: 'Одобрить',
  head_return: 'Вернуть на доработку',
  request_recheck: 'Повторная проверка',
  to_translation: 'Отправить на перевод',
  head_reapprove: 'Одобрить',
  recheck_return: 'Вернуть на доработку',
  to_approval: 'На утверждение',
};

/** Возвраты: вторичные кнопки, комментарий обязателен. */
export const RETURN_ACTIONS: readonly DocAction[] = ['head_return', 'recheck_return'];
export const isReturn = (a: DocAction) => RETURN_ACTIONS.includes(a);

/** Уведомление после действия. */
export const ACTION_DONE: Record<DocAction, string> = {
  submit_head: 'Документ отправлен на проверку начальнику ИБ',
  head_approve: 'Документ одобрен: автор согласует его с ответственными лицами',
  head_return: 'Документ возвращён автору на доработку',
  request_recheck: 'Документ отправлен на повторную проверку начальнику ИБ',
  to_translation: 'Документ отправлен на перевод',
  head_reapprove: 'Документ одобрен повторно: он на переводе',
  recheck_return: 'Документ возвращён автору: он остаётся на согласовании',
  to_approval: 'Документ отправлен на утверждение',
};

export const SELF_APPROVED = 'Одобрено автором (начальник ИБ) — без независимого согласования';

/** Строка истории согласования; решения маршрута 1.11.0 — по точному виду (event), прежние — по decision. */
export function historyText(h: DocDetail['history'][number]): string {
  const self = h.selfApproved ? ' сам(а) как автор и начальник ИБ — без независимого согласования' : '';
  switch (h.event) {
    case 'head_review_requested': return `отправил(а) версию ${h.versionNo} на проверку начальнику ИБ`;
    case 'head_approved': return `одобрил(а) версию ${h.versionNo}${self}`;
    case 'head_recheck_requested': return `отправил(а) версию ${h.versionNo} на повторную проверку начальнику ИБ`;
    case 'head_reapproved': return `повторно одобрил(а) версию ${h.versionNo}${self}`;
    case 'unchanged_confirmed': return `отправил(а) версию ${h.versionNo} на перевод. ${h.comment}`;
    case 'translations_done': return `отправил(а) версию ${h.versionNo} на утверждение${h.comment ? `. ${h.comment}` : ''}`;
    case 'approved_final': return `утвердил(а) версию ${h.versionNo}. ${h.comment}`;
    default: break;
  }
  switch (h.decision) {
    case 'submitted':
      return `отправил(а) версию ${h.versionNo} на согласование`;
    case 'approved':
      if (h.stage === 3) return `утвердил(а) версию ${h.versionNo}`;
      if (h.stage === 13) return `согласовал(а) версию ${h.versionNo}${self}`;
      if (h.stage === 14) return `ознакомлен(а) с финальной версией ${h.versionNo}`;
      return `согласовал(а) этап «${h.stageName}», версия ${h.versionNo}`;
    case 'moved':
      return `перевёл(а) версию ${h.versionNo}: «${h.stageName}» → «${h.toStageName ?? ''}»${h.comment ? `. ${h.comment}` : ''}`;
    case 'returned':
      return `вернул(а) версию ${h.versionNo} на доработку с этапа «${h.stageName}»: ${h.comment}`;
    case 'skipped':
      return `этап «${h.stageName}» не требуется (версия ${h.versionNo}). ${h.comment}`;
    case 'revision_started':
      return `создал(а) версию ${h.versionNo} для пересмотра${h.comment ? `: ${h.comment}` : ''}`;
    case 'signed':
      return `загрузил(а) подписанную версию ${h.versionNo}. ${h.comment}`;
    case 'migrated':
      return `версия ${h.versionNo}: ${h.comment}`;
    case 'cancelled':
      return `отменил(а) пересмотр, версия ${h.versionNo} — в истории: ${h.comment}`;
  }
}

/** Пересмотр: «до 27.10.2027», «просрочен с 01.01.2026» или пусто для неутверждённого. */
export function reviewLabel(d: Pick<DocItem, 'reviewDue' | 'status'>): string {
  if (!d.reviewDue) return '—';
  return d.status === 'review_overdue' ? `просрочен с ${formatDate(d.reviewDue)}` : formatDate(d.reviewDue);
}

/** Подпись под точками маршрута: «ждёт вас», название текущего этапа или ничего. */
/** «Сейчас у» (1.4.0): кто действует на этапе; этап начальника ИБ без отметки — «Начальник ИБ не назначен». */
export function holdersLabel(h: { people: readonly { fullName: string; inactive?: boolean }[]; missingHead: boolean } | null): string {
  if (!h) return '';
  if (h.missingHead) return 'Начальник ИБ не назначен';
  return h.people.length ? h.people.map((p) => (p.inactive ? `${p.fullName} (отключён)` : p.fullName)).join(', ') : 'никто';
}

/** Подсказка у «Сейчас у», если там отключённый пользователь (автор документа). */
export const OWNER_HINT = 'Владельца можно сменить';

/** Под этапом карточки: кто действует; пустая строка — показывать нечего (старый маршрут). */
export function approversLabel(r: { approvers: readonly string[]; missingHead: boolean }): string {
  if (r.missingHead) return 'Начальник ИБ не назначен';
  return r.approvers.join(', ');
}

export function stageHint(d: Pick<DocItem, 'waitingForMe' | 'stageName'>): string {
  if (d.waitingForMe) return 'ждёт вас';
  return d.stageName ?? '';
}

/** Фильтр «Срок пересмотра»; «До даты» — отдельное поле даты (dueTo). */
export const DUE_FILTERS: { key: DocDue; title: string }[] = [
  { key: 'overdue', title: 'Срок прошёл' },
  { key: 'd30', title: 'В ближайшие 30 дней' },
  { key: 'd90', title: 'В ближайшие 90 дней' },
  { key: 'd365', title: 'В ближайший год' },
];
export const isDocDue = (v: string | null): v is DocDue => DUE_FILTERS.some((f) => f.key === v);

export const SORTS: { key: DocSort; title: string }[] = [
  { key: 'type', title: 'По типам' },
  { key: 'title', title: 'По алфавиту' },
];
/** Порядок по умолчанию — деревом по типам. */
export const parseSort = (v: string | null | undefined): DocSort => (v === 'title' ? 'title' : 'type');

/** Дерево по типам: соседние документы одного типа — одна ветка (порядок задаёт backend, сначала «Политика»). */
export function groupByType<T extends Pick<DocItem, 'type'>>(items: readonly T[]): { type: T['type']; items: T[] }[] {
  const out: { type: T['type']; items: T[] }[] = [];
  for (const d of items) {
    const last = out[out.length - 1];
    if (last && last.type.id === d.type.id) last.items.push(d);
    else out.push({ type: d.type, items: [d] });
  }
  return out;
}

/* ---------- Справочник «Ответственные лица» (1.6.7) ---------- */

/** Текст для сравнения — как в backend (lib/person-key.ts): пробелы схлопнуты, регистр нижний, «ё» = «е» (1.13.5). */
export function normalizePersonText(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru').replace(/ё/g, 'е');
}

/** «Тот же человек» в документе: совпали ФИО и подразделение или должность. Окончательно проверяет backend (409). */
export function personKey(fullName: string, position: string): string {
  return `${normalizePersonText(fullName)}\u0000${normalizePersonText(position)}`;
}

interface PersonLike {
  fullName: string;
  position: string;
  /** Почта (1.13.6): ищется тоже. */
  email?: string;
}

/** Поиск по ФИО, должности и почте (1.13.6): все слова запроса должны встретиться (в любом поле). */
export function matchPerson(p: PersonLike, query: string): boolean {
  const words = normalizePersonText(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = `${normalizePersonText(p.fullName)} ${normalizePersonText(p.position)} ${normalizePersonText(p.email ?? '')}`;
  return words.every((w) => hay.includes(w));
}

/** По ФИО, затем по должности — по-русски. */
export function byPersonName(a: PersonLike, b: PersonLike): number {
  return a.fullName.localeCompare(b.fullName, 'ru') || a.position.localeCompare(b.position, 'ru');
}

/** Записи справочника с тем же ФИО (предупреждение об однофамильце; не запрет). */
export function sameNamePeople<T extends PersonLike & { id: string }>(items: readonly T[], fullName: string, exceptId?: string): T[] {
  const n = normalizePersonText(fullName);
  return n ? items.filter((i) => i.id !== exceptId && normalizePersonText(i.fullName) === n) : [];
}
