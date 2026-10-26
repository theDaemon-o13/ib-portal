// Предпросмотр «Попадёт на дашборд»: виджеты по полям с ролью для аналитики (как в прототипе).
// Считается в БД по неудалённым и неархивным записям.
import type { Db } from '../../lib/db.js';
import { loadRegister } from './definition.js';

export interface Widget {
  fieldId: string;
  label: string;
  role: string;
  kind: 'distribution' | 'metric' | 'timeline' | 'deadline';
  rows: { label: string; count: number }[];
  empty: number;
  avg: number | null;
  max: number | null;
  filled: number;
}

export async function registerAnalytics(db: Db, registerId: string): Promise<Widget[]> {
  const reg = await loadRegister(db, registerId);
  const total = await db.registerRecord.count({ where: { registerId, deletedAt: null, archivedAt: null } });
  const out: Widget[] = [];
  for (const f of reg.fields.filter((x) => !x.archived && x.analyticsRole)) {
    const w: Widget = { fieldId: f.id, label: f.label, role: f.analyticsRole as string, kind: 'distribution', rows: [], empty: 0, avg: null, max: null, filled: 0 };
    if (f.analyticsRole === 'dimension') {
      let counts: { key: string | null; n: bigint }[];
      if (f.type === 'decision') {
        // Последнее решение по каждой записи; без решения — первый вариант («ожидает решения»).
        counts = await db.$queryRaw`
          SELECT d.option_id::text AS key, count(*) AS n FROM (
            SELECT DISTINCT ON (dd.record_id) dd.record_id, dd.option_id
            FROM register_decisions dd JOIN register_records r ON r.id = dd.record_id
            WHERE dd.field_id = ${f.id}::uuid AND r.deleted_at IS NULL AND r.archived_at IS NULL
            ORDER BY dd.record_id, dd.decided_at DESC
          ) d GROUP BY d.option_id`;
        const decided = counts.reduce((s, c) => s + Number(c.n), 0);
        const first = f.options.find((o) => !o.archived);
        if (first && total > decided) counts.push({ key: first.id, n: BigInt(total - decided) });
      } else {
        counts = await db.$queryRaw`
          SELECT "values" ->> ${f.id} AS key, count(*) AS n FROM register_records
          WHERE register_id = ${registerId}::uuid AND deleted_at IS NULL AND archived_at IS NULL
          GROUP BY 1`;
      }
      const byKey = new Map(counts.map((c) => [c.key, Number(c.n)]));
      w.empty = byKey.get(null) ?? 0;
      if (f.type === 'user') {
        const users = await db.user.findMany({
          where: { id: { in: counts.map((c) => c.key).filter((k): k is string => !!k) } },
          select: { id: true, fullName: true },
        });
        w.rows = users.map((u) => ({ label: u.fullName, count: byKey.get(u.id) ?? 0 })).sort((a, b) => b.count - a.count);
      } else {
        w.rows = f.options.filter((o) => !o.archived || byKey.has(o.id)).map((o) => ({ label: o.label, count: byKey.get(o.id) ?? 0 }));
      }
    } else if (f.analyticsRole === 'metric') {
      w.kind = 'metric';
      const [r] = await db.$queryRaw<{ avg: number | null; max: number | null; n: bigint }[]>`
        SELECT avg(("values" ->> ${f.id})::numeric)::float8 AS avg, max(("values" ->> ${f.id})::numeric)::float8 AS max, count("values" -> ${f.id}) AS n
        FROM register_records
        WHERE register_id = ${registerId}::uuid AND deleted_at IS NULL AND archived_at IS NULL AND jsonb_typeof("values" -> ${f.id}) = 'number'`;
      w.avg = r?.avg ?? null;
      w.max = r?.max ?? null;
      w.filled = Number(r?.n ?? 0);
    } else {
      w.kind = f.analyticsRole === 'deadline' ? 'deadline' : 'timeline';
      // Вычисляемое поле в values не хранится — для него «заполнено» не считается.
      if (f.type !== 'calc') {
        const [r] = await db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM register_records
          WHERE register_id = ${registerId}::uuid AND deleted_at IS NULL AND archived_at IS NULL AND "values" ? ${f.id}`;
        w.filled = Number(r?.n ?? 0);
      }
    }
    out.push(w);
  }
  return out;
}
