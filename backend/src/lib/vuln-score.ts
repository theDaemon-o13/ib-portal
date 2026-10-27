// Оценка и критичность уязвимости (CLAUDE.md, раздел 7, правила 1–3; процедура, п. 7.1–7.2).
// Чистые функции: множители выбираются по системным ключам значений списков, а не по тексту,
// поэтому переименование значения в конструкторе формулу не ломает.

/** Системные ключи значений поля «Эксплойт». */
export const EXPLOIT_KEYS = ['exploited', 'exists', 'none', 'nodata'] as const;
export type ExploitKey = (typeof EXPLOIT_KEYS)[number];

/** Системные ключи значений поля «Исправление». */
export const FIX_KEYS = ['released', 'not_released'] as const;
export type FixKey = (typeof FIX_KEYS)[number];

/** Системные ключи значений поля «Критичность», от высшей к низшей. */
export const CRIT_KEYS = ['critical', 'high', 'medium', 'low'] as const;
export type CritKey = (typeof CRIT_KEYS)[number];

/** Кэ: 1,00 — «есть, эксплуатируется»; 0,94 — «есть»; 0,91 — в остальных случаях. */
export function exploitFactor(key: string | null | undefined): number {
  if (key === 'exploited') return 1;
  if (key === 'exists') return 0.94;
  return 0.91;
}

/** Ки: 0,95 — исправление выпущено; 1,00 — нет или неизвестно. */
export function fixFactor(key: string | null | undefined): number {
  return key === 'released' ? 0.95 : 1;
}

/**
 * Оценка = CVSS × Кэ × Ки, округление вверх до 0,1. Нет CVSS — null.
 * Перед округлением вверх убирается погрешность двоичной арифметики: 7 × 0,94 = 6,579999… → 6,58 → 6,6.
 */
export function vulnScore(cvss: number | null | undefined, exploitKey: string | null | undefined, fixKey: string | null | undefined): number | null {
  if (cvss === null || cvss === undefined || !Number.isFinite(cvss)) return null;
  const x = cvss * exploitFactor(exploitKey) * fixFactor(fixKey);
  return Math.ceil(Math.round(x * 1e6) / 1e5) / 10;
}

/** Критичность по Оценке: ≥ 9,0 — критическая, ≥ 7,0 — высокая, ≥ 4,0 — средняя, иначе низкая. Нет Оценки — высокая. */
export function critKeyOf(score: number | null): CritKey {
  if (score === null) return 'high';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/** Срок устранения в календарных днях от даты передачи отчёта в ДИКТ (п. 7.2). */
export const DUE_DAYS: Record<CritKey, number> = { critical: 14, high: 30, medium: 90, low: 180 };

/** «Обновить до версии» из отчёта → выпущено ли исправление. Пусто или «не выпущено» — нет. */
export function fixKeyFromText(text: string | null | undefined): FixKey {
  const t = (text ?? '').trim();
  if (!t || /не\s*выпущ|отсутству|нет\s+исправл/i.test(t)) return 'not_released';
  return 'released';
}
