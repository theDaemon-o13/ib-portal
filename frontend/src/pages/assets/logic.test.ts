import { describe, expect, it } from 'vitest';
import type { AssetFact } from '../../api/assets';
import { assessmentHref, factScore, groupBySection } from './logic';

const fact = (over: Partial<AssetFact>): AssetFact => ({
  code: 'x', section: '2.2', relatedSections: [], title: 'x', status: 'ok', numerator: 1, denominator: 1, percent: 100,
  records: [], calculatedAt: '2026-11-01T00:00:00.000Z', message: null, warnings: [], ...over,
});

describe('сверка активов', () => {
  it('разделы идут по номеру, 10.1 после 9.2', () => {
    const list = groupBySection([fact({ section: '10.1' }), fact({ section: '9.2' }), fact({ section: '2.3' }), fact({ section: '2.2' })]);
    expect(list.map((g) => g.section)).toEqual(['2.2', '2.3', '9.2', '10.1']);
  });
  it('связанный раздел получает своё место, но проверка считается только в основном', () => {
    const f = fact({ code: 'risk', section: '2.3', relatedSections: ['1.2'] });
    const list = groupBySection([f]);
    expect(list.map((g) => [g.section, g.facts.length, g.related.length])).toEqual([['1.2', 0, 1], ['2.3', 1, 0]]);
  });
  it('ссылка на раздел чек-листа', () => {
    expect(assessmentHref({ code: '2.2', domainNo: 2 })).toBe('/assessment/checklist?dom=2&sec=2.2');
  });
  it('«Нет данных» не показывает ни процент, ни 0 из 0', () => {
    expect(factScore(fact({ status: 'no_data', numerator: null, denominator: null, percent: null }))).toBe('Нет данных');
  });
  it('процент с запятой', () => {
    expect(factScore(fact({ status: 'violations', numerator: 5, denominator: 8, percent: 62.5 }))).toBe('5 из 8 · 62,5%');
  });
});
