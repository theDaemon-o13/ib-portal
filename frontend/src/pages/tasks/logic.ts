// Чистые функции доски задач: без React, покрыты тестами.
import type { Task } from '../../api/tasks';

/** Цвет категории по системному ключу или тону справочника (как в прототипе: почта, проект, оперплан, реестр). */
export function categoryTone(c: Task['category']): string {
  if (c.systemKey === 'mail') return 'src-mail';
  if (c.systemKey === 'register') return 'src-reg';
  return c.color ? `tone-${c.color}` : '';
}

/** Колонка: сначала ближний срок, без срока — в конце; затем по номеру. */
export function sortColumn(list: readonly Task[]): Task[] {
  return [...list].sort((a, b) => {
    if (a.dueDate !== b.dueDate) {
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    return a.number - b.number;
  });
}

/** Подпись срока на карточке: «просрочено · 05.11.2026», «сегодня», «05.11.2026», «без срока». */
export function dueLabel(t: Pick<Task, 'dueDate' | 'overdue' | 'completedAt'>, today: string): { text: string; late: boolean } {
  if (!t.dueDate) return { text: 'без срока', late: false };
  const d = `${t.dueDate.slice(8, 10)}.${t.dueDate.slice(5, 7)}.${t.dueDate.slice(0, 4)}`;
  if (t.overdue) return { text: `просрочено · ${d}`, late: true };
  if (!t.completedAt && t.dueDate === today) return { text: `сегодня · ${d}`, late: false };
  return { text: d, late: false };
}

export function initials(fullName: string): string {
  const letters = fullName.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).map((w) => w[0]);
  return (letters.slice(-2).join('') || '?').toUpperCase();
}

