// Чистые функции конструктора реестров: без React, покрыты тестами.
import { FILTER_PARAMS, type BasisRule, type CalcRule, type Deadline, type DueRule, type FieldOption, type FieldType, type RecordFilterParams, type RegisterDetail, type RegisterField, type RegisterRecord, type ScoreRule } from '../../api/registers';

export const TYPE_NAMES: Record<FieldType, string> = {
  text: 'Текст',
  select: 'Список',
  number: 'Число',
  date: 'Дата',
  user: 'Сотрудник',
  calc: 'Вычисляемое',
  decision: 'Решение другого отдела',
  catalog: 'Значение справочника',
  file: 'Файл',
  link: 'Связь с записью',
};

export const ROLE_NAMES: Record<string, string> = {
  '': 'Не используется',
  dimension: 'Группировка (график)',
  metric: 'Показатель (среднее, максимум)',
  date: 'Динамика по датам',
  deadline: 'Контроль сроков',
};

/** Совместимость роли аналитики с типом — та же, что на сервере. */
export const ALLOWED_ROLES: Record<FieldType, string[]> = {
  // Текст — измерение с 1.8.0 (кроме многострочного — backend отклонит).
  text: ['dimension'],
  select: ['dimension'],
  decision: ['dimension'],
  user: ['dimension'],
  catalog: ['dimension'],
  number: ['metric'],
  date: ['date', 'deadline'],
  calc: ['deadline', 'date'],
  file: [],
  link: [],
};

/** Безопасные смены типа: куда можно перевести поле (окончательно решает сервер с предпросмотром). */
export function typeTargets(type: FieldType): FieldType[] {
  if (type === 'calc' || type === 'decision' || type === 'file' || type === 'link') return [];
  // «Значение справочника» — только в текст; в него ничего не превращается.
  if (type === 'catalog') return ['text'];
  if (type === 'text') return ['number', 'date', 'select', 'user'];
  return ['text', ...(['number', 'date', 'select', 'user'] as FieldType[]).filter((t) => t !== type)];
}

export function fieldName(reg: RegisterDetail, id: string | null | undefined): string {
  return reg.fields.find((f) => f.id === id)?.label ?? '?';
}

export function isScoreRule(r: CalcRule | null | undefined): r is ScoreRule {
  return !!r && 'kind' in r && r.kind === 'vuln_score';
}

export function isBasisRule(r: CalcRule | null | undefined): r is BasisRule {
  return !!r && 'kind' in r && r.kind === 'link_basis';
}

export function dueRuleOf(field: RegisterField): DueRule | null {
  const r = field.calcRule;
  return r && !isScoreRule(r) && !isBasisRule(r) ? r : null;
}

/** Статус основания: подписи и цвет метки. */
export const BASIS_NAMES: Record<string, string> = { ok: 'есть основание', none: 'нет основания', expired: 'истекло', closed: 'канал закрыт' };
export const BASIS_TONES: Record<string, string> = { ok: 'low', none: 'crit', expired: 'high', closed: '' };

/**
 * «Выявлено» + срок по «Уровень» (Высокий 14 дн., Средний 30 дн.); если задано «Новый срок» — оно.
 * Оценка уязвимости: «CVSS» × Кэ по «Эксплойт» × Ки по «Исправление».
 */
