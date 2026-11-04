// Системные виджеты «Осведомлённости» (релиз 1.8.0, docs/specs/awareness.md, раздел 6; решения владельца 7 и 9):
// «На пересдачу» без уволенных и «Средний результат по подразделениям». Плитка условие по связанной записи не умеет
// (определение — строка dashboard_tiles), поэтому это системные виджеты. Числа считает общий фильтр записей —
// число виджета и total списка по его ссылке совпадают.
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { formatDateRu, type Values } from '../../lib/register-values.js';
import { normalizeDimensionText } from '../../lib/text-dimension.js';
import { AWARENESS_RESULTS_KEY } from '../awareness/definition.js';
import type { RegisterDef } from '../registers/definition.js';
import { baseSql, countRecords, filterSql, registerLink, type RecordFilter } from '../registers/filter.js';

export const AWARENESS_RETAKE_WIDGET = 'awareness.retake';
export const AWARENESS_DEPT_WIDGET = 'awareness.byDept';
/** Последних попыток в виджете «На пересдачу». */
export const RETAKE_ITEMS = 6;

const byKey = (reg: RegisterDef, k: string) => reg.fields.find((f) => f.systemKey === k && !f.archived);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** «На пересдачу = Да» и сотрудник не уволен (несопоставленные — считаются: неизвестно, что человек уволен). */
export function retakeFilter(reg: RegisterDef): RecordFilter | null {
  const retake = byKey(reg, 'retake');
  const yes = retake?.options.find((o) => o.systemKey === 'yes' && !o.archived);
  const employee = byKey(reg, 'employee');
  if (!retake || !yes || !employee) return null;
  return { field: { fieldId: retake.id, values: [yes.id] }, linkOpen: employee.id };
}

export interface RetakeWidget {
  total: number;
  link: string | null;
  items: { id: string; title: string; sub: string; date: string | null; days: null; link: string }[];
}

export async function retakeWidget(db: Db, reg: RegisterDef): Promise<RetakeWidget> {
  const filter = retakeFilter(reg);
  if (!filter || reg.systemKey !== AWARENESS_RESULTS_KEY) return { total: 0, link: null, items: [] };
  const [fio, test, date, percent] = ['fullName', 'test', 'date', 'percent'].map((k) => byKey(reg, k));
  const order = date ? Prisma.sql`r."values" ->> ${date.id} DESC NULLS LAST, r.number DESC` : Prisma.sql`r.number DESC`;
  const rows = await db.$queryRaw<{ id: string; values: Values }[]>`
    SELECT r.id::text, r."values" FROM register_records r WHERE ${baseSql(reg.id)} ${filterSql(reg, filter)}
    ORDER BY ${order} LIMIT ${RETAKE_ITEMS}`;
  const s = (v: Values, f: { id: string } | undefined) => (f ? v[f.id] : undefined);
  return {
    total: await countRecords(db, reg, filter),
    link: registerLink(reg.id, filter),
    items: rows.map((r) => {
      const d = s(r.values, date);
      const p = s(r.values, percent);
      return {
        id: r.id,
        title: String(s(r.values, fio) ?? ''),
        sub: [String(s(r.values, test) ?? ''), typeof d === 'string' ? formatDateRu(d) : '', typeof p === 'number' ? `${String(p).replace('.', ',')}%` : ''].filter(Boolean).join(' · '),
        date: typeof d === 'string' ? d : null,
        days: null,
        link: `/registers?record=${r.id}#${reg.id}/records`,
      };
    }),
  };
}

export interface DeptRow { label: string; count: number; link: string | null; tone: null }

/**
 * Средний «Результат, %» по подразделениям (решение 9): все подразделения, от худшего среднего к лучшему, без обрезки.
 * Подразделение — по нормализованному тексту (как текстовое измерение), подпись — самое частое написание.
 */
export async function deptAverages(db: Db, reg: RegisterDef): Promise<{ rows: DeptRow[]; total: number; average: number | null }> {
  const dept = byKey(reg, 'dept');
  const percent = byKey(reg, 'percent');
  if (!dept || !percent) return { rows: [], total: 0, average: null };
  const raw = await db.$queryRaw<{ d: string | null; s: number; n: bigint }[]>`
    SELECT r."values" ->> ${dept.id} AS d, sum((r."values" ->> ${percent.id})::numeric)::float8 AS s, count(*) AS n
    FROM register_records r WHERE ${baseSql(reg.id)} AND jsonb_typeof(r."values" -> ${percent.id}) = 'number' GROUP BY 1`;
  const groups = new Map<string, { s: number; n: number; spellings: Map<string, number> }>();
  const empty = { s: 0, n: 0 };
  for (const r of raw) {
    const n = Number(r.n);
    const key = r.d ? normalizeDimensionText(r.d) : '';
    if (!key) {
      empty.s += r.s;
      empty.n += n;
      continue;
    }
    const g = groups.get(key) ?? { s: 0, n: 0, spellings: new Map<string, number>() };
    g.s += r.s;
    g.n += n;
    const shown = (r.d as string).replace(/[\s\u00a0]+/g, ' ').trim();
    g.spellings.set(shown, (g.spellings.get(shown) ?? 0) + n);
    groups.set(key, g);
  }
  const rows: DeptRow[] = [...groups.entries()].map(([key, g]) => {
    const [label = key] = [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru')).map(([x]) => x);
    return { label, count: round1(g.s / g.n), link: registerLink(reg.id, { text: { fieldId: dept.id, value: key } }), tone: null as null };
  }).sort((a, b) => a.count - b.count || a.label.localeCompare(b.label, 'ru'));
  if (empty.n) rows.push({ label: 'Не заполнено', count: round1(empty.s / empty.n), link: registerLink(reg.id, { text: { fieldId: dept.id, value: null } }), tone: null });
  const n = raw.reduce((x, r) => x + Number(r.n), 0);
  const sum = raw.reduce((x, r) => x + r.s, 0);
  return { rows, total: n, average: n ? round1(sum / n) : null };
}
