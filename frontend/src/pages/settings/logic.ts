// Чистые функции раздела «Настройки»: без React, покрыты тестами.

export const TONE_OPTIONS = [
  { tone: 'accent', label: 'Синий' },
  { tone: 'info', label: 'Индиго' },
  { tone: 'low', label: 'Зелёный' },
  { tone: 'high', label: 'Оранжевый' },
  { tone: 'med', label: 'Жёлтый' },
  { tone: 'crit', label: 'Красный' },
  { tone: 'muted', label: 'Серый' },
] as const;

export type ToneKey = (typeof TONE_OPTIONS)[number]['tone'];

export const CHECK_KINDS = [
  { kind: 'min', label: 'Число, не менее' },
  { kind: 'max', label: 'Число, не более' },
  { kind: 'yes', label: 'Да / нет, нужно «да»' },
  { kind: 'text', label: 'Текст, без проверки' },
] as const;

export type CheckKindKey = (typeof CHECK_KINDS)[number]['kind'];

export function needsThreshold(kind: CheckKindKey): boolean {
  return kind === 'min' || kind === 'max';
}

export function requirementText(kind: CheckKindKey, threshold: number | null): string {
  const n = threshold === null ? '' : String(threshold).replace('.', ',');
  if (kind === 'min') return `не менее ${n}`;
  if (kind === 'max') return `не более ${n}`;
  if (kind === 'yes') return 'да';
  return 'заполняется';
}

export function checkKindLabel(kind: string): string {
  return CHECK_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

/** «VPN, шлюз,, vpn» → ['vpn', 'шлюз'] — так же нормализует backend. */
export function parseKeywords(text: string): string[] {
  const out: string[] = [];
  for (const k of text.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) if (!out.includes(k)) out.push(k);
  return out;
}

export const WEEKDAYS = [
  { n: 1, short: 'Пн', name: 'понедельник' },
  { n: 2, short: 'Вт', name: 'вторник' },
  { n: 3, short: 'Ср', name: 'среда' },
  { n: 4, short: 'Чт', name: 'четверг' },
  { n: 5, short: 'Пт', name: 'пятница' },
  { n: 6, short: 'Сб', name: 'суббота' },
  { n: 7, short: 'Вс', name: 'воскресенье' },
] as const;

/** Переключить день недели в списке выходных; хотя бы один рабочий день должен остаться. */
export function toggleWeekend(days: readonly number[], n: number): number[] | null {
  const next = days.includes(n) ? days.filter((d) => d !== n) : [...days, n].sort((a, b) => a - b);
  return next.length >= 7 ? null : next;
}

/** 2026-03-21 → «21.03.2026, сб». Дата календаря без часового пояса. */
export function formatCalendarDay(iso: string): string {
  const [y, m, d] = iso.split('-');
  const wd = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return `${d}.${m}.${y}, ${(WEEKDAYS[(wd + 6) % 7]?.short ?? '').toLowerCase()}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function initials(fullName: string): string {
  const letters = fullName.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).map((w) => w[0]);
  return (letters.slice(-2).join('') || '?').toUpperCase();
}
