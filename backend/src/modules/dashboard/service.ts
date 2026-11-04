// Дашборд (этап 8): KPI и виджеты из полей реестров с ролью аналитики. Всё считается на сервере;
// числа берутся тем же кодом, что и списки по ссылкам (countRecords, listDocuments, listEvidence, overdueTaskWhere),
// поэтому KPI совпадает с total раздела, куда ведёт.
import type { Db } from '../../lib/db.js';
import { notFound } from '../../lib/errors.js';
import { formatDateRu, type Values } from '../../lib/register-values.js';
import { addDaysIso, daysBetween, todayIso } from '../../lib/today.js';
import { textDimensionRows } from '../../lib/text-dimension.js';
import type { Tone } from '../../lib/tones.js';
import { DEPARTMENT_VIEW, listDocuments } from '../documents/service.js';
import { DOC_STATUS_NAMES, type DocStatus } from '../documents/status.js';
import { listEvidence } from '../evidence/service.js';
import { EVIDENCE_STATE_NAMES, EVIDENCE_STATES, type EvidenceState } from '../evidence/status.js';
import {
  calendarFor,
  dateOf,
  deadlineField,
  deadlineState,
  isClosed,
  loadRegister,
  loadUsers,
  type FieldMeta,
  type RegisterDef,
} from '../registers/definition.js';
import { baseSql, closedSql, countRecords, EMPTY_VALUE, fieldValueSql, registerLink, type RecordFilter } from '../registers/filter.js';
import { loadBasisSources } from '../registers/links.js';
import { basisOf, isBasisRule } from '../../lib/link-basis.js';
import { RISK_REGISTER_KEY } from '../risks/definition.js';
import { overdueTaskWhere } from '../tasks/service.js';
import { VULN_REGISTER_KEY } from '../vulns/definition.js';
import { INCIDENT_DATE_KEY, INCIDENT_REGISTER_KEY } from './incidents.js';

// ---------------------------------------------------------------- KPI

