// «Системные цепочки реестров» среди старых задач (1.14.0, ADR-0053): предпросмотр = применение; повторный запуск
// ничего не меняет; задачи без определимого источника перечислены и не тронуты; отвязанные человеком — пропущены;
// изменилось после предпросмотра — 409 BULK_CHANGED; право как у кнопки 1.7.0. Задачи «как до 1.14.0» создаются
// напрямую, без цепочки. Данные вымышленные (CVE-2099-…). Каждый тест — в транзакции с откатом.
import { describe, expect, it } from 'vitest';
import { seedVulnLegacy } from '../../../prisma/seed/vuln-legacy.js';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { makeRegister } from '../../test/registers-fixture.js';
import { vulnRegister } from '../../test/vulns-fixture.js';
import { createRule } from '../automations/service.js';
import * as records from '../registers/records.service.js';
import * as chains from './chains.js';
import { statusIdOf } from './flow.js';
import { systemDiscoverApply, systemDiscoverPreview } from './system-chain-discover.js';

const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Автозадача «как до 1.14.0»: source = automation, без цепочки. */
async function oldTask(tx: Tx, data: { title: string; recordId: string | null; automationId: string; done?: boolean; archived?: boolean }) {
  const [status, prio, cat] = await Promise.all([
    statusIdOf(tx, data.done ? 'done' : 'new'),
    tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_priorities', systemKey: 'normal' } }),
    tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', systemKey: 'register' } }),
  ]);
  return tx.task.create({
    data: {
      title: data.title, statusId: status, priorityId: prio.id, categoryId: cat.id, source: 'automation', recordId: data.recordId, automationId: data.automationId,
      ...(data.done ? { completedAt: new Date() } : {}), ...(data.archived ? { archivedAt: new Date() } : {}),
    },
  });
}

async function setup(tx: Tx) {
  const admin = await makeUser(tx, ['ib_staff', 'super_admin']);
  const actor = await actorFor(tx, admin.id);
  // Реестр конструктора: три задачи — открытая, выполненная, архивная.
  const name = unique('Реестр проверок');
  const x = await makeRegister(tx, name);
  const rule = await createRule(tx, x.actor, x.reg.id, {
    condition: { kind: 'equals', fieldId: x.f.status, optionId: x.opt('status', 'В работе') },
    action: { eventType: 'notify', recipients: [{ kind: 'user', userId: x.actor.id }] },
  });
  // Открытая автозадача уникальна по «правило + запись + ответственный» — у каждой своя запись.
  const rec = async (n: number) => (await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: `Запись ${n}` } })).id;
  const r1 = await oldTask(tx, { title: 'Уведомление — #1', recordId: await rec(1), automationId: rule.id });
  const r2 = await oldTask(tx, { title: 'Уведомление — #2 (было)', recordId: await rec(2), automationId: rule.id, done: true });
  const r3 = await oldTask(tx, { title: 'Уведомление — #3 (архив)', recordId: await rec(3), automationId: rule.id, archived: true });
  // Сводная задача правила по реестру — в цепочку реестра.
  const digest = await oldTask(tx, { title: 'Сводная', recordId: null, automationId: rule.id });

  // «Уязвимости»: запись «Без группы» (seed переносит), запись без узла, сводная по реестру.
  const v = await vulnRegister(tx);
  const vRule = must(await tx.registerAutomation.findFirst({ where: { registerId: v.reg.id, systemKey: 'vuln.overdue_notify' } }));
  const mk = async (cve: string) => tx.registerRecord.create({
    data: { registerId: v.reg.id, number: await records.nextNumbers(tx, v.reg.id, 1), searchText: cve.toLowerCase(), values: { [v.vf.cve.id]: cve, [v.vf.status.id]: v.opt('status', 'open') } },
  });
  const legacyRec = await mk('CVE-2099-20001');
  await seedVulnLegacy(tx);
  const noNode = await mk('CVE-2099-20002');
  const vt = await oldTask(tx, { title: 'Эскалация — CVE-2099-20001', recordId: legacyRec.id, automationId: vRule.id });
  const lost = await oldTask(tx, { title: 'Эскалация — CVE-2099-20002', recordId: noNode.id, automationId: vRule.id });
  const vDigest = await oldTask(tx, { title: 'Сводная по уязвимостям', recordId: null, automationId: vRule.id });

  // Отвязанная человеком: была в ручной цепочке, отвязана.
  const detached = await oldTask(tx, { title: 'Уведомление — #4 (отвязана)', recordId: await rec(4), automationId: rule.id });
  const manual = await chains.createChain(tx, actor, { title: unique('Ручная'), tasks: [{ id: detached.id, version: detached.version }] });
  await chains.detachTask(tx, actor, manual.id, detached.id, (await tx.task.findUniqueOrThrow({ where: { id: detached.id } })).version);

  const legacyGroup = await tx.vulnGroup.findFirstOrThrow({ where: { systemKey: { not: null } } });
  return { actor, x, name, r1, r2, r3, digest, vt, lost, vDigest, detached, legacyGroup };
}

