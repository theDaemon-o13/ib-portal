import type { AssetFact } from '../../api/assets';

/** Разделы методики по порядку; related — проверки, для которых раздел связанный: они показаны в своём основном разделе. */
export function groupBySection(facts: readonly AssetFact[]): { section: string; facts: AssetFact[]; related: AssetFact[] }[] {
  const map = new Map<string, { facts: AssetFact[]; related: AssetFact[] }>();
  const at = (section: string) => {
    const g = map.get(section) ?? { facts: [], related: [] };
    map.set(section, g);
    return g;
  };
  for (const f of facts) {
    at(f.section).facts.push(f);
    for (const r of f.relatedSections) at(r).related.push(f);
  }
  const order = (s: string) => s.split('.').map(Number) as [number, number];
  return [...map.entries()]
    .sort(([a], [b]) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1])
    .map(([section, g]) => ({ section, ...g }));
}

/** Раздел в чек-листе самооценки: открывается только с правом assessment.manage, оценку раздел выберет сам. */
export const assessmentHref = (s: { code: string; domainNo: number }) => `/assessment/checklist?dom=${s.domainNo}&sec=${s.code}`;

/** Якорь раздела на экране «Активы». */
export const sectionAnchor = (code: string) => `sec-${code}`;

/** «5 из 8 · 62,5%»; при «Нет данных» чисел нет. */
export function factScore(f: AssetFact): string {
  if (f.status === 'no_data' || f.percent === null) return 'Нет данных';
  return `${f.numerator} из ${f.denominator} · ${String(f.percent).replace('.', ',')}%`;
}

export const STATUS_CHIP: Record<AssetFact['status'], { label: string; cls: string }> = {
  ok: { label: 'Выполнено', cls: 'chip low' },
  violations: { label: 'Не выполнено', cls: 'chip high' },
  no_data: { label: 'Нет данных', cls: 'chip' },
};
