import { describe, expect, it } from 'vitest';
import { checkLayout, mergeLayout, type LayoutElement } from './layout.js';

const el = (key: string, defaultSize: LayoutElement['defaultSize'] = 's', fixedSize = false): LayoutElement => ({ key, defaultSize, fixedSize, perm: 'ib.work' });
const elements = [el('kpi:a', 's', true), el('kpi:b', 's', true), el('widget:x', 'm'), el('tile:t')];

describe('раскладка дашборда', () => {
  it('порядок и настройки — из сохранённой; удалённые пропускаются, новые — в конец видимыми', () => {
    const saved = [
      { key: 'widget:x', hidden: false, size: 'l' },
      { key: 'kpi:b', hidden: true, size: 'l' }, // KPI — всегда свой размер
      { key: 'widget:gone', hidden: false, size: 's' },
      { key: 'widget:x', hidden: true, size: 's' }, // повтор — пропускается
    ];
    expect(mergeLayout(saved, elements)).toEqual([
      { key: 'widget:x', hidden: false, size: 'l' },
      { key: 'kpi:b', hidden: true, size: 's' },
      { key: 'kpi:a', hidden: false, size: 's' },
      { key: 'tile:t', hidden: false, size: 's' },
    ]);
    expect(mergeLayout(null, elements).map((i) => i.key)).toEqual(['kpi:a', 'kpi:b', 'widget:x', 'tile:t']);
  });

  it('ввод: неизвестный элемент, повтор и неверный размер — ошибка', () => {
    expect(() => checkLayout([{ key: 'widget:nope', hidden: false, size: 's' }], elements)).toThrow(/нет на дашборде/);
    expect(() => checkLayout([{ key: 'tile:t', hidden: false, size: 's' }, { key: 'tile:t', hidden: true, size: 's' }], elements)).toThrow(/дважды/);
    expect(() => checkLayout([{ key: 'tile:t', hidden: false, size: 'xl' }], elements)).toThrow(/S, M или L/);
    expect(checkLayout([{ key: 'tile:t', hidden: true, size: 'm' }], elements)[0]).toEqual({ key: 'tile:t', hidden: true, size: 'm' });
  });
});
