// Производные значения записи реестра уязвимостей: «Критичность» по Оценке (CLAUDE.md, раздел 7, правило 2).
// Критичность хранится в values (её можно поправить вручную), Оценка вычисляется при чтении.
// Ручная правка запоминается в manual_field_ids: пересчёт её не перетирает, пока сотрудник
// не очистит поле или не нажмёт «Считать автоматически».
import { calcValue, type Values } from '../../lib/register-values.js';
import { critKeyOf } from '../../lib/vuln-score.js';
import type { RegisterDef } from '../registers/definition.js';
import { isVulnRegister, optionByKey, vulnFields } from './definition.js';

export interface DeriveInput {
  before: Values;
  after: Values;
  /** Ручные поля записи до изменения. */
  manual: readonly string[];
  /** Поля, которые изменил человек (форма, импорт Excel). */
  edited: readonly string[];
  isNew: boolean;
}

export interface DeriveResult {
  values: Values;
  manualFieldIds: string[];
  /** Поля, изменённые пересчётом (для журнала). */
  derived: string[];
}

/** Критичность по текущим CVSS, эксплойту и исправлению. */
export function autoCritOption(reg: RegisterDef, values: Values): string {
  const vf = vulnFields(reg);
  const rule = vf.score.calcRule;
  const score = rule ? calcValue(rule, values, { fields: reg.fields }) : null;
  return optionByKey(vf.crit, critKeyOf(typeof score === 'number' ? score : null));
}

export function applyDerived(reg: RegisterDef, input: DeriveInput): DeriveResult {
  const manual = new Set(input.manual);
  if (!isVulnRegister(reg)) return { values: input.after, manualFieldIds: [...manual], derived: [] };
  const vf = vulnFields(reg);
  const values: Values = { ...input.after };
  const critId = vf.crit.id;
  const critEdited = input.edited.includes(critId);
  if (critEdited) {
    // Очистить критичность — вернуть автоматический расчёт; выбрать значение — зафиксировать вручную.
    if (values[critId] === undefined) manual.delete(critId);
    else manual.add(critId);
  }
  const inputsChanged = input.isNew || (critEdited && values[critId] === undefined)
    || [vf.cvss.id, vf.exploit.id, vf.fix.id].some((id) => input.edited.includes(id));
  const derived: string[] = [];
  if (!manual.has(critId) && inputsChanged) {
    const want = autoCritOption(reg, values);
    if (values[critId] !== want) derived.push(critId);
    values[critId] = want;
  }
  return { values, manualFieldIds: [...manual], derived };
}
