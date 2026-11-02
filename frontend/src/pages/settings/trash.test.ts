import { describe, expect, it } from 'vitest';
import { EMPTY_REASON, reasonReady, toReason } from '../../api/trash';
import { deletionCounts, deletionReason, registerDeleteBlock, registerDeleteLines, vulnDeleteBlock, vulnDeleteLines } from './trash';

describe('удаление и корзина (1.6.1)', () => {
  it('причина: из списка; «Другое» — только с текстом', () => {
    expect(reasonReady(EMPTY_REASON)).toBe(false);
    expect(reasonReady({ code: 'duplicate', text: '' })).toBe(true);
    expect(reasonReady({ code: 'other', text: '  ' })).toBe(false);
    expect(reasonReady({ code: 'other', text: 'Тестовые данные' })).toBe(true);
    expect(toReason({ code: 'false_positive', text: ' ' })).toEqual({ reasonCode: 'false_positive', reason: null });
  });

  it('реестр: системный и со ссылками — отказ с объяснением; иначе — последствия', () => {
    const base = { name: 'Доступы', system: false, linkedBy: [], counts: { records: 5, automations: 1 }, blocked: false };
    expect(registerDeleteBlock(base)).toBeNull();
    expect(registerDeleteLines(base)).toEqual([
      'Реестр «Доступы» пропадёт из списка реестров, дашборда и поиска',
      'Скроются 5 записей и 1 автоматизация',
      'Задачи автоматизаций останутся — с пометкой «реестр удалён»',
    ]);
    expect(registerDeleteBlock({ ...base, system: true })).toMatch(/системный реестр/);
    expect(registerDeleteBlock({ ...base, linkedBy: [{ registerId: 'x', register: 'Разрешения', field: 'Устройство' }] })).toMatch(/«Разрешения» → «Устройство»/);
  });

  it('группа и тип: открытые записи — отказ со списком типов', () => {
    const p = { name: 'Процессинг', nodes: [{ id: 'a', label: 'Windows', open: 3, records: 10, scans: 2 }, { id: 'b', label: 'Linux', open: 0, records: 1, scans: 1 }], counts: { nodes: 2, records: 11, scans: 3 }, open: 3, blocked: true };
    expect(vulnDeleteBlock(p)).toBe('Есть открытые записи (В работе, Просрочена, Не передано ИКТ): «Windows» — 3. Перенесите их или закройте, затем удалите');
    expect(vulnDeleteBlock({ ...p, blocked: false })).toBeNull();
    expect(vulnDeleteLines(p, true)[0]).toBe('Группа «Процессинг» и её 2 типа систем пропадут из дерева и «Все группы»');
    expect(vulnDeleteLines(p, false)[1]).toBe('Скроются 11 записей (устранённые и архивные) и 3 скана');
  });

  it('событие в корзине: что скрыто и причина', () => {
    expect(deletionCounts({ entity: 'vuln_group', counts: { nodes: 1, records: 21, scans: 1 } })).toBe('1 тип систем, 21 запись, 1 скан');
    expect(deletionReason({ reasonLabel: 'Другое', reason: 'Тест' })).toBe('Другое: Тест');
    expect(deletionReason({ reasonLabel: null, reason: '' })).toBe('причина не указана');
  });
});
