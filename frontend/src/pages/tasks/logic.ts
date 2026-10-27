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
