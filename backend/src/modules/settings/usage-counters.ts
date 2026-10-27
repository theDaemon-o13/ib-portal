// Ссылки на значения справочников из задач, реестров и правил автоматизаций (CLAUDE.md, раздел 6:
// используемое значение не удаляется, только уходит в архив). Только SQL: модулю справочников
// не нужно импортировать задачи и реестры.
import { RECIPIENTS_CATALOG } from '../../lib/catalogs.js';
import type { Db } from '../../lib/db.js';
import { catalogItemUsage } from './usage.js';

const add = (m: Map<string, number>, id: string, n: number) => m.set(id, (m.get(id) ?? 0) + n);

catalogItemUsage.register('tasks', async (db: Db, ids) => {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await db.$queryRaw<{ id: string; n: bigint }[]>`
    SELECT id::text, count(*) AS n FROM (
      SELECT status_id AS id FROM tasks WHERE deleted_at IS NULL
      UNION ALL SELECT priority_id FROM tasks WHERE deleted_at IS NULL
      UNION ALL SELECT category_id FROM tasks WHERE deleted_at IS NULL
      UNION ALL SELECT m.mail_rule_id FROM task_mail_sources m JOIN tasks t ON t.id = m.task_id
        WHERE t.deleted_at IS NULL AND m.mail_rule_id IS NOT NULL
    ) x WHERE id::text = ANY(${[...ids]}::text[]) GROUP BY id`;
  for (const r of rows) add(out, r.id, Number(r.n));
  return out;
});

/** Записи реестров с полем «Значение справочника», которые ссылаются на значение. */
catalogItemUsage.register('register_records', async (db: Db, ids) => {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await db.$queryRaw<{ id: string; n: bigint }[]>`
    SELECT r."values" ->> f.id::text AS id, count(*) AS n
    FROM register_fields f JOIN register_records r ON r.register_id = f.register_id
    WHERE f.type = 'catalog' AND f.deleted_at IS NULL AND r.deleted_at IS NULL
      AND r."values" ->> f.id::text = ANY(${[...ids]}::text[])
    GROUP BY 1`;
  for (const r of rows) add(out, r.id, Number(r.n));
  return out;
});

/** Метка «Получатели уведомлений» в правилах автоматизаций: по id (до привязки — по названию). */
catalogItemUsage.register('automation_labels', async (db: Db, ids) => {
  const out = new Map<string, number>();
  const items = await db.catalogItem.findMany({ where: { id: { in: [...ids] }, catalogCode: RECIPIENTS_CATALOG }, select: { id: true, value: true } });
  if (!items.length) return out;
  const rules = await db.registerAutomation.findMany({ where: { deletedAt: null }, select: { action: true } });
  for (const item of items) {
    const n = rules.filter((r) => ((r.action as { recipients?: { kind: string; label?: string; itemId?: string | null }[] }).recipients ?? [])
      .some((x) => x.kind === 'label' && (x.itemId ? x.itemId === item.id : x.label?.toLowerCase() === item.value.toLowerCase()))).length;
    if (n) add(out, item.id, n);
  }
  return out;
});
