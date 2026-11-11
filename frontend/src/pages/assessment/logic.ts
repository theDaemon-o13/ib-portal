// Самооценка: чистые функции без React (тесты — logic.test.ts). Расчёт итога — на backend; здесь только то,
// что нужно для показа: геометрия графиков, подписи, порядок списков.
import type { Answer, AssessmentSummary, LinkedTask, Methodology, Score } from '../../api/assessments';

export const MAX_LEVEL = 4;
export const LEVELS = [1, 2, 3, 4] as const;

/** Домен входит в итог, если признак не выставлен в false (1.13.10, ADR-0050). */
export const isInTotal = (d: { inTotal?: boolean | null }) => d.inTotal !== false;

/** Разделы методики по порядку, с номером домена и признаком «в итоге». */
export function sectionsOf(m: Methodology) {
  return m.domains.flatMap((d) => d.sections.map((s) => ({ ...s, domainNo: d.no, domainName: d.name, inTotal: isInTotal(d) })));
}

/** Домены вне итога (например, «Контроль ИИ»): считаются отдельно — сумма, максимум, средний, заполненность. */
export const extraDomains = (s: Pick<Score, 'domains'>) => s.domains.filter((d) => !d.inTotal);

/** Подпись домена вне итога: «Контроль ИИ: 8 из 16». */
export const extraLabel = (d: Pick<Score['domains'][number], 'name' | 'sum' | 'max'>) => `${d.name}: ${d.sum} из ${d.max}`;
export type Section = ReturnType<typeof sectionsOf>[number];

/** Название уровня шкалы: «1» → «Базовый». */
export function levelName(m: Methodology, level: number | null | undefined): string {
  if (!level) return '—';
  return m.scale.find((s) => s.level === level)?.name ?? String(level);
}

/** Средний балл: одна цифра после запятой, нет данных — «—». */
export function n1(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(1).replace('.', ',');
}

/** «+2», «−1», «0» — разница со знаком (минус типографский). */
export function signed(d: number, digits = 0): string {
  const abs = digits ? Math.abs(d).toFixed(digits).replace('.', ',') : String(Math.abs(d));
  if (Math.abs(d) < 0.005) return '0';
  return d > 0 ? `+${abs}` : `−${abs}`;
}

/** Цвет разницы: рост — зелёный, падение — красный, без изменений или нет данных — серый. */
export function deltaTone(d: number | null | undefined): 'up' | 'dn' | 'eq' {
  if (d === null || d === undefined || Math.abs(d) < 0.005) return 'eq';
  return d > 0 ? 'up' : 'dn';
}

/** «Экспресс-оценка 2025» → «2025»: короткая подпись для легенды. */
export function shortTitle(title: string): string {
  return title.replace(/^Экспресс-оценка\s+/i, '') || title;
}

/**
 * Зоны шкалы уровней: полосы методики, обрезанные по реальному диапазону итога (минимум — по 1 баллу на раздел,
 * максимум — по 4). «0–43» на деле начинается с 24 (спецификация, раздел 2).
 */
export function scaleZones(m: Methodology) {
  // Диапазон — только по разделам доменов в итоге (1.13.10): домен вне итога шкалу не растягивает.
  const n = sectionsOf(m).filter((s) => s.inTotal).length;
  const lo = n;
  const hi = n * MAX_LEVEL;
  const zones = [...m.maturity]
    .sort((a, b) => a.min - b.min)
    .map((z) => ({ code: z.code, name: z.name, from: Math.max(lo, z.min), to: Math.min(hi, z.max) }))
    .filter((z) => z.to >= z.from);
  return { lo, hi, zones: zones.map((z) => ({ ...z, flex: z.to - z.from + 1 })) };
}

/** Положение итога на шкале, в процентах ширины; итог вне диапазона прижимается к краю. */
export function scalePct(total: number, lo: number, hi: number): number {
  if (hi <= lo) return 0;
  return ((Math.max(lo, Math.min(hi, total)) - lo) / (hi - lo)) * 100;
}

/** Точка радара: ось i из n (первая — вверх, по часовой), значение v из max. */
export function radarPoint(i: number, v: number, n: number, cx: number, cy: number, r: number, max = MAX_LEVEL): [number, number] {
  const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const k = (r * v) / max;
  return [cx + Math.cos(ang) * k, cy + Math.sin(ang) * k];
}

/** Многоугольник радара для атрибута points; пустое значение — центр. */
export function radarPolygon(values: readonly (number | null)[], cx: number, cy: number, r: number): string {
  return values
    .map((v, i) => radarPoint(i, v ?? 0, values.length, cx, cy, r).map((x) => x.toFixed(1)).join(','))
    .join(' ');
}

/** Выравнивание подписи оси радара: у вертикальной оси — по центру, справа — от начала, слева — к концу. */
export function radarAnchor(x: number, cx: number): 'middle' | 'start' | 'end' {
  if (Math.abs(x - cx) < 8) return 'middle';
  return x > cx ? 'start' : 'end';
}