/** Загрузка сотрудников: открытые задачи на доске по ответственным, по убыванию. */
export function workload(list: readonly Task[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of list) {
    if (t.completedAt || t.archived) continue;
    const name = t.assignee?.fullName ?? 'Не назначен';
    m.set(name, (m.get(name) ?? 0) + 1);
  }
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

/** Сегодня по часам браузера — только для подписей; просрочку считает сервер. */
export function todayLocal(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// ---------------------------------------------------------------- процесс по кнопкам (релиз 1.2.0, ADR-0022)
// Решает всегда backend: кнопки берутся из task.actions, здесь — только подписи, подсказки и нужен ли комментарий.

export type ProcessAction = Task['actions'][number];

export const ACTION_LABEL: Record<ProcessAction, string> = {
  take: 'Взять себе', start: 'Взять в работу', submit: 'Отправить на проверку', complete: 'Завершить', accept: 'Принять', return: 'Вернуть в работу',
};
/** Колонка, в которую ведёт кнопка (системный ключ). */
export const ACTION_TARGET: Record<ProcessAction, string> = { take: 'assigned', start: 'work', submit: 'review', complete: 'done', accept: 'done', return: 'work' };

export interface StatusFlags { id: string; systemKey: string | null; commentForward: boolean; commentReturn: boolean }

/** Как на backend: переход в колонку правее — признак «вперёд», левее — «при возврате» (порядок — как в справочнике). */
export function needsComment(statuses: readonly StatusFlags[], fromId: string, toId: string): boolean {
  const from = statuses.findIndex((s) => s.id === fromId);
  const to = statuses.findIndex((s) => s.id === toId);
  if (from < 0 || to < 0 || from === to) return false;
  const target = statuses[to];
  return to > from ? !!target?.commentForward : !!target?.commentReturn;
}

export function actionNeedsComment(statuses: readonly StatusFlags[], t: Pick<Task, 'status'>, a: ProcessAction): boolean {
  const to = statuses.find((s) => s.systemKey === ACTION_TARGET[a]);
  return !!to && needsComment(statuses, t.status.id, to.id);
}

/** Почему кнопок процесса нет — подсказка в карточке; null — объяснять нечего. */
export function processHint(t: Pick<Task, 'status' | 'assignee' | 'reviewer' | 'actions' | 'archived'>, meId: string, perms: readonly string[]): string | null {
  if (t.archived || t.actions.length) return null;
  const key = t.status.systemKey;
  if (key === 'review') {
    // С 1.4.0 принимает проверяющий, зафиксированный при отправке (ADR-0028); без него — задача отправлена до 1.4.0.
    if (t.reviewer) return t.assignee?.id === meId ? `Задачу проверяет ${t.reviewer.fullName}` : `Принять или вернуть может только проверяющий: ${t.reviewer.fullName}`;
    if (t.assignee?.id === meId) return 'Свою задачу нельзя принять: это делает автор задачи или руководитель';
    return perms.includes('tasks.review')
      ? 'Принять может автор задачи или руководитель исполнителя'
      : 'Принимает автор задачи или руководитель исполнителя с правом «Задачи: проверка»';
  }
  if ((key === 'assigned' || key === 'work') && t.assignee?.id !== meId) return 'Дальше задачу двигает исполнитель';
  return null;
}

/** Кнопка следующего шага на карточке доски: своя работа или «Проверить» (открывает карточку). */
export function cardStep(t: Pick<Task, 'actions'>): { action: ProcessAction | 'review'; label: string } | null {
  if (t.actions.includes('accept')) return { action: 'review', label: 'Проверить' };
  const a = t.actions.find((x) => x === 'take' || x === 'start' || x === 'submit' || x === 'complete');
  if (!a) return null;
  return { action: a, label: a === 'submit' ? 'На проверку' : ACTION_LABEL[a] };
}

// ---------------------------------------------------------------- панель «Загрузка сотрудников»

/** С какой ширины окна панель по умолчанию открыта: пять колонок по 180 px и панель 304 px помещаются без прокрутки. */
export const WORKLOAD_OPEN_FROM = 1600;
export const WORKLOAD_KEY = 'ibportal.tasks.workload';

/** Запомненный выбор ('1' / '0') главнее ширины окна; без выбора — открыта только на широком экране. */
export function workloadOpen(stored: string | null, viewportWidth: number): boolean {
  if (stored === '1') return true;
  if (stored === '0') return false;
  return viewportWidth >= WORKLOAD_OPEN_FROM;
}

/** Общая задача (1.6.4): «Могут взять: Иванов И., Петров П. и ещё 3» — на карточке коротко, полный список — в подсказке. */
/** Чип «Могут взять» на карточке (1.6.5): первое имя усекается, остальные — числом «+N»; полный список — в подсказке. */
export function candidatesChip(list: readonly { fullName: string }[]): { first: string; more: number } {
  return { first: list[0]?.fullName ?? '', more: Math.max(0, list.length - 1) };
}

export function candidatesLabel(list: readonly { fullName: string }[], max = 2): string {
  const names = list.map((c) => c.fullName);
  return names.length > max ? `${names.slice(0, max).join(', ')} и ещё ${names.length - max}` : names.join(', ');
}

// ---------------------------------------------------------------- цепочки задач (1.7.0, ADR-0035)

// Снятие почтовых префиксов — то же, что в backend (lib/title-key.ts, stripReplyPrefixes): название новой цепочки
// из заголовка задачи. Ключ и похожесть считает только backend.
const WITH_COLON = /^(?:re(?:\s*[[(]\d+[\])])?|fwd?|aw|wg|sv|vs|tr|rv|отв|ответ|во|пересл|переслать|переадр)\.?\s*[:：]\s*/iu;
const BARE = /^(?:re(?:\s*[[(]\d+[\])])?|fwd?)\s+(?=\S)/iu;
const TAG = /^[[(](?:ext|external|внешн(?:ее|ий|яя)|внешнее письмо)[\])]\s*/iu;

/** «RE: FW: Тестовая тема» → «Тестовая тема»: название новой цепочки по заголовку задачи. */
export function chainTitleOf(title: string): string {
  let s = title.replace(/\s+/g, ' ').trim();
  for (;;) {
    const next = s.replace(TAG, '').replace(WITH_COLON, '').replace(BARE, '').replace(/^[\s\-–—:;,.]+/u, '');
    if (next === s) return s || title.trim();
    s = next;
  }
}

/** «1 задача», «3 задачи», «5 задач». */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Счётчик цепочки: «3 задачи, 1 выполнена». */
export function chainCounts(c: { total: number; done: number }): string {
  return `${c.total} ${plural(c.total, 'задача', 'задачи', 'задач')}, ${c.done} ${plural(c.done, 'выполнена', 'выполнены', 'выполнено')}`;
}

/** Пометка варианта подсказки по группе (порядок групп задаёт backend). */
export const SUGGEST_NOTE: Record<'open_exact' | 'closed_unfinished' | 'open_similar' | 'closed_recent', string | null> = {
  open_exact: null,
  closed_unfinished: 'закрыта, есть незавершённые задачи',
  open_similar: 'похожая тема',
  closed_recent: 'закрыта',
};

export const GROUP_CHAINS_KEY = 'ibportal.tasks.groupChains';

/** Поиск над доской: номер («#12» или «12»), название задачи, название её цепочки — без регистра, «ё» = «е». */
export function matchTask(t: Pick<Task, 'number' | 'title' | 'chain'>, q: string): boolean {
  const norm = (s: string) => s.toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const s = norm(q.trim());
  if (!s) return true;
  if (/^#?\d+$/.test(s) && String(t.number) === s.replace('#', '')) return true;
  return norm(t.title).includes(s) || (!!t.chain && norm(t.chain.title).includes(s));
}

export type ColumnEntry =
  | { kind: 'task'; t: Task }
  | { kind: 'chain'; chain: NonNullable<Task['chain']>; tasks: Task[] };

/**
 * Колонка доски с группировкой по цепочкам: две и больше задач одной цепочки в колонке — одна свёрнутая карточка
 * на месте первой из них; одна задача цепочки в колонке — обычная карточка с меткой цепочки (решение владельца
 * 04.11.2026). Без группировки — задачи как есть.
 */
export function columnEntries(items: readonly Task[], group: boolean): ColumnEntry[] {
  if (!group) return items.map((t) => ({ kind: 'task', t }));
  const out: ColumnEntry[] = [];
  const byChain = new Map<string, Extract<ColumnEntry, { kind: 'chain' }>>();
  for (const t of items) {
    if (!t.chain) {
      out.push({ kind: 'task', t });
      continue;
    }
    const g = byChain.get(t.chain.id);
    if (g) g.tasks.push(t);
    else {
      const e = { kind: 'chain' as const, chain: t.chain, tasks: [t] };
      byChain.set(t.chain.id, e);
      out.push(e);
    }
  }
  return out.map((e) => (e.kind === 'chain' && e.tasks.length === 1 ? { kind: 'task' as const, t: e.tasks[0] as Task } : e));
}
