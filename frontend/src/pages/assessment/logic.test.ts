import { describe, expect, it } from 'vitest';
import type { Answer, AssessmentSummary, Methodology } from '../../api/assessments';
import {
  defaultAssessmentId, defaultTaskTitle, deltaTone, flipSlide, logText, planCounts, PRESENTATION_SLIDES, taskState, donutArcs, n1, radarAnchor, radarPoint, radarPolygon, scalePct, scaleZones, sectionsOf, signed,
  unanswered, weakSections,
} from './logic';

/** Методика той же формы, что cyber-express-v1: 10 доменов, 24 раздела, ключевые 1.2, 4.2, 10.1. */
const COUNTS = [3, 3, 3, 2, 3, 3, 1, 2, 3, 1];
const KEYS = ['1.2', '4.2', '10.1'];
const m: Methodology = {
  code: 'cyber-express-v1', name: 'Экспресс-оценка', version: 1,
  scale: [{ level: 1, name: 'Базовый' }, { level: 2, name: 'Средний' }, { level: 3, name: 'Высокий' }, { level: 4, name: 'Продвинутый' }],
  maturity: [
    { code: 'hygiene', name: 'Цифровая гигиена', min: 0, max: 43, description: '' },
    { code: 'classic', name: 'Классическая ИБ', min: 44, max: 66, description: '' },
    { code: 'transform', name: 'Трансформируемая КБ', min: 67, max: 85, description: '' },
    { code: 'effective', name: 'Результативная КБ', min: 86, max: 999, description: '' },
  ],
  rules: { effectiveRequiresMaxIn: KEYS, fallbackLevel: 'transform', criterionThresholdPct: 85 },
  domains: COUNTS.map((n, i) => ({
    no: i + 1, name: `Домен ${i + 1}`,
    sections: Array.from({ length: n }, (_, j) => {
      const code = `${i + 1}.${j + 1}`;
      return { code, name: `Раздел ${code}`, target: '', criteria: {}, key: KEYS.includes(code) };
    }),
  })),
};
const answer = (code: string, level: number | null): Answer => ({ code, level, targetLevel: null, comment: '', version: 1, updatedAt: '2026-10-30T09:00:00Z', updatedBy: null });

describe('самооценка: шкала уровней', () => {
  it('зоны обрезаны по реальному диапазону 24–96, ширина — по числу баллов', () => {
    const { lo, hi, zones } = scaleZones(m);
    expect([lo, hi]).toEqual([24, 96]);
    expect(zones.map((z) => [z.from, z.to, z.flex])).toEqual([[24, 43, 20], [44, 66, 23], [67, 85, 19], [86, 96, 11]]);
  });

  it('отметка итога: края и середина, вне диапазона — у края', () => {
    expect(scalePct(24, 24, 96)).toBe(0);
    expect(scalePct(96, 24, 96)).toBe(100);
    expect(scalePct(60, 24, 96)).toBe(50);
    expect(scalePct(0, 24, 96)).toBe(0);
    expect(scalePct(120, 24, 96)).toBe(100);
  });
});

describe('самооценка: радар', () => {
  it('первая ось — вверх, по часовой; значение 4 — на внешнем кольце, 0 — в центре', () => {
    const [x0, y0] = radarPoint(0, 4, 10, 100, 100, 80);
    expect([Math.round(x0), Math.round(y0)]).toEqual([100, 20]);
    const [x1, y1] = radarPoint(1, 2, 4, 100, 100, 80);
    expect([Math.round(x1), Math.round(y1)]).toEqual([140, 100]);
    expect(radarPolygon([0, null], 50, 50, 40)).toBe('50.0,50.0 50.0,50.0');
  });

  it('подписи осей: по центру у вертикали, справа — start, слева — end', () => {
    expect(radarAnchor(102, 100)).toBe('middle');
    expect(radarAnchor(160, 100)).toBe('start');
    expect(radarAnchor(40, 100)).toBe('end');
  });
});

