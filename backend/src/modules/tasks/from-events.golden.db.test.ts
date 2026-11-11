// Эталон задач из событий автоматизаций (1.13.9): после пакетной записи задачи, переходы, уведомления, комментарии,
// связи с событиями и журнал те же, что у построчной записи 1.13.7. Эталон снят на коде v1.13.7 (UPDATE_GOLDEN=1);
// id заменены именами, номера записей — от первой записи сценария. События одного прогона создаются одним запросом и
// обрабатываются в порядке случайных id, поэтому номера задач от прогона к прогону разные и при старом коде:
// задача называется «правило : запись : ответственный», списки сравниваются отсортированными.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { diskFileStore } from '../../lib/file-store.js';
import { RECIPIENTS_CATALOG, SYSTEMS_CATALOG } from '../../lib/catalogs.js';
import { inTxLong, makeUser, must, type Tx } from '../../test/db.js';
import { SAMPLE, SAMPLE_NAME, vulnRegister } from '../../test/vulns-fixture.js';
import { runAutomations } from '../automations/service.js';
import * as groups from '../vulns/groups.service.js';
import * as scan from '../vulns/scan-import.service.js';
import * as scans from '../vulns/scans.service.js';

const GOLDEN = new URL('../../../test/fixtures/automation-tasks-golden.json', import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'ibportal-golden-tasks-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function snapshot(tx: Tx, ctx: { auditFrom: bigint; taskBase: number; recordBase: number; registerId: string; names: Map<string, string> }) {
  const tasks = await tx.task.findMany({ where: { number: { gte: ctx.taskBase } }, orderBy: { number: 'asc' } });
  const names = new Map(ctx.names);
  const recs = await tx.registerRecord.findMany({ where: { registerId: ctx.registerId, number: { gte: ctx.recordBase } }, select: { id: true, number: true } });
  for (const r of recs) names.set(r.id, `rec#${r.number - ctx.recordBase}`);
  const items = await tx.catalogItem.findMany({ where: { catalogCode: { in: ['task_statuses', 'task_priorities', 'task_categories', RECIPIENTS_CATALOG, SYSTEMS_CATALOG] } }, select: { id: true, catalogCode: true, value: true } });
  for (const i of items) names.set(i.id, `${i.catalogCode}:${i.value}`);
  const rules = await tx.registerAutomation.findMany({ where: { registerId: ctx.registerId }, select: { id: true, systemKey: true } });
  for (const r of rules) names.set(r.id, `rule:${r.systemKey ?? r.id}`);
  const taskByNumber = new Map<number, string>();
  for (const t of tasks) {
    const name = `task:${names.get(t.automationId ?? '') ?? '?'}:${names.get(t.recordId ?? '') ?? '?'}:${names.get(t.assigneeId ?? '') ?? 'none'}`;
    names.set(t.id, name);
    taskByNumber.set(t.number, name);
  }
  const events = await tx.automationEvent.findMany({ where: { registerId: ctx.registerId, recordId: { in: recs.map((r) => r.id) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const eventName = (e: { automationId: string | null; recordId: string | null; triggerKey: string }) => `event:${names.get(e.automationId ?? '') ?? '?'}:${names.get(e.recordId ?? '') ?? '?'}:${e.triggerKey}`;
  for (const e of events) names.set(e.id, eventName(e));
  const ids = tasks.map((t) => t.id);
  const transitions = await tx.taskTransition.findMany({ where: { taskId: { in: ids } } });
  const notifications = await tx.notification.findMany({ where: { taskId: { in: ids } } });
  const comments = await tx.taskComment.findMany({ where: { taskId: { in: ids } } });
  const links = await tx.automationEventTask.findMany({ where: { taskId: { in: ids } } });
  const audit = await tx.auditLog.findMany({ where: { id: { gt: ctx.auditFrom }, entity: 'task' }, orderBy: { id: 'asc' } });
  // Номер задачи — после «задача»/«Задача», остальные «#N» — номера записей.
  const label = (s: string) => s.replace(UUID, (id) => names.get(id) ?? '<id>')
    .replace(/([Зз]адача) #(\d+)/g, (_m, w: string, n: string) => `${w} ${taskByNumber.get(Number(n)) ?? '?'}`)
    .replace(/#(\d+)/g, (m, n: string) => (Number(n) >= ctx.recordBase ? `#r${Number(n) - ctx.recordBase}` : m));
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string') return label(v);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, clean(val)]));
    return v;
  };
  const sortBy = <T>(rows: T[], key: (r: T) => string) => [...rows].sort((a, b) => key(a).localeCompare(key(b), 'en', { numeric: true }));
  return clean({
    tasks: sortBy(tasks.map((t) => ({
      name: label(t.id), title: t.title, description: t.description, status: t.statusId, priority: t.priorityId, category: t.categoryId,
      assignee: t.assigneeId, due: t.dueDate, source: t.source, record: t.recordId, automation: t.automationId, recipientLabel: t.recipientLabel,
    })), (x) => x.name),
    transitions: sortBy(transitions.map((x) => ({ task: label(x.taskId), from: x.fromStatusId, to: x.toStatusId, actor: x.actorId, kind: x.kind, comment: x.comment, reviewer: x.reviewerId })), (x) => x.task),
    notifications: sortBy(notifications.map((x) => ({ user: x.userId, kind: x.kind, title: x.title, body: x.body, task: label(x.taskId ?? ''), actor: x.actorId, dedupe: x.dedupeKey })), (x) => `${x.task} ${label(x.user)}`),
    comments: sortBy(comments.map((x) => ({ task: label(x.taskId), event: label(x.eventId ?? ''), author: x.authorId, body: x.body })), (x) => `${x.task} ${x.event}`),
    links: sortBy(links.map((x) => ({ event: label(x.eventId), task: label(x.taskId), action: x.action })), (x) => `${x.event} ${x.task}`),
    events: sortBy(events.map((e) => ({ name: label(e.id), status: e.status, type: e.eventType, recipients: e.recipients })), (x) => x.name),
    audit: sortBy(audit.map((a) => ({ user: a.userId, action: a.action, entity: a.entity, entityId: a.entityId, diff: a.diff })), (x) => `${label(x.entityId ?? '')} ${x.action} ${JSON.stringify(clean(x.diff))}`),
  });
}

describe('задачи из событий автоматизаций: содержимое совпадает с 1.13.7', () => {
  it('просрочка п. 7.4 на образце: задачи владельцу системы и меткам, комментарий в открытую задачу, повторный прогон', () =>
    inTxLong(async (tx) => {
      const x = await vulnRegister(tx);
      const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Эталон Владелец' });
      const dikt = await makeUser(tx, ['ib_staff'], { fullName: 'Эталон ДИКТ' });
      const names = new Map<string, string>([[x.adminId, 'actor'], [owner.id, 'user:owner'], [dikt.id, 'user:dikt'], [x.reg.id, 'register']]);
      const diktLabel = await tx.catalogItem.findUniqueOrThrow({ where: { catalogCode_systemKey: { catalogCode: RECIPIENTS_CATALOG, systemKey: 'dikt_head' } } });
      await tx.catalogItemUser.create({ data: { itemId: diktLabel.id, userId: dikt.id } });
      const system = await tx.catalogItem.create({ data: { catalogCode: SYSTEMS_CATALOG, value: 'Эталон: процессинг', ownerUserId: owner.id, sortOrder: 9999 } });
      await x.reload();
      const t = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: 'Windows' } });
      const g = await groups.createGroup(tx, x.actor, { name: 'Эталон: задачи', kind: 'service', systemTypeIds: [t.id] });
      const node = must(g.nodes[0]);
      const recordBase = (await tx.register.findUniqueOrThrow({ where: { id: x.reg.id } })).nextNumber;
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
      const a = await scan.applyNodeScan(tx, x.actor, p.id, { scanDate: '2026-01-05', systemId: system.id });
      await scans.handOverScan(tx, x.actor, a.scanId, { date: '2026-01-06' });

      // Открытая задача правила «просрочено» по первой записи у ДИКТ — событие дополнит её комментарием.
      const rule = await tx.registerAutomation.findFirstOrThrow({ where: { registerId: x.reg.id, systemKey: 'vuln.overdue_notify' } });
      const first = await tx.registerRecord.findFirstOrThrow({ where: { registerId: x.reg.id, number: recordBase } });
      const status = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_statuses', systemKey: 'assigned' } });
      const prio = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_priorities', systemKey: 'high' } });
      const cat = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', systemKey: 'register' } });
      const taskBase = (await tx.task.aggregate({ _max: { number: true } }))._max.number ?? 0;
      await tx.task.create({ data: { title: 'Эталон: открытая задача', statusId: status.id, priorityId: prio.id, categoryId: cat.id, assigneeId: dikt.id, source: 'automation', recordId: first.id, automationId: rule.id } });
      const auditFrom = (await tx.auditLog.aggregate({ _max: { id: true } }))._max.id ?? 0n;

      const run1 = await runAutomations(tx, { registerId: x.reg.id, trigger: 'manual', now: new Date('2026-11-11T08:00:00Z') });
      const run2 = await runAutomations(tx, { registerId: x.reg.id, trigger: 'manual', now: new Date('2026-11-12T08:00:00Z') });
      expect(run1.tasksCreated).toBeGreaterThan(100);
      expect(run1.tasksCommented).toBeGreaterThanOrEqual(1);

      const snap = JSON.parse(JSON.stringify(await snapshot(tx, { auditFrom, taskBase: taskBase + 1, recordBase, registerId: x.reg.id, names })));
      snap.runs = [run1, run2].map((r) => ({ created: r.created, tasksCreated: r.tasksCreated, tasksCommented: r.tasksCommented }));
      if (process.env.GOLDEN_DUMP) writeFileSync(process.env.GOLDEN_DUMP, `${JSON.stringify(snap, null, 1)}\n`);
      if (process.env.UPDATE_GOLDEN === '1') {
        writeFileSync(GOLDEN, `${JSON.stringify(snap, null, 1)}\n`);
        return;
      }
      expect(existsSync(GOLDEN), 'нет эталона test/fixtures/automation-tasks-golden.json').toBe(true);
      const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
      expect(snap.runs).toEqual(golden.runs);
      expect(snap.tasks).toEqual(golden.tasks);
      expect(snap.transitions).toEqual(golden.transitions);
      expect(snap.notifications).toEqual(golden.notifications);
      expect(snap.comments).toEqual(golden.comments);
      expect(snap.links).toEqual(golden.links);
      expect(snap.events).toEqual(golden.events);
      expect(snap.audit).toEqual(golden.audit);
    }), 300_000);
});
