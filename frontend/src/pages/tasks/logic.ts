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
