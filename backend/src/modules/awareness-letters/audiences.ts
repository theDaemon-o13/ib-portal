// Подсказки аудитории для «Отметить отправленным» (1.9.0; docs/specs/awareness.md, раздел 13.4): «Все сотрудники»,
// подразделения работающих сотрудников реестра «Сотрудники» и прежние аудитории из отметок «Отправлено».
// Одинаковые без учёта регистра, лишних пробелов и «ё» — одна подсказка (нормализация как у текстового измерения),
// подпись — самое частое написание. Аудитория остаётся текстом: подсказка ничего не связывает.
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { normalizeDimensionText } from '../../lib/text-dimension.js';
import { AWARENESS_EMPLOYEES_KEY } from '../awareness/definition.js';

export const ALL_EMPLOYEES = 'Все сотрудники';
export const AUDIENCE_LIMIT = 30;

type Source = 'all' | 'dept' | 'previous';
interface Suggestion { value: string; source: Source; count: number }

/** Подразделения работающих сотрудников: значение → число сотрудников. */
async function departments(db: Db): Promise<Map<string, number>> {
  const reg = await db.register.findFirst({
    where: { systemKey: AWARENESS_EMPLOYEES_KEY, archivedAt: null, deletedAt: null },
    select: { id: true, fields: { where: { systemKey: { in: ['dept', 'status'] }, deletedAt: null }, select: { id: true, systemKey: true, options: { select: { id: true, systemKey: true } } } } },
  });
  const dept = reg?.fields.find((f) => f.systemKey === 'dept');
  if (!reg || !dept) return new Map();
  // Уволенные («Уволен» — закрывающий статус) не подсказывают своё подразделение.
  const status = reg.fields.find((f) => f.systemKey === 'status');
  const fired = status?.options.find((o) => o.systemKey === 'fired');
  const notFired = status && fired
    ? Prisma.sql`AND coalesce(r."values" ->> ${status.id}, '') <> ${fired.id}`
    : Prisma.empty;
  const rows = await db.$queryRaw<{ v: string; n: bigint }[]>`
    SELECT r."values" ->> ${dept.id} AS v, count(*) AS n FROM register_records r
    WHERE r.register_id = ${reg.id}::uuid AND r.deleted_at IS NULL AND r.archived_at IS NULL
      AND coalesce(r."values" ->> ${dept.id}, '') <> '' ${notFired}
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.v, Number(r.n)]));
}

/** Прежние аудитории из отметок «Отправлено»: значение → сколько раз. */
async function previous(db: Db): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<{ v: string; n: bigint }[]>`
    SELECT audience AS v, count(*) AS n FROM awareness_letter_events WHERE action = 'sent' AND audience IS NOT NULL GROUP BY 1`;
  return new Map(rows.map((r) => [r.v, Number(r.n)]));
}

/** Сгруппировать по нормализованному тексту: подпись — самое частое написание, число — сумма. */
function group(values: Map<string, number>, source: Source, seen: Set<string>): Suggestion[] {
  const groups = new Map<string, { spellings: Map<string, number>; count: number }>();
  for (const [v, n] of values) {
    const key = normalizeDimensionText(v);
    if (!key || seen.has(key)) continue;
    const g = groups.get(key) ?? { spellings: new Map(), count: 0 };
    g.spellings.set(v.trim(), (g.spellings.get(v.trim()) ?? 0) + n);
    g.count += n;
    groups.set(key, g);
  }
  const out: Suggestion[] = [];
  for (const [key, g] of groups) {
    seen.add(key);
    const value = [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))[0]?.[0] ?? key;
    out.push({ value, source, count: g.count });
  }
  return out.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'ru'));
}

export async function audienceSuggestions(db: Db, q?: string): Promise<{ items: Suggestion[] }> {
  const needle = normalizeDimensionText(q ?? '');
  const seen = new Set([normalizeDimensionText(ALL_EMPLOYEES)]);
  const items: Suggestion[] = [
    { value: ALL_EMPLOYEES, source: 'all', count: 0 },
    // Подразделения — первыми: их точное написание из выгрузки HR; прежние аудитории — те, что ещё не встретились.
    ...group(await departments(db), 'dept', seen),
    ...group(await previous(db), 'previous', seen),
  ];
  const filtered = needle ? items.filter((s) => normalizeDimensionText(s.value).includes(needle)) : items;
  return { items: filtered.slice(0, AUDIENCE_LIMIT) };
}
