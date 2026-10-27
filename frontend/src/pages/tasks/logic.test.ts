import { describe, expect, it } from 'vitest';
import type { Task } from '../../api/tasks';
import { categoryTone, dueLabel, initials, sortColumn, workload } from './logic';

const task = (n: number, extra: Partial<Task> = {}): Task => ({
  id: `t${n}`, number: n, title: `Задача ${n}`, description: '', dueDate: null, overdue: false, urgent: false, source: 'manual',
  status: { id: 's', value: 'Новые', color: null, systemKey: 'new' }, priority: { id: 'p', value: 'Обычный', color: null, systemKey: 'normal' },
  category: { id: 'c', value: 'Проект', color: 'accent', systemKey: null }, assignee: null, record: null, automationId: null, recipientLabel: null,
  completedAt: null, createdBy: null, createdAt: '', updatedAt: '', archived: false, commentCount: 0, version: 1, ...extra,
});

describe('доска задач', () => {
  it('колонка: ближний срок сверху, без срока — в конце', () => {
    const list = [task(1), task(2, { dueDate: '2026-11-10' }), task(3, { dueDate: '2026-11-01' }), task(4, { dueDate: '2026-11-01' })];
    expect(sortColumn(list).map((t) => t.number)).toEqual([3, 4, 2, 1]);
  });

  it('подпись срока: просрочено выделяется, сегодня, без срока', () => {
    expect(dueLabel({ dueDate: '2026-11-01', overdue: true, completedAt: null }, '2026-11-05')).toEqual({ text: 'просрочено · 01.11.2026', late: true });
    expect(dueLabel({ dueDate: '2026-11-05', overdue: false, completedAt: null }, '2026-11-05')).toEqual({ text: 'сегодня · 05.11.2026', late: false });
    expect(dueLabel({ dueDate: '2026-11-09', overdue: false, completedAt: null }, '2026-11-05').text).toBe('09.11.2026');
    expect(dueLabel({ dueDate: null, overdue: false, completedAt: null }, '2026-11-05').text).toBe('без срока');
  });

  it('цвет категории; инициалы; загрузка сотрудников без закрытых задач', () => {
    expect(categoryTone({ id: 'm', value: 'Почта', color: 'info', systemKey: 'mail' })).toBe('src-mail');
    expect(categoryTone({ id: 'r', value: 'Реестр', color: 'crit', systemKey: 'register' })).toBe('src-reg');
    expect(categoryTone({ id: 'p', value: 'Проект', color: 'accent', systemKey: null })).toBe('tone-accent');
    expect(initials('Денис Ромашов')).toBe('ДР');
    const a = { id: 'a', fullName: 'Анна' };
    expect(workload([task(1, { assignee: a }), task(2, { assignee: a }), task(3), task(4, { assignee: a, completedAt: 'x' })]))
      .toEqual([{ name: 'Анна', count: 2 }, { name: 'Не назначен', count: 1 }]);
  });
});
