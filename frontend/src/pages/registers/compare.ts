// Сравнение с реестром (релиз 1.1.0): выбор статуса отсутствующим записям. Чистые функции.
import type { CompareStatusChange } from '../../api/registers';

/** Статус, выбранный в строке: id записи → id значения статуса ('' — не менять). */
export type Choices = ReadonlyMap<string, string>;

/** Один статус всем отмеченным строкам. */
export function setForPicked(choices: Choices, picked: ReadonlySet<string>, optionId: string): Map<string, string> {
  const next = new Map(choices);
  for (const id of picked) next.set(id, optionId);
  return next;
}

/** Что отправить на сервер: только строки, где статус выбран и отличается от текущего. */
export function changesOf(choices: Choices, current: ReadonlyMap<string, string | null>): CompareStatusChange[] {
  return [...choices].filter(([id, opt]) => opt && opt !== current.get(id)).map(([recordId, optionId]) => ({ recordId, optionId }));
}

/** «Нет в файле: 3 записи» и т. п. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
}
