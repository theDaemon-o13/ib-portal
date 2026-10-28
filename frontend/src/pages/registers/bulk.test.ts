import { describe, expect, it } from 'vitest';
import { isPicked, NOTHING, pickedCount, pickPage, previewLines, reasonLines, records, resultSummary, selectionBody, togglePicked, type Picked } from './bulk';

const reasons = { tasks: 0, links: 0, decisions: 0, evidence: 0, locked: 0 };

describe('выбор записей', () => {
  it('отмеченные строки: страница целиком, снять одну', () => {
    let p = pickPage(NOTHING, ['a', 'b', 'c'], true);
    expect(pickedCount(p, 100)).toBe(3);
    p = togglePicked(p, 'b');
    expect([isPicked(p, 'a'), isPicked(p, 'b')]).toEqual([true, false]);
    expect(selectionBody(p, { q: '', includeArchived: false, archivedOnly: false, withTasks: false, filter: {} })).toEqual({ ids: ['a', 'c'] });
  });

  it('«все N по фильтру»: снятые вручную исключаются, условия списка уходят на сервер', () => {
    let p: Picked = { kind: 'filter', excluded: new Set() };
    p = togglePicked(p, 'x');
    expect(pickedCount(p, 120)).toBe(119);
    expect(isPicked(p, 'x')).toBe(false);
    expect(isPicked(p, 'y')).toBe(true);
    expect(selectionBody(p, { q: 'cve', includeArchived: true, archivedOnly: false, withTasks: true, filter: { state: 'open' } }))
      .toEqual({ filter: { state: 'open', q: 'cve', includeArchived: true, withTasks: true }, excludeIds: ['x'] });
    expect(selectionBody({ kind: 'filter', excluded: new Set() }, { q: '', includeArchived: false, archivedOnly: true, withTasks: false, filter: {} }))
      .toEqual({ filter: { archived: 'only' }, excludeIds: [] });
  });
});

describe('тексты', () => {
  it('окончания', () => {
    expect([1, 2, 5, 11, 21, 22, 112].map(records)).toEqual(['1 запись', '2 записи', '5 записей', '11 записей', '21 запись', '22 записи', '112 записей']);
  });

  it('предпросмотр удаления: удалится, уйдёт в архив, останется в архиве', () => {
    expect(previewLines('delete', { total: 6, willDelete: 3, willArchive: 2, willRestore: 0, alreadyInState: 1, byReason: { ...reasons, tasks: 2, links: 1 } })).toEqual([
      'Будет удалено: 3 записи',
      'Уйдёт в архив вместо удаления: 2 записи — у них есть зависимости',
      'Останется в архиве: 1 запись — у них есть зависимости',
    ]);
    expect(previewLines('archive', { total: 0, willDelete: 0, willArchive: 0, willRestore: 0, alreadyInState: 0, byReason: reasons })).toEqual(['Менять нечего']);
  });

  it('итог: числа, причины и подсказка про задачи', () => {
    const r = { deleted: 5, archived: 2, restored: 0, skipped: 0, byReason: { ...reasons, tasks: 1, links: 1 } };
    expect(resultSummary(r)).toEqual({ title: 'Удалено 5, в архив 2', hint: 'Сначала закройте или удалите задачи — тогда записи можно будет удалить' });
    expect(reasonLines(r.byReason)).toEqual(['открытые задачи — 1', 'ссылки из других записей — 1']);
    expect(resultSummary({ ...r, deleted: 0, archived: 0, byReason: reasons })).toEqual({ title: 'Ничего не изменилось', hint: null });
  });
});
