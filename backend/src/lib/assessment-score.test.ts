import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareScores, extraDomains, maturityOf, normalizeScore, score, sectionsOf, type AnswerInput, type Methodology } from './assessment-score.js';

const m = JSON.parse(readFileSync(new URL('../../prisma/seed/assessment-methodology.json', import.meta.url), 'utf8')) as Methodology;
const m2 = JSON.parse(readFileSync(new URL('../../prisma/seed/assessment-methodology-v2.json', import.meta.url), 'utf8')) as Methodology;
const codes = sectionsOf(m).map((s) => s.code);
const codes2 = sectionsOf(m2).map((s) => s.code);
const AI = ['11.1', '11.2', '11.3', '11.4'];

/** Ответы по порядку разделов методики; null — не отвечено. */
const answers = (levels: (number | null)[], targets: (number | null)[] = []) =>
  new Map<string, AnswerInput>(codes.map((c, i) => [c, { level: levels[i] ?? null, target: targets[i] ?? null }]));
const all = (v: number) => answers(codes.map(() => v));
/** Все разделы на уровне base, кроме перечисленных. */
const withLevels = (base: number, set: Record<string, number>) => answers(codes.map((c) => set[c] ?? base));

/** Ответы файла «Чек-лист оценки уровня кибербезопасности» от 07.07.2025 (эталон спецификации). */
const ETALON = [2, 1, 2, 1, 2, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 2, 2, 2, 1];

describe('самооценка: расчёт (спецификация, раздел 5)', () => {
  it('методика: 10 доменов, 24 раздела, максимум 96', () => {
    expect(m.domains).toHaveLength(10);
    expect(codes).toHaveLength(24);
    expect(score(m, all(4)).max).toBe(96);
  });

  it('эталон 07.07.2025: 34 из 96, «Цифровая гигиена», домены 5/4/5/2/3/5/1/2/6/1', () => {
    const s = score(m, answers(ETALON));
    expect(s).toMatchObject({ total: 34, answered: 24, preliminary: false, level: { name: 'Цифровая гигиена' } });
    expect(s.domains.map((d) => d.sum)).toEqual([5, 4, 5, 2, 3, 5, 1, 2, 6, 1]);
    expect(s.distribution).toEqual({ 1: 15, 2: 8, 3: 1, 4: 0 });
  });

  it('итог 24–96; уровни по границам 43/44, 66/67, 85/86', () => {
    expect(score(m, all(1)).total).toBe(24);
    const level = (total: number) => maturityOf(m, total, all(4)).name;
    expect([0, 43, 44, 66, 67, 85].map(level)).toEqual([
      'Цифровая гигиена', 'Цифровая гигиена', 'Классическая ИБ', 'Классическая ИБ', 'Трансформируемая КБ', 'Трансформируемая КБ',
    ]);
    expect(level(86)).toBe('Результативная КБ');
    expect(level(96)).toBe('Результативная КБ');
  });

  it('«Результативная КБ» — только при 4 в 1.2, 4.2, 10.1; иначе «Трансформируемая КБ»', () => {
    // 86 баллов: 14 разделов на 4 и 10 на 3 — ключевые на 4.
    const rest = codes.filter((c) => !['1.2', '4.2', '10.1'].includes(c));
    const set = (keyLevel: number) => Object.fromEntries([
      ...rest.slice(0, 11).map((c) => [c, 4]), ...rest.slice(11).map((c) => [c, 3]), ['1.2', 4], ['4.2', keyLevel], ['10.1', 4],
    ]);
    const good = score(m, withLevels(3, set(4)));
    expect(good.total).toBe(86);
    expect(good.level.name).toBe('Результативная КБ');
    const keyWeak = score(m, withLevels(3, { ...set(3), [rest[11] as string]: 4 }));
    expect(keyWeak.total).toBe(86);
    expect(keyWeak.level.name).toBe('Трансформируемая КБ');
    expect(keyWeak.keySections.find((k) => k.code === '4.2')?.level).toBe(3);
  });

  it('заполненность и «предварительно»; средний — по отвеченным разделам домена', () => {
    const partial = answers([4, null, 2, ...ETALON.slice(3, 23), null]);
    const s = score(m, partial);
    expect(s).toMatchObject({ answered: 22, preliminary: true });
    expect(s.domains[0]).toMatchObject({ answered: 2, sum: 6, avg: 3, max: 12 });
    expect(s.domains[9]).toMatchObject({ answered: 0, sum: 0, avg: null });
  });

  it('разрыв — только если цель задана и выше текущего; сколько баллов дадут цели', () => {
    const targets = codes.map((c, i) => (i === 0 ? 4 : i === 1 ? 1 : i === 2 ? 3 : null));
    const s = score(m, answers(ETALON, targets));
    expect(s.gaps.map((g) => [g.code, g.level, g.target, g.gap])).toEqual([['1.1', 2, 4, 2], ['1.3', 2, 3, 1]]);
    expect(s.gapPoints).toBe(3);
    expect(s.domains[0]?.targetAvg).toBe(2.67);
  });

  it('динамика с предыдущей оценкой: итог, домены, разделы', () => {
    const prevA = answers(ETALON);
    const curA = answers(ETALON.map((v, i) => (i === 0 ? 3 : v)));
    const d = compareScores({ score: score(m, curA), answers: curA }, { score: score(m, prevA), answers: prevA });
    expect(d.total).toBe(1);
    expect(d.domains[0]).toEqual({ no: 1, sum: 1, avg: 0.33 });
    expect(d.sections.find((x) => x.code === '1.1')).toEqual({ code: '1.1', from: 2, to: 3, delta: 1 });
  });
});