const expectedOf = (p: Awaited<ReturnType<typeof systemDiscoverPreview>>) => p.groups.map((g) => ({ sourceType: g.sourceType, sourceId: g.sourceId, tasks: g.tasks, fingerprint: g.fingerprint }));

describe('системные цепочки реестров среди старых задач (1.14.0)', () => {
  it('предпросмотр → применение: совпадает; повторный запуск ничего не меняет; неопределимые и отвязанные не тронуты', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const p = await systemDiscoverPreview(tx, s.actor);
      const reg = must(p.groups.find((g) => g.sourceType === 'register' && g.sourceId === s.x.reg.id));
      expect(reg).toMatchObject({ title: `Реестр · ${s.name}`, chain: null, tasks: 4, completed: 1, archived: 1 });
      const vg = must(p.groups.find((g) => g.sourceType === 'vuln_group' && g.sourceId === s.legacyGroup.id));
      expect(vg).toMatchObject({ title: `Уязвимости · ${s.legacyGroup.name}`, tasks: 1 });
      expect(p.unknown.map((u) => [u.id, u.reason])).toEqual(expect.arrayContaining([[s.lost.id, 'vuln_without_node'], [s.vDigest.id, 'vuln_digest']]));
      expect(p.skippedManual).toBeGreaterThanOrEqual(1);
      expect(p.unknown.map((u) => u.id)).not.toContain(s.detached.id);

      const res = await systemDiscoverApply(tx, s.actor, expectedOf(p));
      expect(res.tasks).toBe(p.tasks);
      expect(res.created + res.attached).toBe(p.groups.length);
      const chain = must(await tx.taskChain.findFirst({ where: { kind: 'system', sourceType: 'register', sourceId: s.x.reg.id, deletedAt: null } }));
      for (const t of [s.r1, s.r2, s.r3, s.digest]) expect((await tx.task.findUniqueOrThrow({ where: { id: t.id } })).chainId).toBe(chain.id);
      for (const t of [s.lost, s.vDigest, s.detached]) expect((await tx.task.findUniqueOrThrow({ where: { id: t.id } })).chainId).toBeNull();
      const audit = must(await tx.auditLog.findFirst({ where: { action: 'task.chain_linked', entityId: s.r2.id } }));
      expect(audit.userId).toBe(s.actor.id);
      expect((audit.diff as { summary: string }).summary).toContain('автоматически (сборка старых задач)');
      expect(await tx.auditLog.count({ where: { action: 'task_chain.discovered_system', userId: s.actor.id } })).toBe(1);

      // Повторно: групп нет, неопределимые — те же.
      const again = await systemDiscoverPreview(tx, s.actor);
      expect(again.groups).toEqual([]);
      expect(again.unknown.map((u) => u.id).sort()).toEqual(p.unknown.map((u) => u.id).sort());
      await expectCode(systemDiscoverApply(tx, s.actor, expectedOf(p)), 'BULK_CHANGED');
    }));

  it('изменилось после предпросмотра — 409 BULK_CHANGED, ничего не привязано; без права — 403', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const p = await systemDiscoverPreview(tx, s.actor);
      await oldTask(tx, { title: 'Ещё одна — #2', recordId: s.r2.recordId, automationId: must(s.r2.automationId) });
      await expectCode(systemDiscoverApply(tx, s.actor, expectedOf(p)), 'BULK_CHANGED');
      expect((await tx.task.findUniqueOrThrow({ where: { id: s.r1.id } })).chainId).toBeNull();

      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      await expectCode(systemDiscoverPreview(tx, staff), 'FORBIDDEN');
    }));
});