export const KPI_KEYS = [
  'vulns_open', 'vulns_overdue', 'vulns_soon', 'incidents_30d', 'tasks_overdue',
  'docs_review', 'risks_no_decision', 'evidence_pending', 'evidence_expiring',
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

export interface Kpi {
  key: KpiKey;
  label: string;
  /** null — источник не настроен (системного реестра нет). */
  value: number | null;
  tone: 'bad' | 'warn' | null;
  /** Откуда число: подпись под KPI. */
  source: string;
  /** Раздел с тем же фильтром; null — некуда вести. */
  link: string | null;
}

/** Окно KPI «Инциденты за 30 дней»: сегодня и 29 дней до него (включительно). */
export const INCIDENT_WINDOW_DAYS = 30;

export async function systemRegister(db: Db, systemKey: string): Promise<RegisterDef | null> {
  const r = await db.register.findUnique({ where: { systemKey }, select: { id: true, archivedAt: true } });
  if (!r || r.archivedAt) return null;
  return loadRegister(db, r.id);
}

/** Поле «Решение ОУР» реестра рисков: «без решения» = последнее решение — первый вариант (или решений нет). */
function riskNoDecision(reg: RegisterDef): RecordFilter | null {
  const decision = reg.fields.find((f) => f.systemKey === 'decision' && f.type === 'decision');
  const pending = decision?.options.find((o) => !o.archived);
  if (!decision || !pending) return null;
  return { state: 'open', field: { fieldId: decision.id, values: [pending.id] } };
}

export async function computeKpis(db: Db): Promise<Kpi[]> {
  const today = todayIso();
  const [vulns, incidents, risks] = await Promise.all([
    systemRegister(db, VULN_REGISTER_KEY), systemRegister(db, INCIDENT_REGISTER_KEY), systemRegister(db, RISK_REGISTER_KEY),
  ]);
  const byFilter = async (reg: RegisterDef | null, filter: RecordFilter | null) =>
    reg && filter ? { value: await countRecords(db, reg, filter), link: registerLink(reg.id, filter) } : { value: null, link: null };

  const incidentDate = incidents?.fields.find((f) => f.systemKey === INCIDENT_DATE_KEY && !f.archived);
  const incidentFilter: RecordFilter | null = incidentDate
    ? { date: { fieldId: incidentDate.id, from: addDaysIso(today, -(INCIDENT_WINDOW_DAYS - 1)), to: today } }
    : null;

  const [vOpen, vOver, vSoon, inc, risk, tasksOverdue, docs, ev] = await Promise.all([
    byFilter(vulns, { state: 'open' }),
    byFilter(vulns, { deadline: ['overdue'] }),
    byFilter(vulns, { deadline: ['soon'] }),
    byFilter(incidents, incidentFilter),
    byFilter(risks, risks ? riskNoDecision(risks) : null),
    db.task.count({ where: overdueTaskWhere(today) }),
    listDocuments(db, DEPARTMENT_VIEW, { archived: false, review: true, limit: 1 }),
    listEvidence(db, { archived: false, limit: 1 }),
  ]);
  const warnIf = (n: number | null) => (n ? 'warn' as const : null);
  const badIf = (n: number | null) => (n ? 'bad' as const : null);
  return [
    { key: 'vulns_open', label: 'Открытые уязвимости', ...vOpen, tone: null, source: 'реестр уязвимостей' },
    { key: 'vulns_overdue', label: 'Уязвимости с просроченным сроком', ...vOver, tone: badIf(vOver.value), source: 'поле «Срок устранения»' },
    { key: 'vulns_soon', label: 'Срок устранения в ближайшие 7 дней', ...vSoon, tone: warnIf(vSoon.value), source: 'поле «Срок устранения»' },
    { key: 'incidents_30d', label: 'Инциденты за 30 дней', ...inc, tone: null, source: incidents ? 'реестр инцидентов' : 'реестр инцидентов не настроен' },
    { key: 'tasks_overdue', label: 'Просроченные задачи', value: tasksOverdue, link: '/tasks?overdue=1', tone: warnIf(tasksOverdue), source: 'раздел «Задачи»' },
    { key: 'docs_review', label: 'Документы к пересмотру', value: docs.total, link: '/documents?filter=review', tone: warnIf(docs.total), source: 'раздел «Документы»' },
    { key: 'risks_no_decision', label: 'Риски ИБ без решения ОУР', ...risk, tone: warnIf(risk.value), source: 'реестр рисков ИБ' },
    { key: 'evidence_pending', label: 'Доказательства на проверке', value: ev.counts.pending, link: '/evidence?filter=pending', tone: warnIf(ev.counts.pending), source: 'раздел «Доказательства»' },
    { key: 'evidence_expiring', label: 'Доказательства истекают', value: ev.counts.expiring, link: '/evidence?filter=expiring', tone: warnIf(ev.counts.expiring), source: 'срок действия ≤ 30 дней' },
  ];
}

/** KPI дашборда — восемь из задания; «ближайшие 7 дней» — только на мониторинге. */
export const DASHBOARD_KPIS: readonly KpiKey[] = KPI_KEYS.filter((k) => k !== 'vulns_soon');

// ---------------------------------------------------------------- виджеты

export type WidgetKind = 'distribution' | 'metric' | 'timeline' | 'deadline' | 'tile' | 'bars' | 'basis';

export interface WidgetRef {
  key: string;
  title: string;
  kind: WidgetKind;
  /** Подпись: реестр или раздел. */
  source: string;
  registerId: string | null;
}

export interface WidgetRow {
  label: string;
  count: number;
  link: string | null;
  tone: Tone | null;
}
export interface WidgetStat {
  label: string;
  value: number | null;
  tone: Tone | null;
  link: string | null;
}
export interface WidgetItem {
  id: string;
  title: string;
  sub: string;
  date: string | null;
  days: number | null;
  link: string;
}
export interface WidgetData extends WidgetRef {
  link: string | null;
  total: number | null;
  rows: WidgetRow[];
  stats: WidgetStat[];
  items: WidgetItem[];
}

const FIXED: WidgetRef[] = [
  { key: 'tasks.categories', title: 'Открытые задачи по категориям', kind: 'bars', source: 'Задачи', registerId: null },
  { key: 'documents.status', title: 'Актуальность документов', kind: 'bars', source: 'Документы', registerId: null },
  { key: 'evidence.state', title: 'Доказательная база', kind: 'bars', source: 'Доказательства', registerId: null },
];

const KIND_OF_ROLE: Record<string, WidgetKind> = { dimension: 'distribution', metric: 'metric', date: 'timeline', deadline: 'deadline' };

function fieldTitle(f: FieldMeta): string {
  if (f.analyticsRole === 'date') return `${f.label} — по неделям`;
  if (f.analyticsRole === 'deadline') return `Контроль поля «${f.label}»`;
  return f.label;
}

/** Виджеты из полей реестров с ролью аналитики (неархивные реестры и поля) и постоянные виджеты разделов. */
export async function listWidgets(db: Db): Promise<WidgetRef[]> {
  const fields = await db.registerField.findMany({
    where: { analyticsRole: { not: null }, deletedAt: null, archivedAt: null, register: { archivedAt: null } },
    select: { id: true, label: true, analyticsRole: true, registerId: true, register: { select: { name: true, systemKey: true, createdAt: true } } },
    orderBy: [{ register: { createdAt: 'asc' } }, { sortOrder: 'asc' }],
  });
  const fromFields = fields
    .filter((f) => f.analyticsRole && KIND_OF_ROLE[f.analyticsRole])
    .map((f) => ({
      key: `field:${f.id}`,
      title: fieldTitle({ label: f.label, analyticsRole: f.analyticsRole } as FieldMeta),
      kind: KIND_OF_ROLE[f.analyticsRole as string] as WidgetKind,
      source: f.register.name,
      registerId: f.registerId,
    }));
  // Сверка с DLP (этап 8б): реестр с полями «статус основания» — виджет «Доступ без основания».
  const basisRegs = await db.$queryRaw<{ id: string; name: string }[]>`
    SELECT DISTINCT g.id::text, g.name, g.created_at FROM register_fields f JOIN registers g ON g.id = f.register_id
    WHERE f.deleted_at IS NULL AND f.archived_at IS NULL AND g.archived_at IS NULL AND g.deleted_at IS NULL AND f.calc_rule ->> 'kind' = 'link_basis'
    ORDER BY g.created_at`;
  const basis = basisRegs.map((r) => ({ key: `basis:${r.id}`, title: 'Доступ без основания', kind: 'basis' as const, source: r.name, registerId: r.id }));
  return [...basis, ...fromFields, ...FIXED];
}

/** Нет действующего основания: канал открыт, а разрешения нет или оно истекло. */
const NO_BASIS = ['none', 'expired'];

/**
 * «Доступ без основания» (этап 8б): главная цифра — открытые записи, у которых хоть один канал без основания;
 * по каналам — тот же фильтр, что в ссылке; «Истекают в этом месяце» — действующие разрешения со сроком до конца месяца.
 */
async function basisWidget(db: Db, registerId: string): Promise<WidgetData> {
  const reg = await loadRegister(db, registerId);
  const fields = reg.fields.filter((f) => !f.archived && isBasisRule(f.calcRule));
  if (reg.archived || !fields.length) throw notFound('Виджет');
  const today = todayIso();
  const sources = await loadBasisSources(db, reg, null);
  const rows = await db.$queryRaw<{ id: string; values: Values }[]>`
    SELECT r.id::text, r."values" FROM register_records r WHERE ${baseSql(reg.id)} AND NOT ${closedSql(reg)}`;
  const state = (f: FieldMeta, r: { id: string; values: Values }) => {
    const rule = f.calcRule;
    return isBasisRule(rule) ? basisOf(rule, r.id, r.values, sources.get(rule.sourceRegisterId) ?? [], today).state : 'closed';
  };
  const total = rows.filter((r) => fields.some((f) => NO_BASIS.includes(state(f, r)))).length;
  const filterOf = (f: FieldMeta, values: string[]): RecordFilter => ({ state: 'open', field: { fieldId: f.id, values } });
  const stats: WidgetStat[] = fields.map((f) => ({
    label: f.label, value: rows.filter((r) => NO_BASIS.includes(state(f, r))).length, tone: 'crit', link: registerLink(reg.id, filterOf(f, NO_BASIS)),
  }));
  const rule = fields[0]?.calcRule;
  if (isBasisRule(rule) && rule.untilFieldId) {
    const src = await loadRegister(db, rule.sourceRegisterId);
    const [y, m] = today.split('-').map(Number) as [number, number];
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const filter: RecordFilter = { state: 'open', date: { fieldId: rule.untilFieldId, from: today, to: monthEnd } };
    stats.push({ label: `«${src.name}»: истекают в этом месяце`, value: await countRecords(db, src, filter), tone: 'high', link: registerLink(src.id, filter) });
  }
  const first = fields[0] as FieldMeta;
  return {
    key: `basis:${reg.id}`, title: 'Доступ без основания', kind: 'basis', source: reg.name, registerId: reg.id,
    link: registerLink(reg.id, filterOf(first, NO_BASIS)), total, rows: [], stats, items: [],
  };
}

/** Тон строки по системному значению критичности уязвимости (как цвета в прототипе). */
const CRIT_TONE: Record<string, Tone> = { critical: 'crit', high: 'high', medium: 'med', low: 'low' };

async function distribution(db: Db, reg: RegisterDef, f: FieldMeta): Promise<Pick<WidgetData, 'rows' | 'total'>> {
  const counts = await db.$queryRaw<{ key: string | null; n: bigint }[]>`
    SELECT ${fieldValueSql(f)} AS key, count(*) AS n FROM register_records r WHERE ${baseSql(reg.id)} GROUP BY 1`;
  const byKey = new Map(counts.map((c) => [c.key, Number(c.n)]));
  const link = (value: string) => registerLink(reg.id, { field: { fieldId: f.id, values: [value] } });
  let rows: WidgetRow[];
  if (f.type === 'user') {
    const users = await loadUsers(db, counts.map((c) => c.key).filter((k): k is string => !!k));
    rows = [...users.values()].map((u) => ({ label: u.fullName, count: byKey.get(u.id) ?? 0, link: link(u.id), tone: null }))
      .sort((a, b) => b.count - a.count);
  } else if (f.type === 'select' || f.type === 'catalog' || f.type === 'decision') {
    rows = f.options
      .filter((o) => !o.archived || byKey.has(o.id))
      .map((o) => ({ label: o.label, count: byKey.get(o.id) ?? 0, link: link(o.id), tone: (o.systemKey && CRIT_TONE[o.systemKey]) || null }));
  } else if (f.type === 'text') {
    return textDistribution(reg, f, counts);
  } else {
    rows = [];
  }
  const empty = byKey.get(null) ?? 0;
  if (empty) rows.push({ label: 'Не заполнено', count: empty, link: link(EMPTY_VALUE), tone: 'muted' });
  return { rows, total: counts.reduce((s, c) => s + Number(c.n), 0) };
}

/**
 * Текстовое измерение (1.8.0, docs/specs/awareness.md, 7.1): 12 самых частых значений после нормализации, подпись — самое
 * частое написание; затем «Остальные» и «Не заполнено». Полоса ведёт в список с фильтром f= по тексту — те же числа.
 */
function textDistribution(reg: RegisterDef, f: FieldMeta, counts: { key: string | null; n: bigint }[]): Pick<WidgetData, 'rows' | 'total'> {
  const filled = counts.filter((c): c is { key: string; n: bigint } => c.key !== null).map((c) => ({ value: c.key, count: Number(c.n) }));
  const { rows: top, others, othersValues } = textDimensionRows(filled);
  const rows: WidgetRow[] = top.map((r) => ({ label: r.label, count: r.count, link: registerLink(reg.id, { text: { fieldId: f.id, value: r.key } }), tone: null }));
  if (others) rows.push({ label: `Остальные: ${othersValues}`, count: others, link: null, tone: 'muted' });
  const total = counts.reduce((s, c) => s + Number(c.n), 0);
  const empty = total - top.reduce((s, r) => s + r.count, 0) - others;
  if (empty) rows.push({ label: 'Не заполнено', count: empty, link: registerLink(reg.id, { text: { fieldId: f.id, value: null } }), tone: 'muted' });
  return { rows, total };
}

async function metric(db: Db, reg: RegisterDef, f: FieldMeta): Promise<WidgetStat[]> {
  const [r] = await db.$queryRaw<{ avg: number | null; max: number | null; n: bigint }[]>`
    SELECT avg((r."values" ->> ${f.id})::numeric)::float8 AS avg, max((r."values" ->> ${f.id})::numeric)::float8 AS max, count(*) AS n
    FROM register_records r WHERE ${baseSql(reg.id)} AND jsonb_typeof(r."values" -> ${f.id}) = 'number'`;
  return [
    { label: 'Среднее', value: r?.avg === null || r?.avg === undefined ? null : Math.round(r.avg * 10) / 10, tone: null, link: null },
    { label: 'Максимум', value: r?.max ?? null, tone: null, link: null },
    { label: 'Записей', value: Number(r?.n ?? 0), tone: null, link: null },
  ];
}

/** Восемь недель, последняя заканчивается сегодня (как в прототипе). */
async function timeline(db: Db, reg: RegisterDef, f: FieldMeta, today: string): Promise<WidgetRow[]> {
  const weeks = Array.from({ length: 8 }, (_, k) => {
    const i = 7 - k;
    return { from: addDaysIso(today, -7 * i - 6), to: addDaysIso(today, -7 * i), current: i === 0 };
  });
  return Promise.all(weeks.map(async (w) => {
    const filter: RecordFilter = { date: { fieldId: f.id, from: w.from, to: w.to } };
    return {
      label: w.current ? 'тек.' : formatDateRu(w.from).slice(0, 5),
      count: await countRecords(db, reg, filter),
      link: registerLink(reg.id, filter),
      tone: w.current ? 'accent' as const : null,
    };
  }));
}

const DEADLINE_TOP = 6;

async function deadline(db: Db, reg: RegisterDef, today: string): Promise<Pick<WidgetData, 'stats' | 'items'>> {
  const dl = deadlineField(reg);
  if (!dl) return { stats: [], items: [] };
  const rows = await db.$queryRaw<{ id: string; number: number; values: Values }[]>`
    SELECT r.id, r.number, r."values" FROM register_records r WHERE ${baseSql(reg.id)}`;
  const calendar = await calendarFor(db, reg);
  const title = reg.fields.find((f) => f.isTitle);
  const st = rows.map((r) => ({ r, d: deadlineState(dateOf(reg, dl, r.values, calendar), isClosed(reg, r.values), today) }));
  const n = (s: string) => st.filter((x) => x.d.state === s).length;
  const urgent = st.filter((x) => x.d.state === 'overdue' || x.d.state === 'soon')
    .sort((a, b) => (a.d.date ?? '').localeCompare(b.d.date ?? '') || a.r.number - b.r.number)
    .slice(0, DEADLINE_TOP);
  const statLink = (s: 'overdue' | 'soon' | 'ok') => registerLink(reg.id, { deadline: [s] });
  return {
    stats: [
      { label: 'Просрочено', value: n('overdue'), tone: 'crit', link: statLink('overdue') },
      { label: '≤ 7 дней', value: n('soon'), tone: 'high', link: statLink('soon') },
      { label: 'В срок', value: n('ok'), tone: null, link: statLink('ok') },
    ],
    items: urgent.map(({ r, d }) => ({
      id: r.id,
      title: (title && typeof r.values[title.id] === 'string' ? String(r.values[title.id]) : '') || `Запись #${r.number}`,
      sub: `#${r.number}`,
      date: d.date,
      days: d.daysLeft,
      link: `/registers?record=${r.id}#${reg.id}/records`,
    })),
  };
}

async function fieldWidget(db: Db, fieldId: string): Promise<WidgetData> {
  const row = await db.registerField.findFirst({
    where: { id: fieldId, deletedAt: null, archivedAt: null, analyticsRole: { not: null }, register: { archivedAt: null } },
    select: { registerId: true },
  });
  if (!row) throw notFound('Виджет');
  const reg = await loadRegister(db, row.registerId);
  const f = reg.fields.find((x) => x.id === fieldId) as FieldMeta;
  const kind = KIND_OF_ROLE[f.analyticsRole as string] ?? 'distribution';
  const today = todayIso();
  const base: WidgetData = {
    key: `field:${f.id}`, title: fieldTitle(f), kind, source: reg.name, registerId: reg.id,
    link: registerLink(reg.id), total: null, rows: [], stats: [], items: [],
  };
  if (kind === 'distribution') return { ...base, ...(await distribution(db, reg, f)) };
  if (kind === 'metric') return { ...base, stats: await metric(db, reg, f) };
  if (kind === 'timeline') return { ...base, rows: await timeline(db, reg, f, today) };
  return { ...base, ...(await deadline(db, reg, today)) };
}

async function tasksByCategory(db: Db): Promise<WidgetRow[]> {
  const groups = await db.task.groupBy({
    by: ['categoryId'], where: { deletedAt: null, archivedAt: null, completedAt: null }, _count: { _all: true },
  });
  const items = await db.catalogItem.findMany({
    where: { id: { in: groups.map((g) => g.categoryId) } },
    select: { id: true, value: true, color: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { value: 'asc' }],
  });
  const count = new Map(groups.map((g) => [g.categoryId, g._count._all]));
  return items.map((c) => ({ label: c.value, count: count.get(c.id) ?? 0, link: `/tasks?category=${c.id}`, tone: (c.color as Tone | null) ?? null }));
}

const DOC_TONES: Partial<Record<DocStatus, Tone>> = { approved: 'low', in_review: 'high', review_overdue: 'crit', in_approval: 'accent' };
const DOC_ORDER: DocStatus[] = ['approved', 'in_review', 'review_overdue', 'in_approval', 'draft'];

async function documentsByStatus(db: Db): Promise<WidgetRow[]> {
  return Promise.all(DOC_ORDER.map(async (status) => ({
    label: DOC_STATUS_NAMES[status],
    count: (await listDocuments(db, DEPARTMENT_VIEW, { archived: false, status, limit: 1 })).total,
    link: `/documents?filter=${status}`,
    tone: DOC_TONES[status] ?? null,
  })));
}

const EVIDENCE_TONES: Partial<Record<EvidenceState, Tone>> = { accepted: 'low', expiring: 'high', expired: 'crit', rejected: 'crit' };

async function evidenceByState(db: Db): Promise<WidgetRow[]> {
  const { counts } = await listEvidence(db, { archived: false, limit: 1 });
  return EVIDENCE_STATES.map((s) => ({ label: EVIDENCE_STATE_NAMES[s], count: counts[s], link: `/evidence?filter=${s}`, tone: EVIDENCE_TONES[s] ?? null }));
}

/** Данные одного виджета по ключу (field:<id>, tasks.categories, documents.status, evidence.state). */
export async function widgetData(db: Db, key: string): Promise<WidgetData> {
  const fieldId = /^field:([0-9a-f-]{36})$/i.exec(key)?.[1];
  if (fieldId) return fieldWidget(db, fieldId);
  const basisReg = /^basis:([0-9a-f-]{36})$/i.exec(key)?.[1];
  if (basisReg) return basisWidget(db, basisReg);
  const fixed = FIXED.find((w) => w.key === key);
  if (!fixed) throw notFound('Виджет');
  const rows = key === 'tasks.categories' ? await tasksByCategory(db) : key === 'documents.status' ? await documentsByStatus(db) : await evidenceByState(db);
  const link = key === 'tasks.categories' ? '/tasks' : key === 'documents.status' ? '/documents' : '/evidence';
  return { ...fixed, link, total: rows.reduce((s, r) => s + r.count, 0), rows, stats: [], items: [] };
}

/** Дни до даты (для мониторинга): отрицательные — просрочка. */
export function daysLeft(date: string | null, today: string): number | null {
  return date ? daysBetween(today, date) : null;
}