describe('самооценка: методика v2 — домен «Контроль ИИ» вне итога (1.13.8, ADR-0050)', () => {
  /** Ответы v2: эталон по 1–10 и заданные баллы 11.x. */
  const answers2 = (ai: (number | null)[], base = ETALON, targets: Record<string, number> = {}) =>
    new Map<string, AnswerInput>(codes2.map((c, i) => [c, { level: i < 24 ? base[i] ?? null : ai[i - 24] ?? null, target: targets[c] ?? null }]));

  it('v2 = v1 без изменений + домен 11 с inTotal=false: 11 доменов, 28 разделов, максимум по-прежнему 96', () => {
    expect(m2).toMatchObject({ code: 'cyber-express-v2', version: 2, name: m.name });
    expect({ ...m2, code: m.code, version: m.version, domains: m2.domains.slice(0, 10) }).toEqual(m);
    const d11 = m2.domains[10];
    expect(d11).toMatchObject({ no: 11, name: 'Контроль ИИ', inTotal: false });
    expect(d11?.sections.map((s) => s.code)).toEqual(AI);
    expect(d11?.sections.every((s) => s.key === false && Object.keys(s.criteria).sort().join() === '1,2,3,4')).toBe(true);
    expect(codes2).toHaveLength(28);
    const s = score(m2, answers2([4, 4, 4, 4], codes.map(() => 4)));
    expect(s).toMatchObject({ total: 96, max: 96, answered: 28, sections: 28, preliminary: false });
    expect(s.domains.map((d) => d.inTotal)).toEqual([...Array.from({ length: 10 }, () => true), false]);
  });

  it('эталон на v2 с любыми ответами 11.x — 34 из 96, «Цифровая гигиена»; ИИ считается отдельно', () => {
    for (const ai of [[1, 1, 1, 1], [4, 4, 4, 4], [2, 3, null, 4]]) {
      const s = score(m2, answers2(ai));
      expect(s).toMatchObject({ total: 34, max: 96, level: { name: 'Цифровая гигиена' } });
      expect(s.domains.slice(0, 10).map((d) => d.sum)).toEqual([5, 4, 5, 2, 3, 5, 1, 2, 6, 1]);
      const [x] = extraDomains(s);
      const filled = ai.filter((v): v is number => v !== null);
      expect(x).toMatchObject({ no: 11, name: 'Контроль ИИ', inTotal: false, max: 16, sum: filled.reduce((a, b) => a + b, 0), answered: filled.length, sections: 4 });
    }
    // Распределение — по всем отвеченным разделам, включая 11.x.
    expect(score(m2, answers2([4, 4, 4, 4])).distribution).toEqual({ 1: 15, 2: 8, 3: 1, 4: 4 });
  });

  it('inTotal=false не влияет на «Результативную КБ»: 86+ и 4 в 1.2, 4.2, 10.1 при любых баллах домена 11', () => {
    const rest = codes.filter((c) => !['1.2', '4.2', '10.1'].includes(c));
    const base86 = codes.map((c) => (['1.2', '4.2', '10.1'].includes(c) || rest.indexOf(c) < 11 ? 4 : 3));
    for (const ai of [[1, 1, 1, 1], [4, 4, 4, 4]]) {
      const s = score(m2, answers2(ai, base86));
      expect(s).toMatchObject({ total: 86, level: { name: 'Результативная КБ' } });
    }
    // Ключевой раздел на 3 — откат на «Трансформируемую КБ», даже если домен 11 на 4.
    const weakKey = base86.map((v, i) => (codes[i] === '4.2' ? 3 : i === codes.indexOf(rest[11] as string) ? 4 : v));
    expect(score(m2, answers2([4, 4, 4, 4], weakKey))).toMatchObject({ total: 86, level: { name: 'Трансформируемая КБ' } });
  });

  it('заполненность — по всем 28: при 24 из 28 итог «предварительно», фиксация невозможна', () => {
    const s = score(m2, answers2([null, null, null, null]));
    expect(s).toMatchObject({ total: 34, answered: 24, sections: 28, preliminary: true });
    expect(score(m2, answers2([1, null, null, null]))).toMatchObject({ answered: 25, preliminary: true });
    expect(score(m2, answers2([1, 1, 1, 1]))).toMatchObject({ answered: 28, preliminary: false });
  });

  it('разрывы — по всем разделам, «баллов к итогу» — только по доменам в итоге; динамика с v1 — домен 11 без разницы', () => {
    const s = score(m2, answers2([1, 1, 1, 1], ETALON, { '1.1': 4, '11.2': 3 }));
    expect(s.gaps.map((g) => [g.code, g.gap, g.inTotal])).toEqual([['1.1', 2, true], ['11.2', 2, false]]);
    expect(s.gapPoints).toBe(2);
    const prev = answers(ETALON);
    const d = compareScores({ score: s, answers: answers2([1, 1, 1, 1]) }, { score: score(m, prev), answers: prev });
    expect(d.total).toBe(0);
    expect(d.domains[10]).toEqual({ no: 11, sum: null, avg: null });
    expect(d.sections.find((x) => x.code === '11.1')).toEqual({ code: '11.1', from: null, to: 1, delta: null });
  });

  it('замороженный итог до 1.13.8 без признака inTotal читается как «все в итоге», сам итог не пересчитывается', () => {
    const frozen = JSON.parse(JSON.stringify(score(m, answers(ETALON, codes.map((_, i) => (i === 0 ? 4 : null)))))) as Record<string, unknown>;
    for (const d of frozen.domains as Record<string, unknown>[]) delete d.inTotal;
    for (const g of frozen.gaps as Record<string, unknown>[]) delete g.inTotal;
    const s = normalizeScore({ ...frozen, total: 35 });
    expect(s.total).toBe(35);
    expect(s.domains.every((d) => d.inTotal)).toBe(true);
    expect(s.gaps).toEqual([expect.objectContaining({ code: '1.1', inTotal: true })]);
    expect(extraDomains(s)).toEqual([]);
  });
});
