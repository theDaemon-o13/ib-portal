// Форма «Добавить ответственных лиц» (1.13.5): сборка пачки из выбранных в справочнике и строк ручного ввода, ошибки
// строк до отправки. Правило «тот же человек» — personKey (ФИО + подразделение или должность, без регистра и лишних
// пробелов), как на сервере. Порядок пачки — сначала выбранные, затем ручные строки: номер строки в ошибке сервера
// («Строка N») совпадает с этим порядком.
import { personKey } from './logic';

/** Не больше стольких за раз — как PARTIES_BATCH_MAX на сервере. */
export const BATCH_MAX = 50;

export interface PickedPerson { id: string; fullName: string; position: string; email?: string }
export interface ManualRow { key: string; fullName: string; department: string; email?: string }
/** Почта (1.13.6) — текстом из справочника или ручной строки; пусто — не отправляется. */
export interface BatchPerson { fullName: string; department: string; email?: string }

export interface Batch {
  people: BatchPerson[];
  /** Ошибки ручных строк по key: пусто — строка годится. */
  rowErrors: Record<string, string>;
  /** Можно отправлять: есть люди, нет ошибок строк, не больше лимита. */
  ok: boolean;
}

const isBlank = (r: ManualRow) => !r.fullName.trim() && !r.department.trim() && !(r.email ?? '').trim();
/** Формат почты — как на сервере (lib/email.ts); окончательно проверяет сервер (400 BAD_EMAIL). */
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const emailOk = (v: string) => { const e = v.trim(); return !e || (e.length <= 254 && EMAIL_RE.test(e)); };
const withEmail = (p: { fullName: string; department: string }, email: string | undefined) => {
  const e = (email ?? '').trim().toLowerCase();
  return e ? { ...p, email: e } : p;
};

/**
 * Пачка для отправки. taken — ключи уже добавленных в документ. Пустая ручная строка (ни ФИО, ни должности)
 * не считается; с должностью без ФИО — ошибка. Повтор с документом или внутри формы — ошибка строки.
 */
export function buildBatch(picked: readonly PickedPerson[], manual: readonly ManualRow[], taken: ReadonlySet<string>): Batch {
  const people: BatchPerson[] = [];
  const rowErrors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const p of picked) {
    const key = personKey(p.fullName, p.position);
    if (seen.has(key) || taken.has(key)) continue;
    seen.add(key);
    people.push(withEmail({ fullName: p.fullName, department: p.position }, p.email));
  }
  for (const r of manual) {
    if (isBlank(r)) continue;
    if (!r.fullName.trim()) { rowErrors[r.key] = 'Укажите ФИО'; continue; }
    if (!emailOk(r.email ?? '')) { rowErrors[r.key] = 'Почта — в виде ivanov@example.com'; continue; }
    const key = personKey(r.fullName, r.department);
    if (taken.has(key)) { rowErrors[r.key] = 'Уже добавлен(а) в документ'; continue; }
    if (seen.has(key)) { rowErrors[r.key] = 'Уже есть в списке выше'; continue; }
    seen.add(key);
    people.push(withEmail({ fullName: r.fullName.trim().replace(/\s+/g, ' '), department: r.department.trim().replace(/\s+/g, ' ') }, r.email));
  }
  const ok = people.length > 0 && people.length <= BATCH_MAX && Object.keys(rowErrors).length === 0;
  return { people, rowErrors, ok };
}

/** Число на кнопке: «Добавить (3)». */
export const addLabel = (n: number) => (n ? `Добавить (${n})` : 'Добавить');
