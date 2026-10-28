// Экран мониторинга (этап 8): одним ответом — KPI, открытые уязвимости с днями до срока (срочное сначала),
// распределение по срокам, задачи, документы, риски и доказательства с днями. Кэш — 1 минута (routes.ts).
import type { Db } from '../../lib/db.js';
import { calcValue, displayValue, type Values } from '../../lib/register-values.js';
import { daysBetween, todayIso } from '../../lib/today.js';
import type { Tone } from '../../lib/tones.js';
import { computeKpis, systemRegister, type Kpi } from '../dashboard/service.js';
import { DEPARTMENT_VIEW, LIST_LIMIT as DOC_LIMIT, listDocuments } from '../documents/service.js';
import { LIST_LIMIT as EVIDENCE_LIMIT, listEvidence } from '../evidence/service.js';
import { calendarFor, dateOf, loadUsers, userIdsIn, type RegisterDef } from '../registers/definition.js';
import { baseSql, closedSql } from '../registers/filter.js';
import { RISK_REGISTER_KEY } from '../risks/definition.js';
import { VULN_REGISTER_KEY, vulnFields } from '../vulns/definition.js';

/** Сколько строк отдаём: экран листает страницы, больше на стене не прочитать. */
export const MONITOR_VULNS_MAX = 300;
export const MONITOR_ITEMS_MAX = 200;

export interface MonitorVuln {
  id: string;
  number: number;
  title: string;
  pkg: string;
  desc: string;
  crit: { label: string; tone: Tone | null } | null;
  hits: number | null;
  score: number | null;
  due: string | null;
  /** Дней до срока; отрицательное — просрочка; null — срока нет. */
  days: number | null;
}

export interface MonitorBucket {
  key: 'overdue' | 'd0_7' | 'd8_14' | 'd15_30' | 'd31' | 'none';
  label: string;
  count: number;
  tone: Tone | null;
}

export interface MonitorItem {
  kind: 'task' | 'document' | 'risk' | 'evidence';
  id: string;
  title: string;
  sub: string;
  due: string;
  days: number;
}

export interface MonitorData {
  kpis: Kpi[];
  vulns: {
    registerId: string;
    total: number;
    items: MonitorVuln[];
    buckets: MonitorBucket[];
    dates: { date: string; days: number; count: number }[];
    packages: { label: string; count: number }[];
  } | null;
  items: MonitorItem[];
}

const CRIT_TONE: Record<string, Tone> = { critical: 'crit', high: 'high', medium: 'med', low: 'low' };

export function bucketOf(days: number | null): MonitorBucket['key'] {
  if (days === null) return 'none';
  if (days < 0) return 'overdue';
  if (days <= 7) return 'd0_7';
  if (days <= 14) return 'd8_14';
  if (days <= 30) return 'd15_30';
  return 'd31';
}

const BUCKETS: Omit<MonitorBucket, 'count'>[] = [
  { key: 'overdue', label: 'Просрочено', tone: 'crit' },
  { key: 'd0_7', label: '0–7 дн.', tone: 'high' },
  { key: 'd8_14', label: '8–14 дн.', tone: 'med' },
  { key: 'd15_30', label: '15–30 дн.', tone: null },
  { key: 'd31', label: 'Более 30 дн.', tone: 'low' },
  { key: 'none', label: 'Без срока', tone: 'muted' },
];

/** Открытые уязвимости: срочное сначала (дни до срока), при равенстве — выше Оценка. */
export async function vulnsBlock(db: Db, reg: RegisterDef, today: string): Promise<NonNullable<MonitorData['vulns']>> {
  const vf = vulnFields(reg);
  const rows = await db.$queryRaw<{ id: string; number: number; values: Values }[]>`
    SELECT r.id, r.number, r."values" FROM register_records r WHERE ${baseSql(reg.id)} AND NOT ${closedSql(reg)}`;
  const calendar = await calendarFor(db, reg);
  const users = await loadUsers(db, userIdsIn(reg, rows.map((r) => r.values)));
  const all: MonitorVuln[] = rows.map((r) => {
    const due = dateOf(reg, vf.due, r.values, calendar);
    const score = vf.score.calcRule ? calcValue(vf.score.calcRule, r.values, { fields: reg.fields, calendar }) : null;
    const critOpt = vf.crit.options.find((o) => o.id === r.values[vf.crit.id]);
    const hits = r.values[vf.hits.id];
    return {
      id: r.id,
      number: r.number,
      title: displayValue(vf.cve, r.values[vf.cve.id], { users }) || `#${r.number}`,
      pkg: displayValue(vf.pkg, r.values[vf.pkg.id], { users }),
      desc: displayValue(vf.desc, r.values[vf.desc.id], { users }),
      crit: critOpt ? { label: critOpt.label, tone: (critOpt.systemKey && CRIT_TONE[critOpt.systemKey]) || null } : null,
      hits: typeof hits === 'number' ? hits : null,
      score: typeof score === 'number' ? score : null,
      due,
      days: due ? daysBetween(today, due) : null,
    };
  });
  all.sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity) || (b.score ?? -1) - (a.score ?? -1) || a.number - b.number);

  const buckets = BUCKETS.map((b) => ({ ...b, count: all.filter((v) => bucketOf(v.days) === b.key).length }))
    .filter((b) => b.key !== 'none' || b.count > 0);
  const byDate = new Map<string, number>();
  for (const v of all) if (v.due) byDate.set(v.due, (byDate.get(v.due) ?? 0) + 1);
  const dates = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 5)
    .map(([date, count]) => ({ date, days: daysBetween(today, date), count }));
  const byPkg = new Map<string, number>();
  for (const v of all) if (v.pkg) byPkg.set(v.pkg, (byPkg.get(v.pkg) ?? 0) + 1);
  const packages = [...byPkg.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru')).slice(0, 5)
    .map(([label, count]) => ({ label, count }));
  return { registerId: reg.id, total: all.length, items: all.slice(0, MONITOR_VULNS_MAX), buckets, dates, packages };
}

