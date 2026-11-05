// Реестр «Рассылки» (1.9.0; docs/specs/awareness.md, раздел 18): запись при «Отметить отправленным» — обычным созданием
// записи (createRecord, via: awareness_letter) в транзакции отметки; повторная отметка — новая запись.
// «Письмо» — текст «№ N, версия V» (у одноязычного срочного — «, только RU/TJ»); ссылкой на карточку письма он
// становится только у существующего письма и версии (letterRefs). Ручной ввод и импорт истории — просто текст.
import type { Db } from '../../lib/db.js';
import { workUsersWhere } from '../../lib/work-users.js';
import { loadRegister } from '../registers/definition.js';
import { createRecord } from '../registers/records.service.js';
import type { Actor } from '../settings/common.js';
import { AWARENESS_MAILINGS_KEY } from './definition.js';
import { LANG_MARK_TEXT, type LangMark, type LetterKind } from './flow.js';

/** «№ 12, версия 3» или «№ 12, версия 3, только RU». */
export function letterRef(number: number, versionNo: number, mark: LangMark): string {
  return `№ ${number}, версия ${versionNo}${mark ? `, ${LANG_MARK_TEXT[mark]}` : ''}`;
}

const REF_RE = /^\s*№\s*(\d{1,9}),\s*версия\s*(\d{1,6})(?:,\s*только\s+(?:RU|TJ))?\s*$/i;

/** Разобрать «Письмо» из записи: номер и версия; иное (ручной ввод, история) — null. */
export function parseLetterRef(text: string): { number: number; versionNo: number } | null {
  const m = REF_RE.exec(text);
  return m ? { number: Number(m[1]), versionNo: Number(m[2]) } : null;
}

/** Существующие письма по номерам: id и последняя версия — чтобы показать «Письмо» ссылкой только на то, что есть. */
export async function letterRefs(db: Db, numbers: readonly number[]) {
  const nums = [...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0 && n <= 2_147_483_647))];
  if (!nums.length) return { items: [] };
  const rows = await db.awarenessLetter.findMany({
    where: { number: { in: nums } },
    select: { id: true, number: true, versions: { select: { no: true }, orderBy: { no: 'desc' }, take: 1 } },
  });
  return { items: rows.map((r) => ({ number: r.number, id: r.id, lastVersionNo: r.versions[0]?.no ?? 0 })) };
}

/** Тема записи: тема отправленного языка; оба языка — «RU / TJ». */
export function mailingSubject(subjects: { ru: string; tj: string }, mark: LangMark): string {
  if (mark === 'only_ru') return subjects.ru.trim();
  if (mark === 'only_tj') return subjects.tj.trim();
  return [subjects.ru.trim(), subjects.tj.trim()].filter(Boolean).join(' / ');
}

export interface MailingInput {
  letter: { number: number; kind: LetterKind; reason: string; createdBy: string; taskId: string | null };
  versionNo: number;
  langMark: LangMark;
  subjects: { ru: string; tj: string };
  sentOn: string;
  audience: string;
}

/**
 * Запись «Рассылок» при отметке «Отправлено». Реестра нет, он в архиве или удалён — записи нет (null): отметка
 * не блокируется, событие остаётся без записи. Поле в архиве или удалено — его значение не ставится.
 */
export async function createMailingRecord(tx: Db, actor: Actor, input: MailingInput): Promise<{ id: string; number: number } | null> {
  const reg = await tx.register.findUnique({ where: { systemKey: AWARENESS_MAILINGS_KEY }, select: { id: true, archivedAt: true, deletedAt: true } });
  if (!reg || reg.archivedAt || reg.deletedAt) return null;
  const def = await loadRegister(tx, reg.id);
  const field = (key: string) => def.fields.find((f) => f.systemKey === key && !f.archived);
  const values: Record<string, unknown> = {};
  const put = (key: string, v: unknown) => {
    const f = field(key);
    if (f && v !== null && v !== undefined && v !== '') values[f.id] = v;
  };
  put('sentOn', input.sentOn);
  put('letter', letterRef(input.letter.number, input.versionNo, input.langMark));
  put('subject', mailingSubject(input.subjects, input.langMark));
  put('kind', field('kind')?.options.find((o) => o.systemKey === input.letter.kind && !o.archived)?.id);
  put('reason', input.letter.reason);
  put('audience', input.audience);
  const author = await tx.user.findFirst({ where: { AND: [{ id: input.letter.createdBy }, workUsersWhere()] }, select: { id: true } });
  put('preparedBy', author?.id);
  if (input.letter.taskId) {
    const task = await tx.task.findUnique({ where: { id: input.letter.taskId }, select: { number: true, deletedAt: true } });
    if (task && !task.deletedAt) put('task', `Задача #${task.number}`);
  }
  const rec = await createRecord(tx, actor, reg.id, { values }, { via: 'awareness_letter', letterNumber: input.letter.number });
  return { id: rec.id, number: rec.number };
}
