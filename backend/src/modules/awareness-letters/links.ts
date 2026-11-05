// Связи учебных писем с задачами и записями реестров (1.9.0; замечание владельца 05.11.2026, п. 3).
// Задачу или запись «Рассылок», на которую ссылается письмо, его событие или запуск правила, удалить нельзя — 409
// «связана с учебным письмом № N»; отправить в архив можно. Удаление в портале мягкое (deleted_at), поэтому
// ON DELETE RESTRICT в БД — вторая линия: физического удаления задач и записей в коде нет.
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';

/**
 * Задачи модуля — source = 'manual' без автора (tasks_automation_check требует правило у 'automation'; вариант A,
 * решение владельца 05.11.2026). Их происхождение — только связи в таблицах модуля. Системные задачи не участвуют
 * в подсказках цепочек и в «Найти среди старых» (1.7.0): одно условие — для Prisma и для SQL (алиас задачи t).
 */
export const notLetterTaskWhere: Prisma.TaskWhereInput = {
  awarenessLetters: { none: {} }, awarenessEvents: { none: {} }, awarenessRun: { is: null },
};
export const NOT_LETTER_TASK_SQL = Prisma.sql`NOT EXISTS (SELECT 1 FROM awareness_letters al WHERE al.task_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM awareness_letter_events ae WHERE ae.task_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM awareness_schedule_runs ar WHERE ar.task_id = t.id)`;

export type LetterLink = { kind: 'letter'; number: number } | { kind: 'rule'; title: string };

/** Почему задачи нельзя удалить: id задачи → письмо (по задаче письма, задаче доработки или запуску) или правило. */
export async function taskLetterLinks(db: Db, taskIds: readonly string[]): Promise<Map<string, LetterLink>> {
  const out = new Map<string, LetterLink>();
  if (!taskIds.length) return out;
  const rows = await db.$queryRaw<{ task_id: string; number: number | null; rule: string | null }[]>`
    SELECT x.task_id::text, min(l.number) AS number, min(r.title) AS rule FROM (
      SELECT task_id, id AS letter_id, NULL::uuid AS rule_id FROM awareness_letters WHERE task_id = ANY(${taskIds}::uuid[])
      UNION ALL
      SELECT task_id, letter_id, NULL FROM awareness_letter_events WHERE task_id = ANY(${taskIds}::uuid[])
      UNION ALL
      SELECT task_id, letter_id, rule_id FROM awareness_schedule_runs WHERE task_id = ANY(${taskIds}::uuid[])
    ) x
    LEFT JOIN awareness_letters l ON l.id = x.letter_id
    LEFT JOIN awareness_schedule_rules r ON r.id = x.rule_id
    GROUP BY x.task_id`;
  for (const r of rows) {
    out.set(r.task_id, r.number !== null ? { kind: 'letter', number: Number(r.number) } : { kind: 'rule', title: r.rule ?? '' });
  }
  return out;
}

/** Записи реестра, созданные отметкой «Отправлено»: id записи → номер письма. */
export async function recordLetterLinks(db: Db, recordIds: readonly string[]): Promise<Map<string, number>> {
  if (!recordIds.length) return new Map();
  const rows = await db.$queryRaw<{ record_id: string; number: number }[]>`
    SELECT e.record_id::text, min(l.number) AS number
    FROM awareness_letter_events e JOIN awareness_letters l ON l.id = e.letter_id
    WHERE e.record_id = ANY(${recordIds}::uuid[]) GROUP BY e.record_id`;
  return new Map(rows.map((r) => [r.record_id, Number(r.number)]));
}

export function taskLinkMessage(taskNumber: number, link: LetterLink): string {
  return link.kind === 'letter'
    ? `Задача #${taskNumber} связана с учебным письмом № ${link.number} — её нельзя удалить, можно отправить в архив`
    : `Задача #${taskNumber} создана правилом расписания «${link.title}» — её нельзя удалить, можно отправить в архив`;
}

export function recordLinkMessage(recordNumber: number, letterNumber: number): string {
  return `Запись #${recordNumber} связана с учебным письмом № ${letterNumber} — её нельзя удалить, можно отправить в архив`;
}
