// Системные реестры «Осведомлённости» (релиз 1.8.0, docs/specs/awareness.md, разделы 2 и 3): «Сотрудники» из выгрузки HR
// и «Результаты INDIGO». Поля находят по ключу (systemKey), не по названию: переименовать можно, удалить и
// архивировать нельзя. Значения списков, на которые опирается код, — тоже по ключу.
import { GRADE_LABELS, GRADES } from './logic.js';

export const AWARENESS_EMPLOYEES_KEY = 'awareness_employees';
export const AWARENESS_RESULTS_KEY = 'awareness_results';

export interface AwarenessFieldSpec {
  key: string;
  label: string;
  type: 'text' | 'select' | 'date' | 'number' | 'link' | 'user';
  isTitle?: boolean;
  isStatus?: boolean;
  isImportKey?: boolean;
  analyticsRole?: 'dimension' | 'metric' | 'date';
  /** Реестр связи по ключу. */
  link?: string;
  hint?: string;
  options?: { label: string; key: string; closed?: boolean }[];
}

/** Статус сотрудника: «Уволен» закрывает запись — уволенные не сопоставляются и не попадают в «Нет в файле» повторно. */
export const EMPLOYEE_STATUS = { working: 'Работает', fired: 'Уволен' } as const;
export const MATCH = { exact: 'Точно', manual: 'Вручную', none: 'Не сопоставлен' } as const;
export const RETAKE = { yes: 'Да', no: 'Нет' } as const;

export const EMPLOYEE_FIELDS: AwarenessFieldSpec[] = [
  { key: 'tabNo', label: 'Табельный номер', type: 'text', isImportKey: true },
  { key: 'fullName', label: 'ФИО', type: 'text', isTitle: true, hint: 'Пустые фамилия, имя и отчество заполняются делением ФИО по пробелам' },
  { key: 'lastName', label: 'Фамилия', type: 'text' },
  { key: 'firstName', label: 'Имя', type: 'text' },
  { key: 'middleName', label: 'Отчество', type: 'text' },
  { key: 'dept', label: 'Подразделение', type: 'text', analyticsRole: 'dimension' },
  { key: 'position', label: 'Должность', type: 'text' },
  { key: 'email', label: 'Email', type: 'text', hint: 'Только для справки: писем портал не отправляет' },
  {
    key: 'status', label: 'Статус', type: 'select', isStatus: true, analyticsRole: 'dimension',
    options: [{ label: EMPLOYEE_STATUS.working, key: 'working' }, { label: EMPLOYEE_STATUS.fired, key: 'fired', closed: true }],
  },
];

export const RESULT_FIELDS: AwarenessFieldSpec[] = [
  { key: 'attemptKey', label: 'Ключ попытки', type: 'text', isImportKey: true, hint: 'Тест, ФИО и дата теста — ставит импорт отчёта INDIGO' },
  { key: 'fullName', label: 'ФИО', type: 'text', isTitle: true },
  { key: 'test', label: 'Тест', type: 'text' },
  { key: 'employee', label: 'Сотрудник', type: 'link', link: AWARENESS_EMPLOYEES_KEY },
  { key: 'dept', label: 'Подразделение', type: 'text', analyticsRole: 'dimension' },
  { key: 'indigoGroup', label: 'Группа INDIGO', type: 'text' },
  { key: 'date', label: 'Дата теста', type: 'date', analyticsRole: 'date' },
  { key: 'spent', label: 'Затраченное время', type: 'text' },
  { key: 'score', label: 'Балл', type: 'number' },
  { key: 'maxScore', label: 'Макс. балл', type: 'number' },
  { key: 'percent', label: 'Результат, %', type: 'number', analyticsRole: 'metric' },
  { key: 'regularPct', label: 'Обычные вопросы, %', type: 'number' },
  { key: 'multiPct', label: 'Мультивыбор, %', type: 'number' },
  { key: 'grade', label: 'Оценка', type: 'select', analyticsRole: 'dimension', options: GRADES.map((g) => ({ label: GRADE_LABELS[g], key: g })) },
  { key: 'retake', label: 'На пересдачу', type: 'select', analyticsRole: 'dimension', options: [{ label: RETAKE.yes, key: 'yes' }, { label: RETAKE.no, key: 'no' }] },
  {
    key: 'match', label: 'Сопоставление', type: 'select', analyticsRole: 'dimension',
    options: [{ label: MATCH.exact, key: 'exact' }, { label: MATCH.manual, key: 'manual' }, { label: MATCH.none, key: 'none' }],
  },
];

/**
 * Служебные поля «Результатов» (раздел 3): ставят только адаптер INDIGO и «Обновить по сотрудникам»; форма и обратный
 * импорт Excel их не меняют (409 AWARENESS_SERVICE_FIELD). «Сотрудник» правится в карточке.
 */
export const AWARENESS_MANAGED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [AWARENESS_RESULTS_KEY]: RESULT_FIELDS.map((f) => f.key).filter((k) => k !== 'employee'),
};
