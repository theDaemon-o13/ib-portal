import { describe, expect, it } from 'vitest';
import type { ScanSummary } from '../../api/vulns';
import { applyLabel, defaultSelection, dueHint, lastScanOf, parseView, scanAgeText, selectionBody, sumStats, toggleAll, toggleOne, viewPath } from './logic';

const item = (key: string) => ({ key }) as ScanSummary['groups']['new'][number];
const summary = {
  groups: { new: [item('a'), item('b')], reopened: [item('c')], changed: [item('d')], unchanged: [item('e')], gone: [{ key: 'f' }, { key: 'g' }] },
} as unknown as ScanSummary;

describe('раздел «Уязвимости»: логика', () => {
  it('выбор по умолчанию: новые, повторные, изменившиеся — да, пропавшие — нет', () => {
    const s = defaultSelection(summary);
    expect(selectionBody(s)).toEqual({ new: ['a', 'b'], reopened: ['c'], changed: ['d'], gone: [] });
    expect(applyLabel(s)).toBe('Загрузить: новых 2, повторно 1, обновить 1');
  });

  it('выбор строки и «все по группе»', () => {
    let s = defaultSelection(summary);
    s = toggleOne(s, 'new', 'a');
    expect([...s.new]).toEqual(['b']);
    s = toggleAll(s, 'new', summary);
    expect([...s.new]).toEqual(['a', 'b']);
    s = toggleAll(s, 'new', summary);
    expect(s.new.size).toBe(0);
    s = toggleAll(s, 'gone', summary);
    expect([...s.gone]).toEqual(['f', 'g']);
    expect(applyLabel(s)).toBe('Загрузить: повторно 1, обновить 1, устранено 2');
    expect(applyLabel({ new: new Set(), reopened: new Set(), changed: new Set(), deleted: new Set(), gone: new Set() })).toBe('Сохранить скан без изменений в реестре');
  });

  it('адрес экрана: разбор и обратно; мусор — главная раздела', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    for (const kind of ['group', 'node', 'scan'] as const) {
      expect(parseView(`${kind}/${id}`)).toEqual({ kind, id });
      expect(viewPath({ kind, id })).toBe(`/vulns/${kind}/${id}`);
    }
    expect(parseView('')).toEqual({ kind: 'root' });
    expect(parseView('node/abc')).toEqual({ kind: 'root' });
    expect(parseView(`other/${id}`)).toEqual({ kind: 'root' });
    expect(viewPath({ kind: 'root' })).toBe('/vulns');
  });

  it('счётчики группы и последний скан', () => {
    const n = (o: number, last: string | null) => ({
      open: o, overdue: 1, critical: 2, notHandedOver: 3, lastScan: last ? { id: last, scanDate: last, handedOver: false } : null,
    });
    expect(sumStats([n(1, null), n(2, null)])).toEqual({ open: 3, overdue: 2, critical: 4, notHandedOver: 6 });
    const list = [n(1, '2026-10-01'), n(1, null), n(1, '2026-10-15')] as never[];
    expect(lastScanOf(list)?.scanDate).toBe('2026-10-15');
    expect(lastScanOf([])).toBeNull();
  });

  it('подпись срока: не начался, просрочено, сегодня, через N, продлён', () => {
    const today = '2026-10-30';
    expect(dueHint(null, today, false)).toEqual({ text: 'не начался', tone: '' });
    expect(dueHint('2026-10-28', today, true)).toEqual({ text: 'просрочено на 2 дн.', tone: 'over' });
    expect(dueHint(today, today, false).text).toBe('сегодня');
    expect(dueHint('2026-11-02', today, true)).toEqual({ text: 'через 3 дн. · продлён', tone: 'ext' });
  });
});

describe('регулярность сканирования', () => {
  it('подпись возраста скана', () => {
    expect(scanAgeText(null)).toBe('Сканов нет');
    expect(scanAgeText(0)).toBe('Последний скан сегодня');
    expect(scanAgeText(91)).toBe('Последний скан 91 дн. назад');
  });
});

describe('импорт скана: «Были удалены» (1.6.1)', () => {
  it('по умолчанию не выбраны; выбранные уходят в тело и в подпись кнопки', () => {
    const item = { key: 'x' } as never;
    const summary = { groups: { new: [], reopened: [], changed: [], unchanged: [], deleted: [item], gone: [] }, counts: { new: 0, reopened: 0, changed: 0, unchanged: 0, deleted: 1, gone: 0 } } as never;
    let s = defaultSelection(summary);
    expect(s.deleted.size).toBe(0);
    expect(selectionBody(s)).not.toHaveProperty('deleted');
    s = toggleOne(s, 'deleted', 'x');
    expect(selectionBody(s).deleted).toEqual(['x']);
    expect(applyLabel(s)).toBe('Загрузить: заново 1');
  });
});
