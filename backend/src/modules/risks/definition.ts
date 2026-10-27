// Системный «Реестр рисков ИБ» (этап 7): отдельно от рисков банка, связь с реестром ОУР — по номеру.
// Решение выносит ОУР; ИБ фиксирует его только с документом ОУР (поле «Решение ОУР» — решение другого отдела).
// Внесение решения заполняет системные поля «№ в реестре ОУР» и «Пересмотр до» — их находят по ключу, не по названию.
import type { RegisterDef } from '../registers/definition.js';

export const RISK_REGISTER_KEY = 'risks';

export type RiskFieldKey = 'title' | 'asset' | 'level' | 'ibStatus' | 'ormRef' | 'decision' | 'reviewDue' | 'owner';

export interface RiskFieldSpec {
  key: RiskFieldKey;
  label: string;
  type: 'text' | 'select' | 'date' | 'user' | 'catalog' | 'decision';
  /** Системное поле: на него опирается внесение решения ОУР. Остальные правятся как обычные. */
  system?: boolean;
  catalogCode?: string;
  isTitle?: boolean;
  analyticsRole?: 'dimension' | 'deadline';
  options?: string[];
}

/** Поля в порядке прототипа. */
export const RISK_FIELDS: RiskFieldSpec[] = [
  { key: 'title', label: 'Риск ИБ', type: 'text', isTitle: true },
  { key: 'asset', label: 'Актив / система', type: 'catalog', catalogCode: 'systems', analyticsRole: 'dimension' },
  { key: 'level', label: 'Уровень (оценка ИБ)', type: 'select', analyticsRole: 'dimension', options: ['Высокий', 'Средний', 'Низкий'] },
  { key: 'ibStatus', label: 'Статус ИБ', type: 'select', options: ['Идентифицирован', 'Оценён', 'Передан в ОУР'] },
  { key: 'ormRef', label: '№ в реестре ОУР', type: 'text', system: true },
  {
    key: 'decision', label: 'Решение ОУР', type: 'decision', system: true, analyticsRole: 'dimension',
    options: ['Ожидает решения', 'Принят', 'Снижение', 'Передача', 'Отклонён'],
  },
  { key: 'reviewDue', label: 'Пересмотр до', type: 'date', system: true, analyticsRole: 'deadline' },
  { key: 'owner', label: 'Владелец риска', type: 'user' },
];

export function isRiskRegister(reg: Pick<RegisterDef, 'systemKey'>): boolean {
  return reg.systemKey === RISK_REGISTER_KEY;
}

/** Системные поля реестра рисков по ключу; поле могли переименовать, но не удалить. */
export function riskField(reg: RegisterDef, key: RiskFieldKey) {
  return reg.fields.find((f) => f.systemKey === key && !f.archived) ?? null;
}
