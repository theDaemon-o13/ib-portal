// Системный «Реестр уязвимостей» (этап 4): поля и значения по системным ключам.
// Одно описание для seed (создание) и сервисов (поиск полей по ключу, а не по названию:
// администратор может переименовать поле или значение, формулы и импорт продолжат работать).
import { conflict } from '../../lib/errors.js';
import { CRIT_KEYS, DUE_DAYS, type CritKey } from '../../lib/vuln-score.js';
import type { FieldMeta, RegisterDef } from '../registers/definition.js';

export const VULN_REGISTER_KEY = 'vulns';

export type VulnFieldKey =
  | 'cve' | 'pkg' | 'level' | 'cvss' | 'exploit' | 'vector' | 'fix' | 'fixVersion' | 'desc' | 'hits'
  | 'report' | 'notified' | 'score' | 'crit' | 'due' | 'status' | 'comment' | 'measures' | 'newDue' | 'owner';

export interface VulnOptionSpec {
  label: string;
  key?: string;
  closed?: boolean;
}

export interface VulnFieldSpec {
  key: VulnFieldKey;
  label: string;
  type: 'text' | 'select' | 'number' | 'date' | 'user' | 'calc';
  isTitle?: boolean;
  isStatus?: boolean;
  analyticsRole?: 'dimension' | 'metric' | 'date' | 'deadline';
  options?: VulnOptionSpec[];
}

export const CRIT_LABELS: Record<CritKey, string> = {
  critical: 'Критическая', high: 'Высокая', medium: 'Средняя', low: 'Низкая',
};

/** Поля в порядке прототипа. Правила вычисляемых полей собирает seed по ключам. */
export const VULN_FIELDS: VulnFieldSpec[] = [
  { key: 'cve', label: 'CVE / БДУ', type: 'text', isTitle: true },
  { key: 'pkg', label: 'Пакет', type: 'select', analyticsRole: 'dimension', options: [] },
  { key: 'level', label: 'Уровень (сканер)', type: 'select', options: [{ label: 'Критическая' }, { label: 'Важная' }, { label: 'Средняя' }, { label: 'Низкая' }] },
  { key: 'cvss', label: 'CVSS', type: 'number', analyticsRole: 'metric' },
  {
    key: 'exploit', label: 'Эксплойт', type: 'select', analyticsRole: 'dimension',
    options: [
      { label: 'Есть, эксплуатируется', key: 'exploited' },
      { label: 'Есть', key: 'exists' },
      { label: 'Нет', key: 'none' },
      { label: 'Нет данных', key: 'nodata' },
    ],
  },
  {
    key: 'vector', label: 'Сетевой вектор', type: 'select', analyticsRole: 'dimension',
    options: [{ label: 'Удалённо (сеть)', key: 'remote' }, { label: 'Локально', key: 'local' }],
  },
  {
    key: 'fix', label: 'Исправление', type: 'select', analyticsRole: 'dimension',
    options: [{ label: 'Выпущено', key: 'released' }, { label: 'Не выпущено', key: 'not_released' }],
  },
  { key: 'fixVersion', label: 'Обновить до версии', type: 'text' },
  { key: 'desc', label: 'Краткое описание', type: 'text' },
  { key: 'hits', label: 'Обнаружений', type: 'number', analyticsRole: 'metric' },
  { key: 'report', label: 'Отчёт сканирования', type: 'select', analyticsRole: 'dimension', options: [] },
  { key: 'notified', label: 'Уведомлено ДИКТ', type: 'date', analyticsRole: 'date' },
  { key: 'score', label: 'Оценка', type: 'calc' },
  {
    key: 'crit', label: 'Критичность', type: 'select', analyticsRole: 'dimension',
    options: CRIT_KEYS.map((k) => ({ label: CRIT_LABELS[k], key: k })),
  },
  { key: 'due', label: 'Срок устранения', type: 'calc', analyticsRole: 'deadline' },
  {
    key: 'status', label: 'Статус', type: 'select', isStatus: true, analyticsRole: 'dimension',
    options: [
      { label: 'Открыта', key: 'open' },
      { label: 'В работе', key: 'in_progress' },
      { label: 'Устранена', key: 'fixed', closed: true },
      { label: 'Риск принят', key: 'accepted', closed: true },
    ],
  },
  { key: 'comment', label: 'Комментарий ДИКТ', type: 'text' },
  { key: 'measures', label: 'Компенсирующие меры', type: 'text' },
  { key: 'newDue', label: 'Срок после пересмотра ИБ', type: 'date' },
  { key: 'owner', label: 'Ответственный', type: 'user', analyticsRole: 'dimension' },
];

export { DUE_DAYS };

export type VulnFields = Record<VulnFieldKey, FieldMeta>;

export function isVulnRegister(reg: Pick<RegisterDef, 'systemKey'>): boolean {
  return reg.systemKey === VULN_REGISTER_KEY;
}

/** Системные поля реестра уязвимостей по ключам. Если поля нет — структура повреждена. */
export function vulnFields(reg: RegisterDef): VulnFields {
  const out: Partial<VulnFields> = {};
  for (const spec of VULN_FIELDS) {
    const f = reg.fields.find((x) => x.systemKey === spec.key);
    if (!f) throw conflict('VULN_STRUCTURE', `В реестре уязвимостей нет системного поля «${spec.label}». Обратитесь к администратору портала`);
    out[spec.key] = f;
  }
  return out as VulnFields;
}

/** Значение системного списка по ключу. */
export function optionByKey(field: FieldMeta, key: string): string {
  const o = field.options.find((x) => x.systemKey === key);
  if (!o) throw conflict('VULN_STRUCTURE', `В поле «${field.label}» нет системного значения «${key}»`);
  return o.id;
}
