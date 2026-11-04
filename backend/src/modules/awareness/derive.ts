// Производные значения и предупреждения импорта «Осведомлённости» (релиз 1.8.0, docs/specs/awareness.md, 2.1, 2.2, 3, 7.4).
// Хуки по systemKey, как «Экземпляр» компонента (assets/derive.ts): вызываются при любой записи — форма и импорт.
import type { Values } from '../../lib/register-values.js';
import type { RegisterDef } from '../registers/definition.js';
import { AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY, EMPLOYEE_STATUS } from './definition.js';
import { joinFio, splitFio } from './logic.js';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const byKey = (reg: RegisterDef, k: string) => reg.fields.find((f) => f.systemKey === k && !f.archived);
const optionId = (reg: RegisterDef, field: string, key: string) => byKey(reg, field)?.options.find((o) => o.systemKey === key && !o.archived)?.id;

/**
 * «Сотрудники»: ФИО делится на части, только если все части пустые (заполненные вручную не перетираются); пустое ФИО
 * собирается из частей; новая запись без статуса — «Работает». Возвращает id изменённых полей.
 */
function deriveEmployee(reg: RegisterDef, values: Values, isNew: boolean): string[] {
  const [full, last, first, middle, status] = ['fullName', 'lastName', 'firstName', 'middleName', 'status'].map((k) => byKey(reg, k));
  const out: string[] = [];
  if (full && last && first && middle) {
    const parts = { lastName: str(values[last.id]), firstName: str(values[first.id]), middleName: str(values[middle.id]) };
    const fio = str(values[full.id]);
    if (fio && !parts.lastName && !parts.firstName && !parts.middleName) {
      const split = splitFio(fio);
      if (split) {
        values[last.id] = split.lastName;
        values[first.id] = split.firstName;
        values[middle.id] = split.middleName;
        out.push(last.id, first.id, middle.id);
      }
    } else if (!fio && (parts.lastName || parts.firstName)) {
      values[full.id] = joinFio(parts);
      out.push(full.id);
    }
  }
  const working = optionId(reg, 'status', 'working');
  if (isNew && status && working && values[status.id] === undefined) {
    values[status.id] = working;
    out.push(status.id);
  }
  return out;
}

/**
 * «Результаты INDIGO»: «Сотрудника» поменяли, а «Сопоставление» — нет (правка в карточке) → «Вручную», очистили —
 * «Не сопоставлен». Импорт ставит оба поля сам — тогда хук ничего не меняет. «Подразделение» не трогается (раздел 3).
 */
function deriveResult(reg: RegisterDef, values: Values, edited: readonly string[]): string[] {
  const employee = byKey(reg, 'employee');
  const match = byKey(reg, 'match');
  if (!employee || !match || !edited.includes(employee.id) || edited.includes(match.id)) return [];
  const linked = Array.isArray(values[employee.id]) && (values[employee.id] as string[]).length > 0;
  const want = optionId(reg, 'match', linked ? 'manual' : 'none');
  if (!want || values[match.id] === want) return [];
  values[match.id] = want;
  return [match.id];
}

/**
 * Новая запись «Сотрудников» без ФИО, но с фамилией и именем — ФИО соберётся из частей (раздел 2.2): проверка
 * «заполните заголовок» такую запись пропускает.
 */
export function titleFromParts(reg: { systemKey: string | null; fields: { systemKey: string | null; archived: boolean; id: string }[] }, values: Values): boolean {
  if (reg.systemKey !== AWARENESS_EMPLOYEES_KEY) return false;
  const f = (k: string) => reg.fields.find((x) => x.systemKey === k && !x.archived);
  const last = f('lastName');
  const first = f('firstName');
  return !!last && !!first && !!str(values[last.id]) && !!str(values[first.id]);
}

export function deriveAwareness(reg: RegisterDef, values: Values, edited: readonly string[], isNew: boolean): string[] {
  if (reg.systemKey === AWARENESS_EMPLOYEES_KEY) return deriveEmployee(reg, values, isNew);
  if (reg.systemKey === AWARENESS_RESULTS_KEY) return deriveResult(reg, values, edited);
  return [];
}

export interface ImportRowView {
  row: number;
  /** Значения найденной записи; null — новая запись. */
  current: Values | null;
  /** Значения после строки файла (до производных). */
  merged: Values;
}

const LIST_MAX = 20;
const listOf = (items: string[]) => `${items.slice(0, LIST_MAX).join('; ')}${items.length > LIST_MAX ? ` и ещё ${items.length - LIST_MAX}` : ''}`;

/**
 * Предупреждения предпросмотра импорта «Сотрудников» (2.1, 2.2): ФИО не разделено на части; в файле есть уволенные,
 * а колонки «Статус» нет (статус не меняется — решение владельца 4).
 */
export function awarenessImportWarnings(reg: RegisterDef, rows: readonly ImportRowView[], fieldsInFile: ReadonlySet<string>): string[] {
  if (reg.systemKey !== AWARENESS_EMPLOYEES_KEY) return [];
  const [full, last, first, middle, status, tabNo] = ['fullName', 'lastName', 'firstName', 'middleName', 'status', 'tabNo'].map((k) => byKey(reg, k));
  const out: string[] = [];
  if (full && last && first && middle) {
    const unsplit = rows.filter((r) => {
      const fio = str(r.merged[full.id]);
      return fio && ![last, first, middle].some((f) => str(r.merged[f.id])) && !splitFio(fio);
    }).map((r) => `строка ${r.row}: «${str(r.merged[full.id])}»`);
    if (unsplit.length) out.push(`ФИО не разделено на фамилию, имя и отчество: ${unsplit.length} строк — ${listOf(unsplit)}`);
  }
  const fired = optionId(reg, 'status', 'fired');
  if (status && fired && !fieldsInFile.has(status.id)) {
    const back = rows.filter((r) => r.current && r.current[status.id] === fired)
      .map((r) => `${str(r.merged[full?.id ?? ''])}${tabNo ? ` (${str(r.merged[tabNo.id])})` : ''}`);
    if (back.length) out.push(`В файле есть уволенные: ${back.length} — проверьте статус (колонки «Статус» в файле нет, статус «${EMPLOYEE_STATUS.fired}» не меняется): ${listOf(back)}`);
  }
  return out;
}
