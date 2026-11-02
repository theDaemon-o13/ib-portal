// Чтение раздела «Уязвимости» (релиз 1.5.0): счётчики узлов, реестр узла, карточка записи.
// Срок — та же функция, что у дашборда, монитора и правил п. 7.4 (dateOf → calcValue), записи одного реестра.
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { notFound } from '../../lib/errors.js';
import { calcValue, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { calendarFor, dateOf, isClosed, loadRegister, toRecordDtos, type RegisterDef } from '../registers/definition.js';
import { VULN_REGISTER_KEY, vulnFields, type VulnFields } from './definition.js';
import { recordExtensions } from './extensions.service.js';
import { loadNode, nodeLabel } from './groups.service.js';
import { getVulnSettings, scanFreshness } from './profiles.js';

export type RecordState = 'overdue' | 'not_handed' | 'in_work' | 'fixed' | 'accepted';

/** Порядок реестра узла: просроченные, не переданные, в работе, устранённые. */
const STATE_ORDER: Record<RecordState, number> = { overdue: 0, not_handed: 1, in_work: 2, fixed: 3, accepted: 4 };
const CRIT_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function vulnDef(db: Db): Promise<{ reg: RegisterDef; vf: VulnFields }> {
  const row = await db.register.findUniqueOrThrow({ where: { systemKey: VULN_REGISTER_KEY } });
  const reg = await loadRegister(db, row.id);
  return { reg, vf: vulnFields(reg) };
}

function stateOf(reg: RegisterDef, vf: VulnFields, values: Values, due: string | null, today: string): RecordState {
  if (isClosed(reg, values)) return vf.status.options.find((o) => o.id === values[vf.status.id])?.systemKey === 'fixed' ? 'fixed' : 'accepted';
  if (due === null) return 'not_handed';
  return due < today ? 'overdue' : 'in_work';
}

export async function overview(db: Db) {
  const { reg, vf } = await vulnDef(db);
  const calendar = await calendarFor(db, reg);
  const today = todayIso();
  const records = await db.vulnRecord.findMany({
    where: { record: { deletedAt: null, archivedAt: null } },
    select: { nodeId: true, record: { select: { values: true } } },
  });
  const critical = vf.crit.options.find((o) => o.systemKey === 'critical')?.id;
  const stats = new Map<string, { open: number; overdue: number; critical: number; notHandedOver: number; fixed: number; total: number }>();
  for (const r of records) {
    const values = r.record.values as Values;
    const state = stateOf(reg, vf, values, dateOf(reg, vf.due, values, calendar), today);
    const s = stats.get(r.nodeId) ?? { open: 0, overdue: 0, critical: 0, notHandedOver: 0, fixed: 0, total: 0 };
    s.total++;
    if (state === 'fixed' || state === 'accepted') s.fixed++;
    else {
      s.open++;
      if (state === 'overdue') s.overdue++;
      if (state === 'not_handed') s.notHandedOver++;
      if (values[vf.crit.id] === critical) s.critical++;
    }
    stats.set(r.nodeId, s);
  }
  const scans = await db.vulnScan.findMany({
    where: { node: { deletedAt: null, group: { deletedAt: null } } },
    select: { id: true, nodeId: true, scanDate: true, fileName: true, handedOverOn: true, createdAt: true, legacyReportId: true },
    orderBy: [{ scanDate: 'desc' }, { createdAt: 'desc' }],
  });
  const nodes = await db.vulnNode.findMany({ where: { deletedAt: null, group: { deletedAt: null } }, include: { group: true, systemType: true } });
  const labels = new Map(nodes.map((n) => [n.id, nodeLabel(n)]));
  const { scanMaxAgeDays } = await getVulnSettings(db);
  const nodeStats = nodes.map((n) => {
      const own = scans.filter((s) => s.nodeId === n.id);
      const first = own[0];
      // «Без группы» сканов не получает: регулярность там не считается.
      const fresh = n.systemKey ? { ageDays: null, stale: false } : scanFreshness(first ? iso(first.scanDate) : null, today, scanMaxAgeDays);
      return {
        nodeId: n.id,
        ...(stats.get(n.id) ?? { open: 0, overdue: 0, critical: 0, notHandedOver: 0, fixed: 0, total: 0 }),
        lastScan: first ? { id: first.id, scanDate: iso(first.scanDate), handedOver: first.handedOverOn !== null } : null,
        scans: own.slice(0, 50).map((s) => ({ id: s.id, scanDate: iso(s.scanDate), fileName: s.fileName, handedOver: s.handedOverOn !== null })),
        scanAgeDays: fresh.ageDays,
        scanStale: fresh.stale,
      };
    });
  return {
    registerId: reg.id,
    nodes: nodeStats,
    scanMaxAgeDays,
    staleNodes: nodeStats.filter((s) => s.scanStale).map((s) => ({ nodeId: s.nodeId, label: labels.get(s.nodeId) ?? '', lastScanDate: s.lastScan?.scanDate ?? null, ageDays: s.scanAgeDays })),
    awaiting: scans.filter((s) => !s.handedOverOn).map((s) => ({
      id: s.id, nodeId: s.nodeId, nodeLabel: labels.get(s.nodeId) ?? '', scanDate: iso(s.scanDate), fileName: s.fileName, createdAt: s.createdAt.toISOString(),
    })),
  };
}

export interface NodeRecordsQuery {
  search?: string;
  crit?: string;
  state?: RecordState | 'open' | 'all';
  limit?: number;
  cursor?: string;
}

/** Реестр узла. Записи считаются в памяти: состояние зависит от вычисляемого срока, а узел — тысячи записей, не миллионы. */
export async function nodeRecords(db: Db, nodeId: string, q: NodeRecordsQuery) {
  await loadNode(db, nodeId);
  const { reg, vf } = await vulnDef(db);
  const calendar = await calendarFor(db, reg);
  const today = todayIso();
  const rows = await db.vulnRecord.findMany({
    where: { nodeId, record: { deletedAt: null, archivedAt: null } },
    select: { cycle: true, reopenedAt: true, record: true },
  });
  const score = vf.score.calcRule;
  const search = q.search?.trim().toLowerCase();
  const stateCounts: Record<RecordState, number> = { overdue: 0, not_handed: 0, in_work: 0, fixed: 0, accepted: 0 };
  const items = rows.map((r) => {
    const values = r.record.values as Values;
    const state = stateOf(reg, vf, values, dateOf(reg, vf.due, values, calendar), today);
    const s = score ? calcValue(score, values, { fields: reg.fields }) : null;
    const critKey = vf.crit.options.find((o) => o.id === values[vf.crit.id])?.systemKey ?? '';
    return { r, values, state, score: typeof s === 'number' ? s : -1, crit: CRIT_ORDER[critKey] ?? 9 };
  }).filter((x) => {
    if (q.crit && x.values[vf.crit.id] !== q.crit) return false;
    return !search || x.r.record.searchText.includes(search);
  });
  for (const x of items) stateCounts[x.state]++;
  const wanted = q.state ?? 'open';
  const open = (s: RecordState) => s !== 'fixed' && s !== 'accepted';
  const filtered = items.filter((x) => wanted === 'all' || (wanted === 'open' ? open(x.state) : x.state === wanted));
  filtered.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.crit - b.crit || b.score - a.score || a.r.record.number - b.r.record.number);
  const limit = q.limit ?? 100;
  const offset = q.cursor ? Number(q.cursor) : 0;
  const page = filtered.slice(offset, offset + limit);
  const dtos = await toRecordDtos(db, reg, page.map((x) => x.r.record));
  return {
    items: dtos.map((d, i) => {
      const x = page[i] as (typeof page)[number];
      return { ...d, vuln: { state: x.state, reopened: x.r.reopenedAt !== null && open(x.state), cycle: x.r.cycle } };
    }),
    total: filtered.length,
    nextCursor: offset + limit < filtered.length ? String(offset + limit) : null,
    stateCounts,
  };
}

