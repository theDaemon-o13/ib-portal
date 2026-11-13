import { describe, expect, it } from 'vitest';
import type { Task } from '../../api/tasks';
import { actionNeedsComment, originText, sourceChip, candidatesChip, cardStep, chainCounts, chainTitleOf, byDueDate, columnEntries, idleSystemChains, matchTask, plural, systemChainStats, categoryTone, dueLabel, initials, needsComment, processHint, sortColumn, workload, workloadOpen } from './logic';

const task = (n: number, extra: Partial<Task> = {}): Task => ({
  id: `t${n}`, number: n, title: `Задача ${n}`, description: '', dueDate: null, overdue: false, urgent: false, source: 'manual',
  status: { id: 's', value: 'Backlog', color: null, systemKey: 'new' }, priority: { id: 'p', value: 'Обычный', color: null, systemKey: 'normal' },
  category: { id: 'c', value: 'Проект', color: 'accent', systemKey: null }, assignee: null, candidates: [], reviewer: null, record: null, automationId: null, recipientLabel: null, document: null, evidence: null,
  completedAt: null, chain: null, origin: null, createdBy: null, createdAt: '', updatedAt: '', archived: false, commentCount: 0, version: 1, actions: [], ...extra,
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

describe('процесс по кнопкам', () => {
  const cols = [
    { id: 'n', systemKey: 'new', commentForward: false, commentReturn: false },
    { id: 'a', systemKey: 'assigned', commentForward: false, commentReturn: false },
    { id: 'w', systemKey: 'work', commentForward: false, commentReturn: true },
    { id: 'x', systemKey: null, commentForward: true, commentReturn: false },
    { id: 'r', systemKey: 'review', commentForward: true, commentReturn: false },
    { id: 'd', systemKey: 'done', commentForward: true, commentReturn: false },
  ];
  const st = (id: string, systemKey: string) => ({ id, value: id, color: null, systemKey });

  it('комментарий — по признаку колонки: вперёд и при возврате, по порядку колонок', () => {
    expect(needsComment(cols, 'a', 'w')).toBe(false);
    expect(needsComment(cols, 'w', 'r')).toBe(true);
    expect(needsComment(cols, 'r', 'w')).toBe(true);
    expect(needsComment(cols, 'd', 'a')).toBe(false);
    expect(needsComment(cols, 'w', 'x')).toBe(true);
    expect(actionNeedsComment(cols, { status: st('a', 'assigned') }, 'start')).toBe(false);
    expect(actionNeedsComment(cols, { status: st('r', 'review') }, 'accept')).toBe(true);
  });

  it('кнопка на карточке: своя работа или «Проверить»; подсказка, когда кнопок нет', () => {
    expect(cardStep({ actions: ['take'] })).toEqual({ action: 'take', label: 'Взять себе' });
    expect(cardStep({ actions: ['submit'] })).toEqual({ action: 'submit', label: 'На проверку' });
    expect(cardStep({ actions: ['complete'] })).toEqual({ action: 'complete', label: 'Завершить' });
    expect(cardStep({ actions: ['accept', 'return'] })).toEqual({ action: 'review', label: 'Проверить' });
    expect(cardStep({ actions: [] })).toBeNull();
    const me = { id: 'me', fullName: 'Я' };
    const review = { status: st('r', 'review'), assignee: me, reviewer: null, actions: [], archived: false };
    expect(processHint(review, 'me', ['tasks.review'])).toMatch(/Свою задачу нельзя принять/);
    expect(processHint({ ...review, assignee: { id: 'b', fullName: 'Б' } }, 'me', ['tasks.review'])).toMatch(/автор задачи или руководитель исполнителя$/);
    expect(processHint({ ...review, status: st('w', 'work'), assignee: { id: 'b', fullName: 'Б' } }, 'me', [])).toMatch(/исполнитель/);
    expect(processHint({ ...review, actions: ['accept'] }, 'me', [])).toBeNull();
    // С 1.4.0 — проверяющий задачи (ADR-0028).
    const lead = { id: 'l', fullName: 'Руководитель' };
    expect(processHint({ ...review, reviewer: lead }, 'me', [])).toBe('Задачу проверяет Руководитель');
    expect(processHint({ ...review, reviewer: lead, assignee: { id: 'b', fullName: 'Б' } }, 'me', ['tasks.review'])).toBe('Принять или вернуть может только проверяющий: Руководитель');
  });
});

describe('панель «Загрузка сотрудников»', () => {
  it('запомненный выбор главнее ширины; без выбора — открыта с 1600 px', () => {
    expect([workloadOpen(null, 1366), workloadOpen(null, 1440), workloadOpen(null, 1920)]).toEqual([false, false, true]);
    expect([workloadOpen('1', 1366), workloadOpen('0', 1920), workloadOpen('x', 1366)]).toEqual([true, false, false]);
  });
  it('«Могут взять» на карточке: первое имя и «+N» (1.6.5)', () => {
    expect(candidatesChip([])).toEqual({ first: '', more: 0 });
    expect(candidatesChip([{ fullName: 'Мусоев Раджаб' }])).toEqual({ first: 'Мусоев Раджаб', more: 0 });
    expect(candidatesChip([{ fullName: 'Мусоев Раджаб' }, { fullName: 'Баротов Шавкат' }, { fullName: 'Иванов И.' }])).toEqual({ first: 'Мусоев Раджаб', more: 2 });
  });
});

describe('цепочки задач (1.7.0)', () => {
  it('название новой цепочки — без почтовых префиксов, как в backend', () => {
    expect(chainTitleOf('RE: FW: Тестовая тема')).toBe('Тестовая тема');
    expect(chainTitleOf('[EXT] Отв: ВО: Re[2]: Тестовая тема')).toBe('Тестовая тема');
    expect(chainTitleOf('Во вторник проверка')).toBe('Во вторник проверка');
    expect(chainTitleOf('Ответственный за доступ')).toBe('Ответственный за доступ');
    expect(chainTitleOf('RE:')).toBe('RE:');
  });

  it('счётчик: «3 задачи, 1 выполнена», «5 задач, 0 выполнено», «21 задача, 2 выполнены»', () => {
    expect(chainCounts({ total: 3, done: 1 })).toBe('3 задачи, 1 выполнена');
    expect(chainCounts({ total: 5, done: 0 })).toBe('5 задач, 0 выполнено');
    expect(chainCounts({ total: 21, done: 2 })).toBe('21 задача, 2 выполнены');
    expect(plural(12, 'задача', 'задачи', 'задач')).toBe('задач');
    expect(plural(111, 'задача', 'задачи', 'задач')).toBe('задач');
  });
});

describe('доска: группировка по цепочкам и поиск (1.7.0)', () => {
  const ch = (id: string, title: string) => ({ id, number: 1, title, status: 'open' as const, kind: 'manual' as const });
  it('две и больше задач цепочки — одна карточка на месте первой; одна — обычная карточка; без группировки — как есть', () => {
    const list = [task(1), task(2, { chain: ch('a', 'Тема А') }), task(3), task(4, { chain: ch('a', 'Тема А') }), task(5, { chain: ch('b', 'Тема Б') })];
    expect(columnEntries(list, true).map((e) => (e.kind === 'task' ? e.t.number : `${e.chain.id}:${e.tasks.map((t) => t.number).join(',')}`)))
      .toEqual([1, 'a:2,4', 3, 5]);
    expect(columnEntries(list, false)).toHaveLength(5);
  });
  it('поиск: номер, название задачи, название цепочки; ё = е', () => {
    const t = task(42, { title: 'Проверка доступа', chain: ch('a', 'Ёлочная тема') });
    expect(matchTask(t, '#42')).toBe(true);
    expect(matchTask(t, '42')).toBe(true);
    expect(matchTask(t, 'ДОСТУП')).toBe(true);
    expect(matchTask(t, 'елочная')).toBe(true);
    expect(matchTask(t, 'другое')).toBe(false);
    expect(matchTask(t, '  ')).toBe(true);
  });
});

describe('происхождение задачи (1.9.0)', () => {
  const letter = { id: 'l1', number: 12, status: 'draft' as const, deleted: false };
  it('расписание и учебное письмо — по origin; известный source — словами; неизвестный — «другое», без падения', () => {
    const sched = task(1, { origin: { kind: 'schedule', rule: { id: 'r', title: 'Ежемесячная' }, plannedDate: '2041-01-15', letter: null, stages: [], letterSent: false } });
    expect([originText(sched), sourceChip(sched)?.label]).toEqual(['создана расписанием: Ежемесячная', 'рассылка']);
    const urgent = task(2, { origin: { kind: 'letter', reason: 'urgent', letter, letterSent: false } });
    expect([originText(urgent), sourceChip(urgent)]).toEqual(['учебное письмо № 12', { label: 'письмо № 12', title: 'Срочная рассылка' }]);
    expect([originText(task(3)), sourceChip(task(3))]).toEqual(['поставлена вручную', null]);
    expect(sourceChip(task(4, { source: 'mail' }))?.label).toBe('письмо');
    const future = task(5, { source: 'awareness' });
    expect([originText(future), sourceChip(future)?.label]).toEqual(['другое', 'другое']);
  });
});


describe('задача с удалённым письмом (1.13.3)', () => {
  it('«учебное письмо № N (удалено)»', () => {
    const t = { source: 'manual', origin: { kind: 'letter' as const, reason: 'urgent' as const, letter: { id: 'l', number: 7, status: 'draft' as const, deleted: true }, letterSent: false } };
    expect(originText(t)).toBe('учебное письмо № 7 (удалено)');
  });
});

describe('доска: системные цепочки (1.14.0)', () => {
  const sys = { id: 's', number: 7, title: 'Уязвимости · Сервис А', status: 'open' as const, kind: 'system' as const };
  it('системная цепочка — карточка и при одной задаче; ручная с одной задачей — обычная карточка; без группировки — по одной', () => {
    const manual = { id: 'm', number: 2, title: 'Тема', status: 'open' as const, kind: 'manual' as const };
    const list = [task(1, { chain: sys }), task(2, { chain: manual }), task(3)];
    expect(columnEntries(list, true).map((e) => (e.kind === 'task' ? e.t.number : `${e.chain.id}:${e.tasks.length}`))).toEqual(['s:1', 2, 3]);
    expect(columnEntries(list, false).every((e) => e.kind === 'task')).toBe(true);
    // «Выбрать», фильтр по правилу или цепочке — системные по одной, ручные группируются как раньше.
    expect(columnEntries([...list, task(4, { chain: manual })], true, false).map((e) => (e.kind === 'task' ? e.t.number : e.chain.id))).toEqual([1, 'm', 3]);
  });
  it('сводка: задач, не назначено, ближайший срок, просрочено, что можно взять', () => {
    const a = { id: 'a', fullName: 'Иванов И.И.' };
    const list = [
      task(1, { chain: sys, dueDate: '2026-11-20', actions: ['take'] }),
      task(2, { chain: sys, dueDate: '2026-11-10', overdue: true, actions: ['take'] }),
      task(3, { chain: sys, dueDate: '2026-11-15', assignee: a }),
    ];
    const st = systemChainStats(list);
    expect([st.count, st.unassigned, st.nearestDue, st.overdue, st.takeable.map((t) => t.number)]).toEqual([3, 2, '2026-11-10', 1, [1, 2]]);
  });
  it('подзаголовки по дате срока: по порядку, без срока — в конце', () => {
    const list = [task(1, { dueDate: '2026-11-20' }), task(2), task(3, { dueDate: '2026-11-10' }), task(4, { dueDate: '2026-11-20' })];
    expect(byDueDate(list).map((g) => [g.due, g.tasks.map((t) => t.number)])).toEqual([['2026-11-10', [3]], ['2026-11-20', [1, 4]], [null, [2]]]);
  });
  it('без активных задач системная цепочка не на доске', () => {
    expect([...idleSystemChains([
      { id: 's', kind: 'system', counts: { active: 0 } }, { id: 't', kind: 'system', counts: { active: 2 } }, { id: 'm', kind: 'manual', counts: { active: 0 } },
    ])]).toEqual(['s']);
  });
});
