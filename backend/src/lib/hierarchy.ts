// Иерархия пользователей (релиз 1.2.0, ADR-0020): у пользователя один руководитель (users.manager_id),
// «старшие» — вся цепочка руководителей выше. Цикл запрещён триггером users_manager_no_cycle и проверкой в users.
import type { Db } from './db.js';

/** Предел глубины, как в триггере: защищает запрос, даже если данные повреждены. */
const MAX_DEPTH = 100;

/** Старшие над пользователем: руководитель, его руководитель и так далее (ближний первым). Сам пользователь не входит. */
export async function seniorIdsOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE up(id, depth) AS (
      SELECT manager_id, 1 FROM users WHERE id = ${userId}::uuid AND manager_id IS NOT NULL
      UNION ALL
      SELECT u.manager_id, up.depth + 1 FROM users u JOIN up ON u.id = up.id
      WHERE u.manager_id IS NOT NULL AND up.depth < ${MAX_DEPTH}
    )
    SELECT id::text FROM up ORDER BY depth`;
  return rows.map((r) => r.id);
}

/** Подчинённые на всех уровнях ниже пользователя. */
export async function subordinateIdsOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE down(id, depth) AS (
      SELECT id, 1 FROM users WHERE manager_id = ${userId}::uuid
      UNION ALL
      SELECT u.id, down.depth + 1 FROM users u JOIN down ON u.manager_id = down.id
      WHERE down.depth < ${MAX_DEPTH}
    )
    SELECT id::text FROM down ORDER BY depth`;
  return rows.map((r) => r.id);
}

/** senior — старший над user (выше по цепочке руководителей). Сам себе не старший. */
export async function isSeniorOf(db: Db, seniorId: string, userId: string): Promise<boolean> {
  if (seniorId === userId) return false;
  return (await seniorIdsOf(db, userId)).includes(seniorId);
}