export const RecordInfo = z.object({
  node: z.object({ id: z.string(), label: z.string(), legacy: z.boolean() }),
  state: z.enum(['overdue', 'not_handed', 'in_work', 'fixed', 'accepted']),
  cycle: z.number().int(),
  reopenedAt: z.string().nullable(),
  deadline: z.object({
    /** База: срок из прежнего реестра или передача ИКТ + дни по Критичности (с переносом). */
    source: z.enum(['legacy', 'procedure', 'none']),
    base: z.string().nullable(),
    days: z.number().int().nullable(),
    scan: z.object({ id: z.string(), scanDate: z.string(), handedOverOn: z.string().nullable() }).nullable(),
    decision: z.object({ measures: z.string(), due: z.string() }).nullable(),
    extendedDays: z.number().int(),
    final: z.string().nullable(),
  }),
  extensions: z.array(z.object({
    id: z.string(), days: z.number().int(), dueBefore: z.string(), dueAfter: z.string(), basisNumber: z.string(), basisDate: z.string(), basisFileId: z.string(),
    cancelledAt: z.string().nullable(), active: z.boolean(),
  })),
  scans: z.array(z.object({
    id: z.string(), scanDate: z.string(), fileName: z.string(), outcome: z.string(), cycle: z.number().int(),
    handedOver: z.boolean(), changes: z.array(z.object({ label: z.string(), from: z.string(), to: z.string() })),
  })),
  firstScanDate: z.string().nullable(),
  lastScanDate: z.string().nullable(),
});

