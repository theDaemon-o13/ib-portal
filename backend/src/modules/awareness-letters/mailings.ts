// Реестр «Рассылки» (1.9.0; docs/specs/awareness.md, раздел 18): запись при «Отметить отправленным» — обычным созданием
// записи (createRecord, via: awareness_letter) в транзакции отметки; повторная отметка — новая запись.
// «Письмо» — текст «№ N, версия V» (у одноязычного срочного — «, только RU/TJ»); ссылкой на карточку письма он
// становится только у существующего письма и версии (letterRefs). Ручной ввод и импорт истории — просто текст.
import type { Db } from '../../lib/db.js';
import { workUsersWhere } from '../../lib/work-users.js';
import { loadRegister } from '../registers/definition.js';
import { createRecord } from '../registers/records.service.js';
import type { Actor } from '../settings/common.js';
import { AWARENESS_MAILINGS_KEY, type MailingApproval } from './definition.js';
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

/** Версии, которые пишет человек (как у самосогласования): ручное создание, правка, восстановление. */
const AUTHORED = ['created', 'edit', 'restore'];

/**
 * «Подготовил» — по фактическому участию: исполнитель задачи письма → автор последней версии, написанной человеком →
 * автор письма. Берётся первый, кто есть по порядку; если он сейчас не участвует в работе — пусто.
 */
export async function preparedBy(tx: Db, letter: { id: string; createdBy: string; taskId: string | null }): Promise<string | null> {
  const assignee = letter.taskId ? (await tx.task.findUnique({ where: { id: letter.taskId }, select: { assigneeId: true, deletedAt: true } })) : null;
  let who: string | null = assignee && !assignee.deletedAt ? assignee.assigneeId : null;
  if (!who) {
    const v = await tx.awarenessLetterVersion.findFirst({ where: { letterId: letter.id, reason: { in: AUTHORED } }, orderBy: { no: 'desc' }, select: { createdBy: true } });
    who = v?.createdBy ?? letter.createdBy;
  }
  const working = await tx.user.findFirst({ where: { AND: [{ id: who }, workUsersWhere()] }, select: { id: true } });
  return working?.id ?? null;
}

/** «Согласование» записи: без согласования (срочное), без независимого (самосогласование) или согласовано. */
export async function approvalOf(tx: Db, letter: { id: string; approvedVersionId: string | null }, withoutApproval: boolean): Promise<MailingApproval> {
  if (withoutApproval) return 'none';
  const first = await tx.awarenessLetterEvent.findFirst({ where: { letterId: letter.id, action: 'sent' }, orderBy: { at: 'asc' }, select: { withoutApproval: true } });
  if (first?.withoutApproval) return 'none';
  if (!letter.approvedVersionId) return 'none';
  const approved = await tx.awarenessLetterEvent.findFirst({
    where: { letterId: letter.id, action: 'approved', versionId: letter.approvedVersionId }, orderBy: { at: 'desc' }, select: { selfApproved: true },
  });
  return approved?.selfApproved ? 'self' : 'approved';
}

export interface MailingInput {
  letter: { id: string; number: number; kind: LetterKind; reason: string; createdBy: string; taskId: string | null; approvedVersionId: string | null };
  /** Отметка без согласования (срочное): «Согласование» — «Без согласования». */
  withoutApproval: boolean;
  versionNo: number;
  langMark: LangMark;
  subjects: { ru: string; tj: string };
  sentOn: string;
  audience: string;
}

/** Почему записи «Рассылок» нет: интерфейс показывает предупреждение. */
export const MAILING_SKIPPED = {
  missing: 'Запись в «Рассылках» не создана: реестра «Рассылки» нет',
  archived: 'Запись в «Рассылках» не создана: реестр в архиве',
  deleted: 'Запись в «Рассылках» не создана: реестр удалён',
} as const;

/**
 * Запись «Рассылок» при отметке «Отправлено». Реестра нет, он в архиве или удалён — записи нет, отметка не
 * блокируется: возвращается причина (предупреждение в ответе API). Поле в архиве или удалено — значение не ставится.
 */
export async function createMailingRecord(tx: Db, actor: Actor, input: MailingInput): Promise<{ record: { id: string; number: number } | null; warning: string | null }> {
  const reg = await tx.register.findUnique({ where: { systemKey: AWARENESS_MAILINGS_KEY }, select: { id: true, archivedAt: true, deletedAt: true } });
  if (!reg) return { record: null, warning: MAILING_SKIPPED.missing };
  if (reg.deletedAt) return { record: null, warning: MAILING_SKIPPED.deleted };
  if (reg.archivedAt) return { record: null, warning: MAILING_SKIPPED.archived };
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
  put('preparedBy', await preparedBy(tx, input.letter));
  const approval = await approvalOf(tx, input.letter, input.withoutApproval);
  put('approval', field('approval')?.options.find((o) => o.systemKey === approval && !o.archived)?.id);
  if (input.letter.taskId) {
    const task = await tx.task.findUnique({ where: { id: input.letter.taskId }, select: { number: true, deletedAt: true } });
    if (task && !task.deletedAt) put('task', `Задача #${task.number}`);
  }
  const rec = await createRecord(tx, actor, reg.id, { values }, { via: 'awareness_letter', letterNumber: input.letter.number });
  return { record: { id: rec.id, number: rec.number }, warning: null };
}
