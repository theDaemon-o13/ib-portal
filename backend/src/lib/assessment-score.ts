// Расчёт самооценки (этап Д, docs/self-assessment.md, раздел 5): одна функция на черновик (при чтении) и фиксацию
// (результат замораживается в assessments.result). Только чистые функции — без БД; методика — из снимка оценки (ADR-0025).

export interface MethodologySection {
  code: string;
  name: string;
  target: string;
  criteria: Record<string, string>;
  /** Ключевой раздел для «Результативной КБ». */
  key?: boolean;
}
export interface MethodologyDomain {
  no: number;
  name: string;
  sections: MethodologySection[];
  /** Входит ли домен в итог и уровень КБ (1.13.10): нет поля — входит. Домен вне итога считается отдельно. */
  inTotal?: boolean;
}
export interface MaturityLevel { code: string; name: string; min: number; max: number; description: string }
export interface Methodology {
  code: string;
  name: string;
  version: number;
  scale: { level: number; name: string }[];
  maturity: MaturityLevel[];
  rules: { effectiveRequiresMaxIn: string[]; fallbackLevel: string; criterionThresholdPct: number };
  domains: MethodologyDomain[];
}

export interface AnswerInput { level: number | null; target: number | null }
export type Answers = ReadonlyMap<string, AnswerInput>;

export const MAX_LEVEL = 4;

export interface DomainScore {
  no: number;
  name: string;
  /** Входит в итог и уровень КБ (правило 2, 1.13.10). */
  inTotal: boolean;
  sections: number;
  answered: number;
  sum: number;
  max: number;
  /** Средний балл по отвеченным разделам; null — ни одного ответа. */
  avg: number | null;
  /** Средний целевой по разделам с заданной целью; null — целей нет. */
  targetAvg: number | null;
}

export interface Gap { code: string; name: string; domainNo: number; level: number; target: number; gap: number; key: boolean; inTotal: boolean }

export interface Score {
  /** Итог и максимум — только по доменам в итоге (у cyber-express — из 96). */
  total: number;
  max: number;
  /** Сколько разделов отвечено — по всем разделам снимка, включая домены вне итога. */
  answered: number;
  sections: number;
  /** Не всё заполнено — итог и уровень «предварительно», фиксация недоступна (правило 5). */
  preliminary: boolean;
  level: { code: string; name: string };
  /** Ключевые разделы и их баллы (правило 4). */
  keySections: { code: string; name: string; level: number | null }[];
  domains: DomainScore[];
  /** Число разделов на каждом уровне 1–4 (правило 6). */
  distribution: Record<'1' | '2' | '3' | '4', number>;
  gaps: Gap[];
  /** Сколько баллов добавят цели к итогу: сумма разрывов разделов доменов в итоге. */
  gapPoints: number;
}

/** Домен входит в итог, если признак не выставлен в false (1.13.10, ADR-0050). */
export const isInTotal = (d: Pick<MethodologyDomain, 'inTotal'>) => d.inTotal !== false;

export const sectionsOf = (m: Methodology) => m.domains.flatMap((d) => d.sections.map((s) => ({ ...s, domainNo: d.no, inTotal: isInTotal(d) })));

/**
 * Уровень КБ по итогу (правило 4): полоса методики, в которую попадает итог; «Результативная КБ» — только если ключевые
 * разделы оценены на максимум, иначе уровень отката (fallbackLevel). Итог выше всех полос — последняя полоса.
 */
