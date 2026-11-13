// «Найти цепочки среди старых задач» → «Системные цепочки реестров» (1.14.0, ADR-0053). Миграция и seed задачи не
// трогают: автозадачи, созданные до 1.14.0, собираются по кнопке, после предпросмотра и подтверждения. Берутся задачи
// source = 'automation' без цепочки — в том числе выполненные и архивные — кроме тех, цепочку которых хоть раз менял
// человек (manuallyChained). Источник — по ссылкам задачи (sourcesOfRecords, sourceOfRegister), не по заголовку;
// не определён — задача в списке «Источник не определён» и не трогается. Повторный запуск ничего не находит.
// Право — как у кнопки 1.7.0: tasks.assign или settings.manage.
import { createHash } from 'node:crypto';
import { chunks } from '../../lib/bulk.js';
import { BULK_TX, withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { auditSettings } from '../settings/common.js';
import { assertAllowed } from './chain-discover.js';
import { visibleTasksWhere } from './chains.js';
import type { TaskActor } from './flow.js';
import {
  ensureSystemChain, linkedAuditRows, manuallyChained, sourceOfRegister, sourcesOfRecords, systemChainTitle, writeAudit,
  type ChainSource, type NoSourceReason, type SourceOf,
} from './system-chains.js';

/** Задач в списке «Источник не определён» (остальные — числом). */
export const UNKNOWN_LIST_MAX = 500;

export const NO_SOURCE_LABEL: Record<NoSourceReason, string> = {
  vuln_without_node: 'запись «Уязвимостей» без узла',
  vuln_digest: 'сводная задача по реестру «Уязвимости» — группы нет',
  no_link: 'нет ссылки на запись или правило',
};

export interface SystemDiscoverGroup {
  sourceType: ChainSource['type'];
  sourceId: string;
  title: string;
  /** Уже есть системная цепочка источника — задачи добавятся в неё. */
  chain: { id: string; number: number } | null;
  tasks: number;
  completed: number;
  archived: number;
  /** sha256 отсортированных id задач: применение сверяет состав с предпросмотром. */
  fingerprint: string;
}

interface Plan {
  groups: (SystemDiscoverGroup & { source: ChainSource; members: { id: string; number: number }[] })[];
  unknown: { id: string; number: number; title: string; reason: NoSourceReason; reasonLabel: string }[];
  skippedManual: number;
}

async function buildPlan(db: Db, actor: TaskActor): Promise<Plan> {
  const rows = await db.task.findMany({
    where: { AND: [visibleTasksWhere(actor), { source: 'automation', chainId: null }] },
    select: {
      id: true, number: true, title: true, completedAt: true, archivedAt: true, recordId: true,
      automation: { select: { register: { select: { id: true, name: true, systemKey: true } } } },
    },
    orderBy: { number: 'asc' },
  });
  const manual = await manuallyChained(db, rows.map((r) => r.id));
  const tasks = rows.filter((r) => !manual.has(r.id));
  const byRecord = await sourcesOfRecords(db, tasks.flatMap((t) => (t.recordId ? [t.recordId] : [])));
  const plan: Plan = { groups: [], unknown: [], skippedManual: rows.length - tasks.length };
  const byKey = new Map<string, Plan['groups'][number]>();
  for (const t of tasks) {
    const of: SourceOf = t.recordId
      ? byRecord.get(t.recordId) ?? { source: null, reason: 'no_link' }
      : t.automation ? sourceOfRegister(t.automation.register) : { source: null, reason: 'no_link' };
    if (!of.source) {
      plan.unknown.push({ id: t.id, number: t.number, title: t.title, reason: of.reason, reasonLabel: NO_SOURCE_LABEL[of.reason] });
      continue;
    }
    const key = `${of.source.type}|${of.source.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        sourceType: of.source.type, sourceId: of.source.id, title: systemChainTitle(of.source), chain: null,
        tasks: 0, completed: 0, archived: 0, fingerprint: '', source: of.source, members: [],
      };
      byKey.set(key, g);
    }
    g.members.push({ id: t.id, number: t.number });
    g.tasks++;
    if (t.completedAt) g.completed++;
    if (t.archivedAt) g.archived++;
  }
  const existing = byKey.size
    ? await db.taskChain.findMany({
      where: { kind: 'system', deletedAt: null, OR: [...byKey.values()].map((g) => ({ sourceType: g.sourceType, sourceId: g.sourceId })) },
      select: { id: true, number: true, sourceType: true, sourceId: true },
    })
    : [];
  for (const g of byKey.values()) {
    const c = existing.find((x) => x.sourceType === g.sourceType && x.sourceId === g.sourceId);
    g.chain = c ? { id: c.id, number: c.number } : null;
    g.fingerprint = createHash('sha256').update(g.members.map((m) => m.id).sort().join(',')).digest('hex');
  }
  plan.groups = [...byKey.values()].sort((a, b) => b.tasks - a.tasks || a.title.localeCompare(b.title, 'ru'));
  return plan;
}

const publicGroup = ({ source: _s, members: _m, ...g }: Plan['groups'][number]): SystemDiscoverGroup => g;

/** Предпросмотр: какие цепочки создадутся или дополнятся, сколько задач, что не определить. Ничего не меняет. */
export async function systemDiscoverPreview(db: Db, actor: TaskActor) {
  assertAllowed(actor);
  const plan = await buildPlan(db, actor);
  return {
    groups: plan.groups.map(publicGroup),
    tasks: plan.groups.reduce((s, g) => s + g.tasks, 0),
    unknown: plan.unknown.slice(0, UNKNOWN_LIST_MAX),
    unknownTotal: plan.unknown.length,
    skippedManual: plan.skippedManual,
  };
}

export interface SystemDiscoverExpected { sourceType: string; sourceId: string; tasks: number; fingerprint: string }

/**
 * Применение всех групп предпросмотра одной транзакцией. План строится заново; не совпал с expected (группы, число
 * задач, состав) — 409 BULK_CHANGED, не применяется ничего. Журнал — на каждую задачу и итог.
 */
export async function systemDiscoverApply(db: Db, actor: TaskActor, expected: readonly SystemDiscoverExpected[]) {
  assertAllowed(actor);
  if (!expected.length) throw badRequest('NOTHING_SELECTED', 'Нечего собирать — обновите предпросмотр');
  return withTx(db, async (tx) => {
    const plan = await buildPlan(tx, actor);
    const changed = () => conflict('BULK_CHANGED', 'После предпросмотра задачи изменились. Обновите предпросмотр');
    if (plan.groups.length !== expected.length) throw changed();
    const want = new Map(expected.map((e) => [`${e.sourceType}|${e.sourceId}`, e]));
    for (const g of plan.groups) {
      const e = want.get(`${g.sourceType}|${g.sourceId}`);
      if (!e || e.tasks !== g.tasks || e.fingerprint !== g.fingerprint) throw changed();
    }
    let created = 0;
    let tasks = 0;
    for (const g of plan.groups) {
      const had = g.chain !== null;
      const chain = await ensureSystemChain(tx, g.source);
      if (!had) created++;
      for (const ids of chunks(g.members.map((m) => m.id), 1000)) {
        const res = await tx.task.updateMany({ where: { id: { in: ids }, chainId: null, deletedAt: null }, data: { chainId: chain.id, version: { increment: 1 } } });
        if (res.count !== ids.length) throw changed();
      }
      await writeAudit(tx, linkedAuditRows(g.members, chain, 'system_discover', ' (сборка старых задач)').map((r) => ({ ...r, userId: actor.id, ip: actor.ip })));
      tasks += g.members.length;
    }
    await auditSettings(tx, actor, {
      action: 'task_chain.discovered_system', entity: 'task_chain', entityId: 'discover_system',
      summary: `Системные цепочки реестров среди старых задач: создано ${created}, дополнено ${plan.groups.length - created}, задач привязано ${tasks}`,
      after: { created, attached: plan.groups.length - created, tasks, unknown: plan.unknown.length },
    });
    return { created, attached: plan.groups.length - created, tasks };
  }, BULK_TX);
}
