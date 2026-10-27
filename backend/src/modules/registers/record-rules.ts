// Правила записи этапа 8б, общие для формы и импорта Excel (ADR-0013):
// фиксация полей статусом записи, «не позже 31.12 года поля N», значения по умолчанию, связи с записями.
import type { Db } from '../../lib/db.js';
import { checkNotAfterYearEnd, endOfYear, lockingStatusIds } from '../../lib/field-settings.js';
import { sameValue, type Values } from '../../lib/register-values.js';
import { recordLocks, type RegisterDef } from './definition.js';

export interface RuleError {
  /** FIELD_LOCKED, REASON_REQUIRED, STATUS_LOCKED — 422; INVALID_VALUES — 400. */
  code: 'FIELD_LOCKED' | 'REASON_REQUIRED' | 'STATUS_LOCKED' | 'INVALID_VALUES';
  fieldId: string | null;
  message: string;
}

const statusLabel = (reg: RegisterDef, v: unknown) => reg.fields.find((f) => f.isStatus)?.options.find((o) => o.id === v)?.label ?? '';

/**
 * Изменения, которые не разрешает текущий статус записи (before): зафиксированное заполненное значение,
 * изменение «с причиной» без причины, выход статуса из фиксирующих. Пустое зафиксированное поле заполнить можно.
 */
export function lockErrors(reg: RegisterDef, before: Values, after: Values, changed: readonly string[], reason?: string | null): RuleError[] {
  const locks = recordLocks(reg, before);
  if (!locks.size) return [];
  const status = reg.fields.find((f) => f.isStatus);
  const statusName = statusLabel(reg, status ? before[status.id] : undefined);
  const errors: RuleError[] = [];
  for (const fieldId of changed) {
    const mode = locks.get(fieldId);
    const f = reg.fields.find((x) => x.id === fieldId);
    if (!mode || !f) continue;
    const filled = !sameValue(before[fieldId], null);
    if (mode === 'locked' && filled) {
      errors.push({ code: 'FIELD_LOCKED', fieldId, message: `«${f.label}» зафиксировано статусом «${statusName}» — изменить можно только новой записью` });
    } else if (mode === 'reason' && filled && !reason?.trim()) {
      errors.push({ code: 'REASON_REQUIRED', fieldId, message: `«${f.label}» при статусе «${statusName}» меняется только с причиной` });
    }
  }
  if (status && changed.includes(status.id) && !lockingStatusIds(reg.fields).has(String(after[status.id] ?? ''))) {
    errors.push({ code: 'STATUS_LOCKED', fieldId: status.id, message: `Статус «${statusName}» фиксирует запись — сменить его можно только на фиксирующий` });
  }
  return errors;
}

/** «Не позже 31.12 года поля N» — для изменённых дат и для дат, чья опорная дата изменилась. */
export function dateErrors(reg: RegisterDef, values: Values, changed: readonly string[]): RuleError[] {
  const errors: RuleError[] = [];
  for (const f of reg.fields) {
    const anchorId = f.settings.date?.notAfterYearEndOfFieldId;
    if (f.type !== 'date' || !anchorId || (!changed.includes(f.id) && !changed.includes(anchorId))) continue;
    const anchor = reg.fields.find((x) => x.id === anchorId);
    const err = checkNotAfterYearEnd(values[f.id], values[anchorId], anchor?.label ?? '?');
    if (err) errors.push({ code: 'INVALID_VALUES', fieldId: f.id, message: `${f.label}: ${err}` });
  }
  return errors;
}

/**
 * Значения по умолчанию новой записи: дата «31.12 текущего года» (если опорная дата задана — 31.12 её года,
 * но не позже ограничения). Возвращает id заполненных полей.
 */
export function applyDateDefaults(reg: RegisterDef, values: Values, today: string): string[] {
  const filled: string[] = [];
  for (const f of reg.fields) {
    if (f.archived || f.type !== 'date' || !f.settings.date?.defaultEndOfYear || values[f.id] !== undefined) continue;
    const anchorId = f.settings.date.notAfterYearEndOfFieldId;
    const anchor = anchorId ? values[anchorId] : undefined;
    values[f.id] = typeof anchor === 'string' ? endOfYear(anchor) : endOfYear(today);
    filled.push(f.id);
  }
  return filled;
}

/** Связанные записи существуют в реестре поля и не удалены. Ошибка — с номерами пропавших записей. */
export async function linkErrors(db: Db, reg: RegisterDef, values: Values, changed: readonly string[]): Promise<RuleError[]> {
  const fields = reg.fields.filter((f) => f.type === 'link' && changed.includes(f.id) && Array.isArray(values[f.id]));
  if (!fields.length) return [];
  const ids = [...new Set(fields.flatMap((f) => values[f.id] as string[]))];
  const rows = await db.registerRecord.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, registerId: true } });
  const errors: RuleError[] = [];
  for (const f of fields) {
    const bad = (values[f.id] as string[]).filter((id) => rows.find((r) => r.id === id)?.registerId !== f.linkRegisterId);
    if (bad.length) errors.push({ code: 'INVALID_VALUES', fieldId: f.id, message: `${f.label}: связанная запись не найдена или удалена (${bad.length}). Обновите страницу` });
  }
  return errors;
}
