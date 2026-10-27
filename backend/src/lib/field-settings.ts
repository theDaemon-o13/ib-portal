// Настройки поля реестра (register_fields.settings, этап 8б, ADR-0013). Чистые функции без БД.
//
//   lock — фиксация при статусах записи: { statusOptionIds: [id значений поля статуса], mode }
//     locked — заполненное значение не меняется и не очищается (файл не отвязывается, второй не добавляется);
//              пустое можно заполнить один раз. Дублируется триггером register_records_lock_guard.
//     reason — значение меняется только с причиной; причина пишется в историю записи и журнал.
//     Пока статус записи фиксирующий, запись не удаляется, а статус меняется только на другой фиксирующий.
//   date — только у поля-даты: notAfterYearEndOfFieldId — «не позже 31.12 года поля N» (N — дата той же записи);
//          defaultEndOfYear — новая запись получает 31.12 текущего года.

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

export interface FieldSettings {
  lock?: LockSettings;
  date?: DateSettings;
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
  return Object.keys(out).length ? out : null;
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