export function describeRule(reg: RegisterDetail, field: RegisterField): string {
  const r = field.calcRule;
  if (!r) return '';
  if (isBasisRule(r)) {
    return `статус основания по каналу «${fieldName(reg, r.channelFieldId)}»: действующие разрешения, которые ссылаются на запись (сверка по связи, не по ФИО)`;
  }
  if (isScoreRule(r)) {
    return `«${fieldName(reg, r.cvssFieldId)}» × Кэ по «${fieldName(reg, r.exploitFieldId)}» (1,00 / 0,94 / 0,91) × Ки по «${fieldName(reg, r.fixFieldId)}» (0,95 / 1,00), округление вверх до 0,1`;
  }
  const by = reg.fields.find((f) => f.id === r.byFieldId);
  const days = Object.entries(r.days)
    .map(([o, n]) => `${by?.options.find((x) => x.id === o)?.label ?? '?'} ${n} дн.`)
    .join(', ');
  const when = r.overrideWhenFilledFieldId ? ` и «${fieldName(reg, r.overrideWhenFilledFieldId)}»` : '';
  return `«${fieldName(reg, r.fromFieldId)}» + срок по «${fieldName(reg, r.byFieldId)}» (${days})${
    r.overrideFieldId ? `; если задано «${fieldName(reg, r.overrideFieldId)}»${when} — берётся оно` : ''
  }${r.shiftToWorkday ? '; выходной или праздник — перенос на рабочий день' : ''}`;
}

/** Вычисляемое значение для карточки: срок — ДД.ММ.ГГГГ, оценка — «9,4». */
export function formatCalc(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  return formatDate(v);
}

/** Поле контроля сроков: дата или вычисляемый срок с ролью «срок». */
export function deadlineFieldOf(reg: RegisterDetail): RegisterField | undefined {
  return reg.fields.find((f) => !f.archived && f.analyticsRole === 'deadline' && (f.type === 'date' || (f.type === 'calc' && !!dueRuleOf(f))));
}

/** Метка «Дней до срока» — как в прототипе: просрочено / ≤ 7 дней / в срок / закрыто. */
export function deadlineChip(d: Deadline | null | undefined): { cls: string; text: string } | null {
  if (!d || d.state === 'none') return null;
  const n = d.daysLeft ?? 0;
  switch (d.state) {
    case 'closed':
      return { cls: '', text: 'Закрыто' };
    case 'overdue':
      return { cls: 'crit', text: `Просрочено ${-n} дн.` };
    case 'soon':
      return { cls: 'high', text: n === 0 ? 'Срок сегодня' : `Осталось ${n} дн.` };
    default:
      return { cls: 'low', text: `В срок · ${n} дн.` };
  }
}

/** Цвет значения критичности по системному ключу (переименование не ломает цвет). */
const CRIT_TONES: Record<string, string> = { critical: 'crit', high: 'high', medium: 'med', low: 'low' };
export function optionTone(o: FieldOption | undefined): string | null {
  return o?.systemKey ? (CRIT_TONES[o.systemKey] ?? null) : null;
}

export const EVENT_TYPE_NAMES: Record<string, string> = { remind: 'Напоминание', notify: 'Уведомление', escalate: 'Эскалация', set_option: 'Установить значение' };

/** Поле вводится в форме. Файлы прикладываются отдельно, сразу (не через «Сохранить»). */
export const isWritable = (t: FieldType) => t !== 'calc' && t !== 'decision' && t !== 'file';

/** Черновик формы: все значения — строки, как в полях ввода; связь — id записей через запятую. */
export type Draft = Record<string, string>;

export function draftOf(reg: RegisterDetail, rec: RegisterRecord | null): Draft {
  const d: Draft = {};
  for (const f of reg.fields) {
    if (!isWritable(f.type)) continue;
    const v = rec?.values[f.id];
    d[f.id] = v === undefined ? '' : Array.isArray(v) ? v.join(',') : String(v);
  }
  return d;
}

/** Значение из поля ввода → для API: число для числовых полей, массив id для связи, null — очистить. */
export function toApiValue(type: FieldType, s: string): string | number | string[] | null {
  const t = s.trim();
  if (t === '') return null;
  if (type === 'link') return t.split(',').filter(Boolean);
  if (type === 'number') {
    const n = Number(t.replace(',', '.'));
    return Number.isFinite(n) ? n : t;
  }
  return t;
}

