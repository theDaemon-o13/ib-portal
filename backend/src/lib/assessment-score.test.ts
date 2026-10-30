import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareScores, maturityOf, score, sectionsOf, type AnswerInput, type Methodology } from './assessment-score.js';

const m = JSON.parse(readFileSync(new URL('../../prisma/seed/assessment-methodology.json', import.meta.url), 'utf8')) as Methodology;
const codes = sectionsOf(m).map((s) => s.code);

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