/** Короткие подписи доменов на радаре; домен не из списка — его название. */
const SHORT_DOMAINS: Record<number, string> = {
  1: 'Целеполагание', 2: 'Активы', 3: 'Мониторинг', 4: 'Инциденты', 5: 'Уязвимости',
  6: 'Доступ', 7: 'Конфигурации', 8: 'Устойчивость', 9: 'Сеть и инфр.', 10: 'Контроль защищ.', 11: 'Контроль ИИ',
};
export const domainShort = (no: number, name: string) => SHORT_DOMAINS[no] ?? name;

/** Дуги кольца распределения: длина и сдвиг по окружности радиуса r для каждого уровня с ответами. */
export function donutArcs(dist: Score['distribution'], r: number) {
  const c = 2 * Math.PI * r;
  const total = LEVELS.reduce((s, l) => s + dist[l], 0);
  if (!total) return [];
  let offset = 0;
  const arcs: { level: number; len: number; offset: number }[] = [];
  for (const l of LEVELS) {
    const v = dist[l];
    if (!v) continue;
    const len = (c * v) / total;
    arcs.push({ level: l, len, offset });
    offset += len;
  }
  return arcs;
}

/** Доля в процентах, целым числом. */
export const pct = (v: number, total: number) => (total ? Math.round((v / total) * 100) : 0);

/** Ответы по коду раздела. */
export const answersByCode = (answers: readonly Answer[]) => new Map(answers.map((a) => [a.code, a]));

/** Слабые места: разделы на базовом уровне, ключевые первыми, дальше — по порядку методики. */
export function weakSections(m: Methodology, answers: readonly Answer[]): Section[] {
  const by = answersByCode(answers);
  const list = sectionsOf(m).filter((s) => by.get(s.code)?.level === 1);
  return [...list.filter((s) => s.key), ...list.filter((s) => !s.key)];
}

/** Неотвеченные разделы — коды по порядку методики. */
export function unanswered(m: Methodology, answers: readonly Answer[]): string[] {
  const by = answersByCode(answers);
  return sectionsOf(m).filter((s) => !by.get(s.code)?.level).map((s) => s.code);
}

/** Какую оценку открыть: черновик, иначе последнюю неархивную, иначе любую. Список уже по дате, новые первыми. */
export function defaultAssessmentId(items: readonly AssessmentSummary[]): string | null {
  return (items.find((a) => a.status === 'draft') ?? items.find((a) => a.status !== 'archived') ?? items[0])?.id ?? null;
}

/** Тон статуса: черновик — акцент, зафиксирована — зелёный, архив — серый. */
export const STATUS_TONE: Record<AssessmentSummary['status'], string> = { draft: 'acc', final: 'low', archived: '' };

/** «Изменено: И. Иванов, 30.10 14:05». */
export function changedText(a: Pick<Answer, 'updatedAt' | 'updatedBy'>): string {
  if (!a.updatedBy) return '';
  const d = new Date(a.updatedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `Изменено: ${a.updatedBy}, ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Название новой оценки по умолчанию: «Экспресс-оценка <год даты>». */
export const defaultTitle = (isoDate: string) => `Экспресс-оценка ${isoDate.slice(0, 4)}`;

/**
 * Строка журнала внутри оценки: без повтора «Самооценка «<название>», » — название и так на экране.
 * «Самооценка «X» зафиксирована…» → «Зафиксирована…».
 */
export function logText(summary: string, title: string): string {
  const prefix = `Самооценка «${title}»`;
  if (!summary.startsWith(prefix)) return summary;
  const rest = summary.slice(prefix.length).replace(/^[,:]?\s*/, '');
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : summary;
}

/** Название задачи по разрыву по умолчанию: название раздела без кода и баллов (решение владельца 8). */
export const defaultTaskTitle = (sectionName: string) => `${sectionName}: усилить`;

/** Состояние задачи с доски — подпись и тон: выполнена, в архиве, удалена или статус колонки. */
export function taskState(t: Pick<LinkedTask, 'status' | 'done' | 'archived' | 'deleted'>): { text: string; tone: string } {
  if (t.deleted) return { text: 'удалена', tone: '' };
  if (t.archived) return { text: `в архиве · ${t.status}`, tone: '' };
  return { text: t.status, tone: t.done ? 'low' : 'acc' };
}

/** Счётчики «Плана»: разрывы, баллы при достижении целей, разрывы без задачи, задачи выполнено из всех. */
export function planCounts(score: Pick<Score, 'gaps' | 'gapPoints'>, tasks: readonly Pick<LinkedTask, 'code' | 'done' | 'deleted'>[]) {
  const live = tasks.filter((t) => !t.deleted);
  const withTask = new Set(live.map((t) => t.code));
  return {
    gaps: score.gaps.length,
    points: score.gapPoints,
    withoutTask: score.gaps.filter((g) => !withTask.has(g.code)).length,
    done: live.filter((t) => t.done).length,
    total: live.length,
  };
}

/** Слайды презентации по порядку (спецификация, раздел 10). */
export const PRESENTATION_SLIDES = ['Итог', 'Шкала уровней', 'Профиль по доменам', 'Средний балл', 'Распределение и слабые места', 'План'] as const;

/** Следующий слайд: без перехода по кругу — на последнем «вперёд» и на первом «назад» ничего не делают. */
export const flipSlide = (i: number, delta: number, n: number) => Math.max(0, Math.min(n - 1, i + delta));
