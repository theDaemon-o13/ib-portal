// Чистые функции раздела «Осведомлённость → учебные письма» (1.9.0): подписи, сравнение версий. Без React, с тестами.
import type { Cadence, Letter, LetterItem, LetterStatus } from '../../api/awareness';

export const STATUS_NAME: Record<LetterStatus, string> = { draft: 'Черновик', review: 'На согласовании', approved: 'Утверждено', sent: 'Отправлено' };
export const STATUS_TONE: Record<LetterStatus, string> = { draft: '', review: 'high', approved: 'acc', sent: 'low' };
export const KIND_NAME = { planned: 'Плановое', urgent: 'Срочное' } as const;
export const LANG_MARK_NAME = { only_ru: 'только RU', only_tj: 'только TJ' } as const;

export const VERSION_REASON: Record<Letter['versions'][number]['reason'], string> = {
  created: 'создано', edit: 'правка', restore: 'восстановлена', template: 'из шаблона', copy: 'копия', sent: 'отправка',
};

export const EVENT_NAME: Record<Letter['events'][number]['action'], string> = {
  submitted: 'Отправлено на согласование',
  withdrawn: 'Отозвано с согласования',
  approved: 'Утверждено',
  returned: 'Возвращено на доработку',
  approval_dropped: 'Утверждение снято (письмо изменили)',
  sent: 'Отмечено отправленным',
  archived: 'Отправлено в архив',
  unarchived: 'Возвращено из архива',
};

export const ru = (iso: string) => iso.slice(0, 10).split('-').reverse().join('.');
export const ruDateTime = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Пометки письма в списке и карточке: «только RU», «без независимого согласования», «отправлено без согласования». */
export function letterMarks(l: Pick<LetterItem, 'langMark'> & Partial<Pick<Letter, 'selfApproved' | 'sentWithoutApproval'>>): string[] {
  const out: string[] = [];
  if (l.langMark) out.push(LANG_MARK_NAME[l.langMark]);
  if (l.selfApproved) out.push('без независимого согласования');
  if (l.sentWithoutApproval) out.push('отправлено без согласования');
  return out;
}

const decode = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * Текст письма построчно для сравнения версий: абзацы, заголовки, пункты списков и строки таблиц — отдельные строки;
 * изображение — «[изображение]», блок подписи — «[Подпись ИБ]», ссылка — «текст (адрес)».
 */
export function htmlToLines(html: string): string[] {
  const text = html
    .replace(/<div data-ib-fragment="signature"><\/div>/g, '\n[Подпись ИБ]\n')
    .replace(/<img\b[^>]*>/gi, '[изображение]')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => `${t} (${href})`)
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|blockquote|div|ul|ol|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(text).split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
}

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** Построчное сравнение (наибольшая общая подпоследовательность): было → стало. */
export function lineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] = before[i] === after[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: 'same', text: before[i] as string });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ kind: 'del', text: before[i++] as string });
    } else {
      out.push({ kind: 'add', text: after[j++] as string });
    }
  }
  while (i < n) out.push({ kind: 'del', text: before[i++] as string });
  while (j < m) out.push({ kind: 'add', text: after[j++] as string });
  return out;
}

export const hasChanges = (d: readonly DiffLine[]) => d.some((l) => l.kind !== 'same');

/** «Отправлено без согласования: …» — причина при отметке срочного письма без согласования. */
export const WITHOUT_APPROVAL_PREFIX = 'Отправлено без согласования: ';
export function withoutApprovalComment(reason: string): string {
  const r = reason.trim();
  return r ? (r.startsWith(WITHOUT_APPROVAL_PREFIX) ? r : `${WITHOUT_APPROVAL_PREFIX}${r}`) : '';
}

// ---------------------------------------------------------------- шаблоны (раздел 17.2)

const VAR_RE = /\{\{([^{}]*)\}\}/g;
const decodeVar = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e] ?? '');
/** Ключ переменной — как у backend (variables.ts): без регистра, пробелы схлопнуты, «ё» = «е». */
export const variableKey = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
export const SIGNATURE_VARIABLE = 'подпись';

/** Переменные {{…}} из тем и текстов по порядку появления, без служебной {{подпись}}; подпись поля — первое написание. */
export function templateVariables(texts: readonly string[]): { key: string; label: string }[] {
  const seen = new Map<string, { key: string; label: string }>();
  for (const t of texts) {
    for (const m of t.matchAll(VAR_RE)) {
      const label = decodeVar(m[1] ?? '').replace(/\s+/g, ' ').trim();
      const key = variableKey(label);
      if (!label || key === SIGNATURE_VARIABLE || seen.has(key)) continue;
      seen.set(key, { key, label });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- расписание (раздел 19)


export type CadenceKind = Cadence['kind'];
export const CADENCE_KINDS: { key: CadenceKind; title: string }[] = [
  { key: 'monthly', title: 'Ежемесячно' },
  { key: 'twice_monthly', title: 'Дважды в месяц' },
  { key: 'quarterly', title: 'Ежеквартально' },
  { key: 'yearly', title: 'Ежегодно' },
  { key: 'weekly', title: 'Каждую N-ю неделю' },
];
export const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** Поля формы периодичности: все сразу, в правило попадают нужные виду. */
export interface CadenceForm { kind: CadenceKind; day: number; day2: number; month: number; quarterMonth: number; every: number; weekday: number }
export const DEFAULT_CADENCE: CadenceForm = { kind: 'monthly', day: 10, day2: 25, month: 1, quarterMonth: 1, every: 2, weekday: 3 };

export function cadenceOf(f: CadenceForm): Cadence {
  switch (f.kind) {
    case 'monthly': return { kind: 'monthly', day: f.day };
    case 'twice_monthly': return { kind: 'twice_monthly', days: [f.day, f.day2] };
    case 'quarterly': return { kind: 'quarterly', month: f.quarterMonth, day: f.day };
    case 'yearly': return { kind: 'yearly', month: f.month, day: f.day };
    case 'weekly': return { kind: 'weekly', every: f.every, weekday: f.weekday };
  }
}

export function formOfCadence(c: Cadence): CadenceForm {
  const f = { ...DEFAULT_CADENCE, kind: c.kind };
  if (c.kind === 'monthly') return { ...f, day: c.day };
  if (c.kind === 'twice_monthly') return { ...f, day: c.days[0], day2: c.days[1] };
  if (c.kind === 'quarterly') return { ...f, quarterMonth: c.month, day: c.day };
  if (c.kind === 'yearly') return { ...f, month: c.month, day: c.day };
  return { ...f, every: c.every, weekday: c.weekday };
}

export const LEAD_DAYS = { min: 7, max: 90, default: 10 } as const;
export function leadDaysProblem(n: number): string | null {
  if (Number.isNaN(n)) return 'Укажите опережение: от 7 до 90 дней';
  if (!Number.isInteger(n)) return 'Опережение — целое число дней';
  if (n < LEAD_DAYS.min) return `Не меньше ${LEAD_DAYS.min} дней: этап «черновик» начинается за 7 дней до отправки`;
  if (n > LEAD_DAYS.max) return `Не больше ${LEAD_DAYS.max} дней`;
  return null;
}
