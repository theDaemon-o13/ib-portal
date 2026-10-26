// Значения полей реестра: проверка ввода, отображение, вычисляемый срок, смена типа, разбор ячеек Excel.
// Чистые функции без БД — правила этапа 3 проверяются модульными тестами.
//
// Хранение (register_records.values, ключ — id поля):
//   text → строка; number → число; date → 'YYYY-MM-DD'; select → id варианта; user → id пользователя.
//   Вычисляемое поле (calc) и решение другого отдела (decision) в values не хранятся никогда.

export const FIELD_TYPES = ['text', 'select', 'number', 'date', 'user', 'calc', 'decision'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const ANALYTICS_ROLES = ['dimension', 'metric', 'date', 'deadline'] as const;
export type AnalyticsRole = (typeof ANALYTICS_ROLES)[number];

/** Совместимость роли аналитики с типом — та же, что CHECK в БД. */
export const ALLOWED_ROLES: Record<FieldType, readonly AnalyticsRole[]> = {
  text: [],
  select: ['dimension'],
  decision: ['dimension'],
  user: ['dimension'],
  number: ['metric'],
  date: ['date', 'deadline'],
  calc: ['deadline', 'date'],
};

export const TEXT_MAX = 4000;

export type StoredValue = string | number;
export type Values = Record<string, StoredValue>;

export interface OptionDef {
  id: string;
  label: string;
  isClosed: boolean;
  archived: boolean;
}

export interface CalcRule {
  fromFieldId: string;
  byFieldId: string;
  days: Record<string, number>;
  overrideFieldId: string | null;
}

export interface FieldDef {
  id: string;
  label: string;
  type: FieldType;
  options: OptionDef[];
  calcRule: CalcRule | null;
  archived: boolean;
}

export interface UserRef {
  id: string;
  login: string;
  fullName: string;
  isActive: boolean;
}

/** Поле принимает значения от формы и импорта. */
export function isWritable(type: FieldType): boolean {
  return type !== 'calc' && type !== 'decision';
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

// ---------- даты и числа ----------

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 'ДД.ММ.ГГГГ' или 'YYYY-MM-DD' → 'YYYY-MM-DD'. */
export function parseDateText(s: string): string | null {
  const t = s.trim();
  if (isIsoDate(t)) return t;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (!m) return null;
  const [, d = '', mo = '', y = ''] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** «12,5», «12.5», « 1 200 » → число. */
export function parseNumberText(s: string): number | null {
  const t = s.trim().replace(/[\s ]/g, '').replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function formatDateRu(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function formatNumberRu(n: number): string {
  return String(n).replace('.', ',');
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- проверка ввода (форма) ----------

export interface InputContext {
  /** Пользователи, которых можно назначить (активные сотрудники ИБ), по id. */
  assignableUsers: ReadonlyMap<string, UserRef>;
  /** Текущее значение поля: архивный вариант или отключённого сотрудника можно оставить как есть. */
  current?: StoredValue;
}

/**
 * Значение из формы → хранимое. null — очистить поле.
 * Вычисляемое поле и решение сюда не попадают: их отсекает вызывающий код.
 */
export function normalizeInput(field: FieldDef, raw: unknown, ctx: InputContext): Result<StoredValue | null> {
  if (raw === null || raw === undefined || raw === '') return ok(null);
  switch (field.type) {
    case 'text': {
      if (typeof raw !== 'string') return fail('Ожидается текст');
      const v = raw.trim();
      if (v.length > TEXT_MAX) return fail(`Не длиннее ${TEXT_MAX} символов`);
      return ok(v === '' ? null : v);
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseNumberText(raw) : null;
      return n === null || !Number.isFinite(n) ? fail('Ожидается число') : ok(n);
    }
    case 'date':
      return typeof raw === 'string' && isIsoDate(raw) ? ok(raw) : fail('Ожидается дата');
    case 'select': {
      if (typeof raw !== 'string') return fail('Выберите значение из списка');
      const opt = field.options.find((o) => o.id === raw);
      if (!opt) return fail('Нет такого значения в списке');
      if (opt.archived && ctx.current !== raw) return fail(`Значение «${opt.label}» в архиве`);
      return ok(raw);
    }
    case 'user': {
      if (typeof raw !== 'string') return fail('Выберите сотрудника');
      if (ctx.assignableUsers.has(raw) || ctx.current === raw) return ok(raw);
      return fail('Сотрудник не найден или отключён');
    }
    default:
      return fail('Поле только для чтения');
  }
}

// ---------- отображение ----------

export interface DisplayContext {
  users: ReadonlyMap<string, UserRef>;
  /** Сотрудник в Excel: «ФИО (логин)»; на экране и в истории — «ФИО». */
  userWithLogin?: boolean;
}

export function displayValue(field: FieldDef, v: StoredValue | undefined | null, ctx: DisplayContext): string {
  if (v === undefined || v === null || v === '') return '';
  switch (field.type) {
    case 'number':
      return typeof v === 'number' ? formatNumberRu(v) : String(v);
    case 'date':
    case 'calc':
      return typeof v === 'string' && isIsoDate(v) ? formatDateRu(v) : String(v);
    case 'select':
    case 'decision':
      return field.options.find((o) => o.id === v)?.label ?? '';
    case 'user': {
      const u = ctx.users.get(String(v));
      if (!u) return '';
      return ctx.userWithLogin ? `${u.fullName} (${u.login})` : u.fullName;
    }
    default:
      return String(v);
  }
}

// ---------- вычисляемый срок ----------

/**
 * Срок = дата «от» + дни по значению списка; если заполнена дата-переопределение — берётся она.
 * Только чтение: результат не сохраняется в values.
 */
export function calcValue(rule: CalcRule, values: Values): string | null {
  const override = rule.overrideFieldId ? values[rule.overrideFieldId] : undefined;
  if (typeof override === 'string' && isIsoDate(override)) return override;
  const from = values[rule.fromFieldId];
  const by = values[rule.byFieldId];
  if (typeof from !== 'string' || !isIsoDate(from) || typeof by !== 'string') return null;
  const days = rule.days[by];
  return typeof days === 'number' ? addDays(from, days) : null;
}

// ---------- смена типа поля ----------

export type TypeChangeKind = 'empty' | 'to_text' | 'from_text';

/**
 * Безопасные смены типа (решение владельца проекта):
 *  А — поле без данных: любой тип, кроме вычисляемого и решения;
 *  Б — число, дата, список, сотрудник → текст (отображаемое значение);
 *  В — текст → число, дата, список, если каждое непустое значение распознаётся.
 */
export function typeChangeKind(from: FieldType, to: FieldType, hasData: boolean): Result<TypeChangeKind> {
  if (from === to) return fail('Тип поля не меняется');
  if (from === 'calc' || to === 'calc' || from === 'decision' || to === 'decision') {
    return fail('Вычисляемое поле и решение другого отдела нельзя превратить в другой тип и наоборот');
  }
  if (!hasData) return ok('empty');
  if (to === 'text' && ['number', 'date', 'select', 'user'].includes(from)) return ok('to_text');
  if (from === 'text' && ['number', 'date', 'select'].includes(to)) return ok('from_text');
  return fail('Поле с данными можно перевести только в текст или из текста в число, дату или список');
}

/** Значение при переводе в текст (Б). */
export function toText(field: FieldDef, v: StoredValue, ctx: DisplayContext): string {
  return displayValue(field, v, { ...ctx, userWithLogin: false });
}

/** Значение при переводе из текста (В): null — не распознано. Для списка — подпись варианта. */
export function fromText(to: 'number' | 'date' | 'select', v: StoredValue): number | string | null {
  const s = String(v).trim();
  if (to === 'number') return parseNumberText(s);
  if (to === 'date') return parseDateText(s);
  return s === '' ? null : s;
}

// ---------- ячейки Excel ----------

/** Значение ячейки exceljs → простое значение: строка, число, дата или пусто. */
export function cellPrimitive(cell: unknown): string | number | Date | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'string') return cell.trim() === '' ? null : cell;
  if (typeof cell === 'number' || cell instanceof Date) return cell;
  if (typeof cell === 'boolean') return cell ? 'да' : 'нет';
  if (typeof cell === 'object') {
    const o = cell as { richText?: { text: string }[]; text?: unknown; result?: unknown; error?: unknown };
    if (Array.isArray(o.richText)) return cellPrimitive(o.richText.map((r) => r.text).join(''));
    if (o.error !== undefined) return null;
    if (o.result !== undefined) return cellPrimitive(o.result);
    if (o.text !== undefined) return cellPrimitive(o.text);
  }
  return null;
}

export interface ImportContext {
  /** Все пользователи (для поиска по логину и ФИО). Назначить можно только активного. */
  users: readonly UserRef[];
}

/**
 * Сотрудник из ячейки: «ФИО (логин)» — по логину в скобках; иначе по одному ФИО,
 * только если такое имя у единственного пользователя.
 */
export function findUser(text: string, users: readonly UserRef[]): Result<UserRef> {
  const t = text.trim();
  const m = /\(([^()]+)\)\s*$/.exec(t);
  if (m) {
    const login = (m[1] ?? '').trim().toLowerCase();
    const u = users.find((x) => x.login === login);
    return u ? ok(u) : fail(`Сотрудник с логином ${login} не найден`);
  }
  const same = users.filter((x) => x.fullName.trim().toLowerCase() === t.toLowerCase());
  const [only] = same;
  if (same.length === 1 && only) return ok(only);
  if (same.length > 1) return fail(`Найдено несколько сотрудников «${t}» — укажите логин в скобках: «${t} (логин)»`);
  return fail(`Сотрудник «${t}» не найден`);
}

/**
 * Ячейка импорта → хранимое значение. null — ячейка пустая: значение не меняется.
 * Ошибка — строка не применяется и показывается в предпросмотре.
 */
export function parseCell(field: FieldDef, cell: unknown, ctx: ImportContext): Result<StoredValue | null> {
  const v = cellPrimitive(cell);
  if (v === null) return ok(null);
  switch (field.type) {
    case 'text': {
      const s = v instanceof Date ? formatDateRu(v.toISOString().slice(0, 10)) : String(v).trim();
      return s.length > TEXT_MAX ? fail(`Не длиннее ${TEXT_MAX} символов`) : ok(s);
    }
    case 'number': {
      const n = typeof v === 'number' ? v : v instanceof Date ? null : parseNumberText(v);
      return n === null || !Number.isFinite(n) ? fail(`«${String(v)}» — не число`) : ok(n);
    }
    case 'date': {
      // exceljs отдаёт даты в полночь UTC.
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? fail('Неверная дата') : ok(v.toISOString().slice(0, 10));
      const iso = typeof v === 'string' ? parseDateText(v) : null;
      return iso ? ok(iso) : fail(`«${String(v)}» — не дата. Формат: ДД.ММ.ГГГГ`);
    }
    case 'select': {
      const s = String(v).trim().toLowerCase();
      const opt = field.options.find((o) => !o.archived && o.label.trim().toLowerCase() === s);
      return opt ? ok(opt.id) : fail(`«${String(v)}» — нет такого значения в списке «${field.label}»`);
    }
    case 'user': {
      const r = findUser(String(v), ctx.users);
      if (!r.ok) return r;
      return r.value.isActive ? ok(r.value.id) : fail(`Сотрудник ${r.value.fullName} (${r.value.login}) отключён`);
    }
    default:
      return fail('Поле только для чтения');
  }
}

/** Значения равны (для подсчёта изменений). */
export function sameValue(a: StoredValue | undefined | null, b: StoredValue | undefined | null): boolean {
  const na = a === undefined || a === null || a === '' ? null : a;
  const nb = b === undefined || b === null || b === '' ? null : b;
  return na === nb;
}
