// Цвета значений справочников — ключи тонов из tokens.css, а не hex: подстраиваются под тему.
export const TONES = ['accent', 'info', 'low', 'high', 'med', 'crit', 'muted'] as const;
export type Tone = (typeof TONES)[number];