const byDays = (a: MonitorItem, b: MonitorItem) => a.days - b.days || a.title.localeCompare(b.title, 'ru');

/** Открытые задачи со сроком — дни до срока, срочное сначала. */
export async function taskItems(db: Db, today: string): Promise<MonitorItem[]> {
  const tasks = await db.task.findMany({
    where: { deletedAt: null, archivedAt: null, completedAt: null, dueDate: { not: null } },
    select: { id: true, title: true, dueDate: true, assignee: { select: { fullName: true } } },
    orderBy: { dueDate: 'asc' },
    take: MONITOR_ITEMS_MAX,
  });
  return tasks.map((t) => {
    const due = (t.dueDate as Date).toISOString().slice(0, 10);
    return { kind: 'task' as const, id: t.id, title: t.title, sub: t.assignee?.fullName ?? 'не назначен', due, days: daysBetween(today, due) };
  });
}

/** Документы: срок пересмотра (он же срок актуальности) у утверждённых и пересматриваемых. */
export async function documentItems(db: Db, today: string): Promise<MonitorItem[]> {
  const docs = await listDocuments(db, DEPARTMENT_VIEW, { archived: false, limit: DOC_LIMIT });
  return docs.items
    .filter((d) => d.reviewDue && ['approved', 'in_review', 'review_overdue'].includes(d.status))
    .map((d) => ({ kind: 'document' as const, id: d.id, title: d.title, sub: `пересмотр · ${d.owner.fullName}`, due: d.reviewDue as string, days: daysBetween(today, d.reviewDue as string) }));
}

/** Риски ИБ: пересмотр решения ОУР. */
export async function riskItems(db: Db, today: string): Promise<MonitorItem[]> {
  const risks = await systemRegister(db, RISK_REGISTER_KEY);
  const reviewDue = risks?.fields.find((f) => f.systemKey === 'reviewDue' && !f.archived);
  const riskTitle = risks?.fields.find((f) => f.isTitle);
  if (!risks || !reviewDue) return [];
  const rows = await db.$queryRaw<{ id: string; number: number; values: Values }[]>`
    SELECT r.id, r.number, r."values" FROM register_records r
    WHERE ${baseSql(risks.id)} AND NOT ${closedSql(risks)} AND r."values" ? ${reviewDue.id}`;
  return rows.map((r) => {
    const due = String(r.values[reviewDue.id]);
    const title = riskTitle && typeof r.values[riskTitle.id] === 'string' ? String(r.values[riskTitle.id]) : `Риск #${r.number}`;
    return { kind: 'risk' as const, id: r.id, title, sub: 'пересмотр решения ОУР', due, days: daysBetween(today, due) };
  });
}

/** Принятые доказательства со сроком действия. */
export async function evidenceItems(db: Db, today: string): Promise<MonitorItem[]> {
  const ev = await listEvidence(db, { archived: false, limit: EVIDENCE_LIMIT });
  return ev.items
    .filter((e) => e.validUntil && e.status === 'accepted')
    .map((e) => ({ kind: 'evidence' as const, id: e.id, title: e.title || e.object.label, sub: `срок действия · ${e.object.label}`, due: e.validUntil as string, days: daysBetween(today, e.validUntil as string) }));
}

/** Задачи, документы, риски и доказательства со сроком — дни до срока, срочное сначала. */
async function otherItems(db: Db, today: string): Promise<MonitorItem[]> {
  const parts = await Promise.all([taskItems(db, today), documentItems(db, today), riskItems(db, today), evidenceItems(db, today)]);
  return parts.flat().sort(byDays).slice(0, MONITOR_ITEMS_MAX);
}

export async function monitorData(db: Db): Promise<MonitorData> {
  const today = todayIso();
  const vulns = await systemRegister(db, VULN_REGISTER_KEY);
  const [kpis, vulnBlock, items] = await Promise.all([
    computeKpis(db),
    vulns ? vulnsBlock(db, vulns, today) : Promise.resolve(null),
    otherItems(db, today),
  ]);
  return { kpis, vulns: vulnBlock, items };
}