export function maturityOf(m: Methodology, total: number, answers: Answers): { code: string; name: string } {
  const bands = [...m.maturity].sort((a, b) => a.min - b.min);
  const band = bands.find((b) => total >= b.min && total <= b.max) ?? (total < (bands[0]?.min ?? 0) ? bands[0] : bands.at(-1));
  if (!band) throw new Error('методика без уровней зрелости');
  const last = bands.at(-1);
  if (band === last && m.rules.effectiveRequiresMaxIn.some((code) => answers.get(code)?.level !== MAX_LEVEL)) {
    const fallback = bands.find((b) => b.code === m.rules.fallbackLevel) ?? bands.at(-2) ?? band;
    return { code: fallback.code, name: fallback.name };
  }
  return { code: band.code, name: band.name };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function score(m: Methodology, answers: Answers): Score {
  const all = sectionsOf(m);
  let total = 0;
  let answered = 0;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<'1' | '2' | '3' | '4', number>;
  const gaps: Gap[] = [];
  // Итог и максимум — только по доменам в итоге; заполненность и распределение — по всем разделам (1.13.10).
  let max = 0;
  for (const s of all) {
    if (s.inTotal) max += MAX_LEVEL;
    const a = answers.get(s.code);
    if (a?.level) {
      if (s.inTotal) total += a.level;
      answered += 1;
      distribution[String(a.level) as '1'] += 1;
      // Разрыв — только если цель задана и выше текущего (правило 7).
      if (a.target && a.target > a.level) {
        gaps.push({ code: s.code, name: s.name, domainNo: s.domainNo, level: a.level, target: a.target, gap: a.target - a.level, key: s.key === true, inTotal: s.inTotal });
      }
    }
  }
  const domains = m.domains.map((d): DomainScore => {
    const levels = d.sections.map((s) => answers.get(s.code)?.level ?? null).filter((v): v is number => v !== null);
    const targets = d.sections.map((s) => answers.get(s.code)?.target ?? null).filter((v): v is number => v !== null);
    const sum = levels.reduce((x, y) => x + y, 0);
    return {
      no: d.no, name: d.name, inTotal: isInTotal(d), sections: d.sections.length, answered: levels.length, sum, max: d.sections.length * MAX_LEVEL,
      avg: levels.length ? round2(sum / levels.length) : null,
      targetAvg: targets.length ? round2(targets.reduce((x, y) => x + y, 0) / targets.length) : null,
    };
  });
  return {
    total,
    max,
    answered,
    sections: all.length,
    preliminary: answered < all.length,
    level: maturityOf(m, total, answers),
    keySections: m.rules.effectiveRequiresMaxIn.map((code) => ({
      code, name: all.find((s) => s.code === code)?.name ?? code, level: answers.get(code)?.level ?? null,
    })),
    domains,
    distribution,
    gaps,
    gapPoints: gaps.filter((g) => g.inTotal).reduce((x, g) => x + g.gap, 0),
  };
}

/**
 * Замороженный итог оценки, зафиксированной до 1.13.10: у доменов и разрывов нет признака inTotal — тогда все в итоге.
 * Сам итог не пересчитывается (ADR-0025).
 */
export function normalizeScore(raw: unknown): Score {
  const s = raw as Score;
  return {
    ...s,
    domains: (s.domains ?? []).map((d) => ({ ...d, inTotal: d.inTotal !== false })),
    gaps: (s.gaps ?? []).map((g) => ({ ...g, inTotal: g.inTotal !== false })),
  };
}

/** Домены вне итога (например, «Контроль ИИ»): считаются отдельно — сумма, максимум, средний, заполненность. */
export const extraDomains = (s: Pick<Score, 'domains'>) => s.domains.filter((d) => !d.inTotal);

/** Динамика (правило 8): разница с предыдущей оценкой по итогу, доменам и разделам (по совпадающим кодам). */
export function compareScores(cur: { score: Score; answers: Answers }, prev: { score: Score; answers: Answers }) {
  const prevDomains = new Map(prev.score.domains.map((d) => [d.no, d]));
  return {
    total: cur.score.total - prev.score.total,
    domains: cur.score.domains.map((d) => {
      const p = prevDomains.get(d.no);
      return { no: d.no, sum: p ? d.sum - p.sum : null, avg: p && d.avg !== null && p.avg !== null ? round2(d.avg - p.avg) : null };
    }),
    sections: [...cur.answers].map(([code, a]) => {
      const p = prev.answers.get(code)?.level ?? null;
      return { code, from: p, to: a.level, delta: p !== null && a.level !== null ? a.level - p : null };
    }),
  };
}