/** Только изменённые поля: PATCH не трогает остальное (и не мешает чужим правкам других полей). */
export function changedValues(reg: RegisterDetail, original: Draft, draft: Draft): Record<string, string | number | string[] | null> {
  const out: Record<string, string | number | string[] | null> = {};
  const key = (v: ReturnType<typeof toApiValue>) => (Array.isArray(v) ? [...v].sort().join(',') : v);
  for (const f of reg.fields) {
    if (!isWritable(f.type) || f.archived || f.managed) continue;
    const before = toApiValue(f.type, original[f.id] ?? '');
    const after = toApiValue(f.type, draft[f.id] ?? '');
    if (key(before) !== key(after)) out[f.id] = after;
  }
  return out;
}

/** Изменённые поля, которые при текущем статусе меняются только с причиной. */
export function reasonFields(reg: RegisterDetail, rec: RegisterRecord | null, changed: Record<string, unknown>): RegisterField[] {
  if (!rec) return [];
  return reg.fields.filter((f) => f.id in changed && rec.locked[f.id] === 'reason' && (rec.values[f.id] ?? '') !== '');
}

/** Отступы слева для первых n закреплённых столбцов по их ширинам. */
export function pinOffsets(widths: number[], n: number): number[] {
  const out: number[] = [];
  let left = 0;
  for (let i = 0; i < Math.min(n, widths.length); i++) {
    out.push(left);
    left += widths[i] ?? 0;
  }
  return out;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** Колонки таблицы записей: неархивные поля по порядку (заголовок — первым). */
export function visibleColumns(reg: RegisterDetail): RegisterField[] {
  const live = reg.fields.filter((f) => !f.archived);
  const title = live.find((f) => f.isTitle);
  return title ? [title, ...live.filter((f) => f !== title)] : live;
}

const DEADLINE_NAMES: Record<string, string> = { overdue: 'Просрочено', soon: '≤ 7 дней', ok: 'В срок', closed: 'Закрыто', none: 'Без срока' };

/** Фильтр из адреса (ссылки дашборда) — только параметры фильтра, без поиска и ?record. */
export function filterFromParams(params: URLSearchParams): RecordFilterParams {
  const out: RecordFilterParams = {};
  for (const k of FILTER_PARAMS) {
    const v = params.get(k);
    if (v) out[k] = v;
  }
  return out;
}

/** Подпись применённого фильтра: «Открытые · Критичность: Критическая, Высокая». */
export function describeFilter(reg: RegisterDetail, f: RecordFilterParams): string[] {
  const parts: string[] = [];
  if (f.state === 'open') parts.push('Открытые');
  if (f.state === 'closed') parts.push('Закрытые');
  if (f.deadline) parts.push(f.deadline.split(',').map((s) => DEADLINE_NAMES[s] ?? s).join(', '));
  if (f.f) {
    const sep = f.f.indexOf(':');
    const fieldId = sep > 0 ? f.f.slice(0, sep) : f.f;
    const values = sep > 0 ? f.f.slice(sep + 1) : '';
    const field = reg.fields.find((x) => x.id === fieldId);
    // Текстовое измерение (1.8.0): значение целиком, в нём бывают запятые.
    const labels = field?.type === 'text' ? [values === 'empty' ? 'не заполнено' : values] : values.split(',').filter(Boolean).map((v) => (v === 'empty' ? 'не заполнено'
      : isBasisRule(field?.calcRule) ? BASIS_NAMES[v] ?? v
      : field?.options.find((o) => o.id === v)?.label ?? 'выбранное значение'));
    parts.push(`${field?.label ?? 'Поле'}: ${labels.join(', ')}`);
  }
  if (f.lopen) {
    const field = reg.fields.find((x) => x.id === f.lopen);
    parts.push(`${field?.label ?? 'Связь'}: без закрытых записей`);
  }
  if (f.date) {
    const field = reg.fields.find((x) => x.id === f.date);
    const range = [f.from ? `с ${formatDate(f.from)}` : '', f.to ? `по ${formatDate(f.to)}` : ''].filter(Boolean).join(' ');
    parts.push(`${field?.label ?? 'Дата'}: ${range || 'заполнено'}`);
  }
  return parts;
}
