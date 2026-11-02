// Настройки поля реестра (register_fields.settings, этап 8б, ADR-0013). Чистые функции без БД.
//
//   lock — фиксация при статусах записи: { statusOptionIds: [id значений поля статуса], mode }
//     locked — заполненное значение не меняется и не очищается (файл не отвязывается, второй не добавляется);
//              пустое можно заполнить один раз. Дублируется триггером register_records_lock_guard.
//     reason — значение меняется только с причиной; причина пишется в историю записи и журнал.
//     Пока статус записи фиксирующий, запись не удаляется, а статус меняется только на другой фиксирующий.
//   date — только у поля-даты: notAfterYearEndOfFieldId — «не позже 31.12 года поля N» (N — дата той же записи);
//          defaultEndOfYear — новая запись получает 31.12 текущего года.
//   text — только у текстового поля: multiline — многострочный текст (в карточке поле от 6 строк),
//          лимит TEXT_MAX_MULTILINE вместо TEXT_MAX (релиз 1.1.0).
//   hint — подсказка под полем в карточке записи, любой тип (релиз 1.6.0: RTO и RPO по категориям).

/** Лимит текстового поля, символов. */
export const TEXT_MAX = 4000;
/** Лимит многострочного текстового поля: меньше лимита ячейки Excel (32 767). */
export const TEXT_MAX_MULTILINE = 20_000;
/** Лимит подсказки поля, символов. */
export const HINT_MAX = 1000;

export const LOCK_MODES = ['locked', 'reason'] as const;
export type LockMode = (typeof LOCK_MODES)[number];

export interface LockSettings {
  statusOptionIds: string[];
  mode: LockMode;
}

export interface DateSettings {
  notAfterYearEndOfFieldId?: string | null;
  defaultEndOfYear?: boolean;
}

export interface TextSettings {
  multiline?: boolean;
}

export interface FieldSettings {
  lock?: LockSettings;
  date?: DateSettings;
  text?: TextSettings;
  hint?: string;
}

/** Хранимое значение → настройки (пустой объект, если ничего не задано или формат чужой). */
export function readSettings(raw: unknown): FieldSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: FieldSettings = {};
  const lock = o.lock as Record<string, unknown> | undefined;
  if (lock && Array.isArray(lock.statusOptionIds)) {
    out.lock = {
      statusOptionIds: lock.statusOptionIds.filter((x): x is string => typeof x === 'string'),
      mode: lock.mode === 'reason' ? 'reason' : 'locked',
    };
  }
  const date = o.date as Record<string, unknown> | undefined;
  if (date && typeof date === 'object') {
    out.date = {};
    if (typeof date.notAfterYearEndOfFieldId === 'string') out.date.notAfterYearEndOfFieldId = date.notAfterYearEndOfFieldId;
    if (date.defaultEndOfYear === true) out.date.defaultEndOfYear = true;
  }
  const text = o.text as Record<string, unknown> | undefined;
  if (text && typeof text === 'object' && text.multiline === true) out.text = { multiline: true };
  if (typeof o.hint === 'string' && o.hint.trim()) out.hint = o.hint;
  return out;
}

/** Пустые разделы не храним: null — у поля нет настроек. */
export function compactSettings(s: FieldSettings): FieldSettings | null {
  const out: FieldSettings = {};
  if (s.lock && s.lock.statusOptionIds.length) out.lock = { statusOptionIds: [...new Set(s.lock.statusOptionIds)], mode: s.lock.mode };
  if (s.date && (s.date.notAfterYearEndOfFieldId || s.date.defaultEndOfYear)) {
    out.date = {
      ...(s.date.notAfterYearEndOfFieldId ? { notAfterYearEndOfFieldId: s.date.notAfterYearEndOfFieldId } : {}),
      ...(s.date.defaultEndOfYear ? { defaultEndOfYear: true } : {}),
    };
  }
  if (s.text?.multiline) out.text = { multiline: true };
  if (s.hint?.trim()) out.hint = s.hint.trim();
  return Object.keys(out).length ? out : null;
}

/** Лимит длины значения текстового поля. */
export function textLimit(settings: FieldSettings | undefined): number {
  return settings?.text?.multiline ? TEXT_MAX_MULTILINE : TEXT_MAX;
}

export interface LockableField {
  id: string;
  label: string;
  settings: FieldSettings;
}

/** Поля, которые фиксирует текущий статус записи: { id поля → режим }. */
export function lockedFields(fields: readonly LockableField[], statusValue: unknown): Map<string, LockMode> {
  const out = new Map<string, LockMode>();
  if (typeof statusValue !== 'string') return out;
  for (const f of fields) {
    if (f.settings.lock?.statusOptionIds.includes(statusValue)) out.set(f.id, f.settings.lock.mode);
  }
  return out;
}

/** Все фиксирующие значения статуса в реестре (объединение по полям). */
export function lockingStatusIds(fields: readonly LockableField[]): Set<string> {
  return new Set(fields.flatMap((f) => f.settings.lock?.statusOptionIds ?? []));
}

/** 31.12 года даты YYYY-MM-DD. */
export function endOfYear(iso: string): string {
  return `${iso.slice(0, 4)}-12-31`;
}

/**
 * Проверка «не позже 31.12 года поля N»: null — в порядке (или опорная дата не заполнена — проверять не с чем),
 * иначе — текст ошибки.
 */
export function checkNotAfterYearEnd(value: unknown, anchor: unknown, anchorLabel: string): string | null {
  if (typeof value !== 'string' || typeof anchor !== 'string') return null;
  const limit = endOfYear(anchor);
  if (value <= limit) return null;
  const [y, m, d] = limit.split('-');
  return `не позже ${d}.${m}.${y} (31.12 года «${anchorLabel}»)`;
}
