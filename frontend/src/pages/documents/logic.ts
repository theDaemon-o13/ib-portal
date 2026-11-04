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

/** Кнопки маршрута (ADR-0024); тексты — как в backend (status.ts, MOVES). */
export const ACTION_LABEL: Record<DocAction, string> = {
  to_review: 'Отправить на проверку сотрудникам',
  to_head: 'На согласование начальнику ИБ',
  approve: 'Согласовать',
  ack_final: 'Ознакомлен с финальной версией',
  to_signing: 'На подписание',
  return: 'Вернуть на доработку',
};

/** Переход фиксирует файл версии (pdf или docx). */
/** Действия, где файл загружается (14 → 15). 13 → 14 с 1.4.0 — без загрузки: выбирается файл автора. */
export const FIXED_FILE_LABEL: Partial<Record<DocAction, string>> = {
  ack_final: 'Финальная версия (pdf или docx)',
};

type VersionFile = DocDetail['files'][number];

/** Файлы автора для согласования 13 → 14 (pdf, docx); по умолчанию — последний загруженный. */
export function authorFiles(files: readonly VersionFile[]): { list: VersionFile[]; latest: VersionFile | null } {
  const list = files.filter((f) => f.marks.includes('Файл драфта'));
  const latest = [...list].sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0))[0] ?? null;
  return { list, latest };
}

/** Уведомление после действия. */
export const ACTION_DONE: Record<DocAction, string> = {
  to_review: 'Документ отправлен на проверку сотрудникам',
  to_head: 'Документ отправлен на согласование начальнику ИБ',
  approve: 'Документ согласован',
  ack_final: 'Финальная версия принята, документ — на переводе',
  to_signing: 'Документ отправлен на подписание',
  return: 'Документ возвращён автору на доработку',
};

export const SELF_APPROVED = 'Согласовано автором (начальник ИБ) — без независимого согласования';

/** Строка истории согласования. */
export function historyText(h: DocDetail['history'][number]): string {
  switch (h.decision) {
    case 'submitted':
      return `отправил(а) версию ${h.versionNo} на согласование`;
    case 'approved':
      if (h.stage === 3) return `утвердил(а) версию ${h.versionNo}`;
      if (h.stage === 13) return `согласовал(а) версию ${h.versionNo}${h.selfApproved ? ' сам(а) как автор и начальник ИБ — без независимого согласования' : ''}`;
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

/** Текст для сравнения — как в backend (lib/person-key.ts): пробелы схлопнуты, регистр нижний. */
export function normalizePersonText(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
}

/** «Тот же человек» в документе: совпали ФИО и подразделение или должность. Окончательно проверяет backend (409). */
export function personKey(fullName: string, position: string): string {
  return `${normalizePersonText(fullName)}\u0000${normalizePersonText(position)}`;
}

interface PersonLike {
  fullName: string;
  position: string;
}

/** Поиск по ФИО и должности: все слова запроса должны встретиться (в любом поле). */
export function matchPerson(p: PersonLike, query: string): boolean {
  const words = normalizePersonText(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = `${normalizePersonText(p.fullName)} ${normalizePersonText(p.position)}`;
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