export async function recordInfo(db: Db, id: string) {
  const v = await db.vulnRecord.findUnique({
    where: { recordId: id },
    include: {
      record: true,
      node: { include: { group: true, systemType: true } },
      deadlineScan: true, firstScan: true, lastScan: true,
    },
  });
  if (!v || v.record.deletedAt) throw notFound('Запись');
  const { reg, vf } = await vulnDef(db);
  const calendar = await calendarFor(db, reg);
  const values = v.record.values as Values;
  const final = dateOf(reg, vf.due, values, calendar);
  const legacyDue = values[vf.legacyDue.id];
  const notified = values[vf.notified.id];
  // База — та же формула без решения п. 7.3 и без продлений.
  const dropped = new Set([vf.measures.id, vf.newDue.id, vf.extDays.id]);
  const baseValues: Values = Object.fromEntries(Object.entries(values).filter(([fid]) => !dropped.has(fid)));
  const rule = vf.due.calcRule;
  const base = rule ? calcValue(rule, baseValues, { fields: reg.fields, calendar }) : null;
  const measures = values[vf.measures.id];
  const newDue = values[vf.newDue.id];
  const crit = values[vf.crit.id];
  const days = rule && 'days' in rule && typeof crit === 'string' ? rule.days[crit] ?? null : null;
  const extra = values[vf.extDays.id];
  const seen = await db.vulnRecordScan.findMany({ where: { recordId: id }, include: { scan: true } });
  seen.sort((a, b) => b.scan.scanDate.getTime() - a.scan.scanDate.getTime() || b.scan.createdAt.getTime() - a.scan.createdAt.getTime());
  return {
    node: { id: v.nodeId, label: nodeLabel(v.node), legacy: v.node.systemKey !== null },
    state: stateOf(reg, vf, values, final, todayIso()),
    cycle: v.cycle,
    reopenedAt: v.reopenedAt?.toISOString() ?? null,
    deadline: {
      source: typeof legacyDue === 'string' ? 'legacy' as const : typeof notified === 'string' ? 'procedure' as const : 'none' as const,
      base: typeof base === 'string' ? base : null,
      days: typeof legacyDue === 'string' ? null : days,
      scan: v.deadlineScan ? { id: v.deadlineScan.id, scanDate: iso(v.deadlineScan.scanDate), handedOverOn: v.deadlineScan.handedOverOn ? iso(v.deadlineScan.handedOverOn) : null } : null,
      decision: typeof measures === 'string' && measures && typeof newDue === 'string' ? { measures, due: newDue } : null,
      extendedDays: typeof extra === 'number' ? extra : 0,
      final,
    },
    extensions: await recordExtensions(db, id, v.cycle),
    scans: seen.map((s) => ({
      id: s.scanId, scanDate: iso(s.scan.scanDate), fileName: s.scan.fileName, outcome: s.outcome, cycle: s.cycle, handedOver: s.scan.handedOverOn !== null,
      changes: ((s.changes ?? []) as { label: string; from: string; to: string }[]).map((c) => ({ label: c.label, from: c.from, to: c.to })),
    })),
    firstScanDate: v.firstScan ? iso(v.firstScan.scanDate) : null,
    lastScanDate: v.lastScan ? iso(v.lastScan.scanDate) : null,
  };
}