describe('самооценка: кольцо распределения', () => {
  it('дуги идут подряд, сумма — полная окружность; пустые уровни пропускаются', () => {
    const arcs = donutArcs({ 1: 15, 2: 8, 3: 1, 4: 0 }, 10);
    const c = 2 * Math.PI * 10;
    expect(arcs.map((a) => a.level)).toEqual([1, 2, 3]);
    expect(arcs[1]?.offset).toBeCloseTo((c * 15) / 24);
    expect(arcs.reduce((s, a) => s + a.len, 0)).toBeCloseTo(c);
    expect(donutArcs({ 1: 0, 2: 0, 3: 0, 4: 0 }, 10)).toEqual([]);
  });
});

describe('самооценка: списки и подписи', () => {
  it('слабые места — уровень 1, ключевые первыми; неотвеченные — по порядку методики', () => {
    const answers = sectionsOf(m).map((s) => answer(s.code, ['1.1', '4.2', '10.1', '9.3'].includes(s.code) ? 1 : s.code === '2.1' ? null : 2));
    expect(weakSections(m, answers).map((s) => s.code)).toEqual(['4.2', '10.1', '1.1', '9.3']);
    expect(unanswered(m, answers)).toEqual(['2.1']);
  });

  it('открывается черновик, иначе последняя неархивная', () => {
    const s = (id: string, status: AssessmentSummary['status']) => ({ id, status }) as AssessmentSummary;
    expect(defaultAssessmentId([s('a', 'final'), s('b', 'draft')])).toBe('b');
    expect(defaultAssessmentId([s('a', 'archived'), s('b', 'final')])).toBe('b');
    expect(defaultAssessmentId([s('a', 'archived')])).toBe('a');
    expect(defaultAssessmentId([])).toBeNull();
  });

  it('числа: средний с запятой, разница со знаком, тон', () => {
    expect([n1(2.333), n1(null), n1(4)]).toEqual(['2,3', '—', '4,0']);
    expect([signed(3), signed(-2), signed(0), signed(0.33, 1)]).toEqual(['+3', '−2', '0', '+0,3']);
    expect([deltaTone(1), deltaTone(-0.5), deltaTone(0), deltaTone(null)]).toEqual(['up', 'dn', 'eq', 'eq']);
  });

  it('журнал внутри оценки — без повтора её названия', () => {
    const t = 'Экспресс-оценка 2026';
    expect(logText(`Самооценка «${t}», 5.3 Контроль: балл 1 → 2`, t)).toBe('5.3 Контроль: балл 1 → 2');
    expect(logText(`Самооценка «${t}» зафиксирована: 34 из 96`, t)).toBe('Зафиксирована: 34 из 96');
    expect(logText(`Самооценка «${t}»: название, дата`, t)).toBe('Название, дата');
    expect(logText('Самооценка «Другая» создана', t)).toBe('Самооценка «Другая» создана');
  });

  it('задачи по разрывам: название по умолчанию, состояние, счётчики плана', () => {
    expect(defaultTaskTitle('Контроль устранения уязвимостей')).toBe('Контроль устранения уязвимостей: усилить');
    const t = (code: string, done = false, deleted = false) => ({ code, done, deleted, archived: false, status: done ? 'Выполнено' : 'Поставленные' });
    expect(taskState(t('1.1'))).toEqual({ text: 'Поставленные', tone: 'acc' });
    expect(taskState(t('1.1', true))).toEqual({ text: 'Выполнено', tone: 'low' });
    expect(taskState({ ...t('1.1'), archived: true })).toEqual({ text: 'в архиве · Поставленные', tone: '' });
    expect(taskState(t('1.1', false, true)).text).toBe('удалена');
    const gap = (code: string, g: number) => ({ code, name: code, domainNo: 1, level: 1, target: 1 + g, gap: g, key: false });
    expect(planCounts({ gaps: [gap('1.1', 2), gap('5.3', 1), gap('7.1', 1)], gapPoints: 4 }, [t('1.1', true), t('1.1'), t('5.3', false, true)]))
      .toEqual({ gaps: 3, points: 4, withoutTask: 2, done: 1, total: 2 });
  });

  it('презентация: шесть слайдов, листание без перехода по кругу', () => {
    expect(PRESENTATION_SLIDES).toHaveLength(6);
    expect([flipSlide(0, 1, 6), flipSlide(5, 1, 6), flipSlide(0, -1, 6), flipSlide(3, -1, 6)]).toEqual([1, 5, 0, 2]);
  });
});
