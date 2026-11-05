// Зависимости записи реестра (раздел 3.4): запись с ними физически не удаляется — только архив.
// Одно правило для одиночного и массового удаления (релиз 1.1.0).
//   locked    — зафиксированные статусом поля (запись хранится навсегда, этап 8б);
//   decisions — решения другого отдела;
//   evidence  — привязанные доказательства;
//   tasks     — открытые задачи по записи;
//   links     — ссылки из других неудалённых записей (поле «Связь с записью», например разрешение DLP → устройство);
//   letters   — запись «Рассылок», созданная отметкой «Отправлено» учебного письма (1.9.0).
import type { Db } from '../../lib/db.js';
import type { Values } from '../../lib/register-values.js';
import { recordLetterLinks } from '../awareness-letters/links.js';
import { recordLocks, type RegisterDef } from './definition.js';

export const DEPENDENCY_REASONS = ['locked', 'decisions', 'evidence', 'tasks', 'links', 'letters'] as const;
export type DependencyReason = (typeof DEPENDENCY_REASONS)[number];

export const DEPENDENCY_TEXT: Record<DependencyReason, string> = {
  locked: 'Запись с зафиксированными полями не удаляется: она хранится навсегда. Её можно отправить в архив',
  decisions: 'По записи есть решения другого отдела — её можно только отправить в архив',
  evidence: 'К записи привязаны доказательства — её можно только отправить в архив',
  tasks: 'По записи есть открытые задачи — сначала закройте или удалите задачи, либо отправьте запись в архив',
  links: 'На запись ссылаются записи других реестров — её можно только отправить в архив',
  letters: 'Запись связана с учебным письмом — её можно только отправить в архив',
};

/** Причины, по которым записи нельзя удалить: id → причины (записи без зависимостей в карте нет). */
export async function recordDependencies(
  db: Db, reg: RegisterDef, rows: readonly { id: string; values: unknown }[],
): Promise<Map<string, DependencyReason[]>> {
  const out = new Map<string, DependencyReason[]>();
  if (!rows.length) return out;
  const add = (id: string, reason: DependencyReason) => {
    const list = out.get(id) ?? [];
    if (!list.includes(reason)) list.push(reason);
    out.set(id, list);
  };
  for (const r of rows) if (recordLocks(reg, (r.values ?? {}) as Values).size) add(r.id, 'locked');
  const ids = rows.map((r) => r.id);

  const decisions = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT record_id::text AS id FROM register_decisions WHERE record_id = ANY(${ids}::uuid[])`;
  for (const r of decisions) add(r.id, 'decisions');

  const evidence = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT record_id::text AS id FROM evidence WHERE record_id = ANY(${ids}::uuid[]) AND deleted_at IS NULL`;
  for (const r of evidence) add(r.id, 'evidence');

  const tasks = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT record_id::text AS id FROM tasks
    WHERE record_id = ANY(${ids}::uuid[]) AND completed_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`;
  for (const r of tasks) add(r.id, 'tasks');

  for (const id of (await recordLetterLinks(db, ids)).keys()) add(id, 'letters');

  // Поля «Связь с записью» любых реестров (и архивных: значения в них живы), которые ссылаются на этот реестр.
  const linkFields = await db.registerField.findMany({
    where: { type: 'link', linkRegisterId: reg.id, deletedAt: null }, select: { id: true, registerId: true },
  });
  for (const f of linkFields) {
    const linked = await db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT x.id FROM register_records r
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r."values" -> ${f.id}) = 'array' THEN r."values" -> ${f.id} ELSE '[]'::jsonb END) AS x(id)
      WHERE r.register_id = ${f.registerId}::uuid AND r.deleted_at IS NULL AND x.id = ANY(${ids}::text[])`;
    for (const r of linked) add(r.id, 'links');
  }
  return out;
}
