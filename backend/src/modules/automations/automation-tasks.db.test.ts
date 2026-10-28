import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { makeRegister, type Fixture } from '../../test/registers-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as records from '../registers/records.service.js';
import * as bulk from '../tasks/bulk.js';
import * as tasks from '../tasks/service.js';
import * as svc from './service.js';

// Релиз 1.1.0, задача 2: задачи правила при его архиве и удалении, журнал запусков, задачи без привязки, доска.

const DEC_1 = new Date('2026-12-01T06:00:00Z');

/** Правило «Статус = В работе → уведомить ответственного» и n записей, по которым оно создаёт задачи. */
async function ruleWithTasks(tx: Tx, n: number): Promise<{ x: Fixture; rule: svc.RuleDto; taskIds: string[] }> {
  const x = await makeRegister(tx);
  const owner = await makeUser(tx, ['ib_staff']);
  const rule = await svc.createRule(tx, x.actor, x.reg.id, {
    condition: { kind: 'equals', fieldId: x.f.status, optionId: x.opt('status', 'В работе') },
    action: { eventType: 'notify', recipients: [{ kind: 'field', fieldId: x.f.owner }] },
  });
  for (let i = 1; i <= n; i++) {
    await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: `Запись ${i}`, [x.f.status]: x.opt('status', 'В работе'), [x.f.owner]: owner.id } });
  }
  await svc.runAutomations(tx, { now: DEC_1, registerId: x.reg.id });
  const taskIds = (await tx.task.findMany({ where: { automationId: rule.id }, select: { id: true } })).map((t) => t.id);
  expect(taskIds).toHaveLength(n);
  return { x, rule, taskIds };
}

describe('задачи правила при архиве и удалении', () => {
  it('предпросмотр: сколько, по статусам, нетронутые; «только нетронутые» в архив, правило в архив', () =>
    inTx(async (tx) => {
      const { x, rule, taskIds } = await ruleWithTasks(tx, 3);
      // Человек прокомментировал одну задачу — она уже не нетронутая.
      await tasks.addComment(tx, x.actor, must(taskIds[0]), 'Взял в работу');
      const p = await svc.ruleTasksPreview(tx, rule.id, 'archive', true);
      expect(p).toMatchObject({ total: 3, untouched: 2, affected: 2, alreadyInState: 0 });
      expect(p.byStatus.reduce((n, s) => n + s.count, 0)).toBe(3);

      const done = await svc.setRuleArchived(tx, x.actor, rule.id, rule.version, true, {
        action: 'archive', onlyUntouched: true, expected: { total: p.total, affected: p.affected },
      });
      expect(done).toMatchObject({ archived: true, tasks: { archived: 2, deleted: 0, skipped: 1 } });
      expect(await tx.task.count({ where: { automationId: rule.id, archivedAt: { not: null } } })).toBe(2);
      expect(await tx.task.findUnique({ where: { id: must(taskIds[0]) } })).toMatchObject({ archivedAt: null });
      const summary = must(await tx.auditLog.findFirst({ where: { action: 'tasks.bulk_archive', entityId: rule.id } }));
      expect(summary.diff).toMatchObject({ after: { count: 2, onlyUntouched: true, automationId: rule.id } });
    }));

  it('удаление правила с событиями — мягкое; задачи: «оставить» по умолчанию, «удалить» — мягко; числа разошлись — 409, правило цело', () =>
    inTx(async (tx) => {
      const { x, rule, taskIds } = await ruleWithTasks(tx, 2);
      const p = await svc.ruleTasksPreview(tx, rule.id, 'delete', false);
      expect(p).toMatchObject({ total: 2, affected: 2 });
      // Без предпросмотра удалить задачи нельзя.
      await expectCode(svc.deleteRule(tx, x.actor, rule.id, rule.version, { action: 'delete' }), 'EXPECTED_REQUIRED');
      await expectCode(svc.deleteRule(tx, x.actor, rule.id, rule.version, { action: 'delete', expected: { total: 3, affected: 3 } }), 'BULK_CHANGED');
      expect(await tx.registerAutomation.findUnique({ where: { id: rule.id } })).toMatchObject({ deletedAt: null });

      const r = await svc.deleteRule(tx, x.actor, rule.id, rule.version, { action: 'delete', expected: { total: 2, affected: 2 } });
      expect(r).toEqual({ archived: 0, deleted: 2, skipped: 0 });
      expect(await tx.registerAutomation.findUnique({ where: { id: rule.id } })).toMatchObject({ deletedAt: expect.any(Date) });
      expect(await tx.task.count({ where: { id: { in: taskIds }, deletedAt: { not: null } } })).toBe(2);
      expect(await tx.auditLog.count({ where: { action: 'task.deleted', entityId: { in: taskIds } } })).toBe(2);
      // События остались и ссылаются на правило.
      expect(await tx.automationEvent.count({ where: { automationId: rule.id } })).toBe(2);
    }));

  it('«оставить» — задачи не трогаются', () =>
    inTx(async (tx) => {
      const { x, rule } = await ruleWithTasks(tx, 2);
      expect(await svc.deleteRule(tx, x.actor, rule.id, rule.version, { action: 'keep' })).toBeNull();
      expect(await tx.task.count({ where: { automationId: rule.id, deletedAt: null, archivedAt: null } })).toBe(2);
    }));
});

describe('журнал запусков', () => {
  it('прогон пишется с итогом и автором; очистка «старше N дней» и «всё» — с записью в журнале аудита', () =>
    inTx(async (tx) => {
      const { x } = await ruleWithTasks(tx, 1);
      await svc.runAutomations(tx, { now: DEC_1, registerId: x.reg.id, trigger: 'manual', actorId: x.actor.id });
      const list = await svc.listRuns(tx, x.reg.id, { limit: 10 });
      const mine = list.items.filter((r) => r.registerId === x.reg.id);
      expect(mine).toHaveLength(2);
      const manual = must(mine.find((r) => r.trigger === 'manual'));
      expect(manual).toMatchObject({ rules: 1, checked: 1, eventsCreated: 0, error: null, actor: expect.any(String) });
      expect(manual.finishedAt).not.toBeNull();
      expect(mine.find((r) => r.trigger === 'schedule')).toMatchObject({ eventsCreated: 1, tasksCreated: 1 });

      // Старая строка (40 дней назад) и свежие: «старше 30 дней» удаляет только старую.
      await tx.automationRun.create({ data: { registerId: x.reg.id, trigger: 'schedule', startedAt: new Date(Date.now() - 40 * 86_400_000) } });
      const old = await svc.clearRuns(tx, x.actor, x.reg.id, 30);
      expect(old.deleted).toBeGreaterThanOrEqual(1);
      expect((await svc.listRuns(tx, x.reg.id, { limit: 10 })).items.filter((r) => r.registerId === x.reg.id)).toHaveLength(2);
      await svc.clearRuns(tx, x.actor, x.reg.id, null);
      expect(await tx.automationRun.count({ where: { registerId: x.reg.id } })).toBe(0);
      const audit = must(await tx.auditLog.findFirst({ where: { action: 'automation.runs_cleared', entityId: x.reg.id }, orderBy: { id: 'desc' } }));
      expect(audit.diff).toMatchObject({ after: { olderThanDays: null } });
      // События не тронуты: повторный прогон задач не дублирует.
      expect((await svc.runAutomations(tx, { now: DEC_1, registerId: x.reg.id })).created).toBe(0);
    }));
});

describe('задачи без привязки', () => {
  it('база не допускает задачу автоматизации без правила (tasks_automation_check) — блок всегда пуст и скрыт', () =>
    inTx(async (tx) => {
      const { x, taskIds } = await ruleWithTasks(tx, 2);
      expect(await svc.unlinkedTasksPreview(tx, x.reg.id)).toEqual({ total: 0, byRule: [] });
      // Отвязать задачу нельзя: CHECK ("source" = 'automation') = ("automation_id" IS NOT NULL), с этапа 5.
      await expect(tx.$executeRaw`SAVEPOINT unlink`.then(() => tx.task.updateMany({ where: { id: { in: taskIds } }, data: { automationId: null } })))
        .rejects.toThrow(/tasks_automation_check/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT unlink`;
      expect(await svc.linkUnlinkedTasks(tx, x.actor, x.reg.id, { total: 0 })).toEqual({ linked: 0 });
      await expectCode(svc.linkUnlinkedTasks(tx, x.actor, x.reg.id, { total: 1 }), 'BULK_CHANGED');
    }));
});

describe('доска задач: выбранные и фильтр по правилу', () => {
  it('фильтр automationId и счётчики; «в архив» — ib.work, «удалить» — tasks.delete', () =>
    inTx(async (tx) => {
      const { x, rule, taskIds } = await ruleWithTasks(tx, 3);
      const page = await tasks.listTasks(tx, { archived: false, automationId: rule.id, limit: 100 });
      expect(page.items.map((t) => t.id).sort()).toEqual([...taskIds].sort());
      expect(page.automations).toContainEqual({ automationId: rule.id, count: 3 });

      const sel = { ids: taskIds.slice(0, 2) };
      const p = await bulk.previewTaskBulk(tx, 'archive', sel);
      expect(await bulk.applyTaskBulk(tx, x.actor, 'archive', sel, { total: p.total, affected: p.affected }, { label: 'тест', entity: 'task', entityId: 'board' }))
        .toEqual({ archived: 2, deleted: 0, skipped: 0 });

      const PASSWORD = 'Http-Tasks-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const admin = await makeUser(tx, ['super_admin', 'ib_staff'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const S = await login(staff.login);
      const A = await login(admin.login);
      const one = { ids: [must(taskIds[2])] };
      expect((await app.inject({ method: 'POST', url: '/api/v1/tasks/bulk-delete/preview', headers: { cookie: S }, payload: one })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/tasks/bulk-archive/preview', headers: { cookie: S }, payload: one })).statusCode).toBe(200);
      const pd = (await app.inject({ method: 'POST', url: '/api/v1/tasks/bulk-delete/preview', headers: { cookie: A }, payload: one })).json();
      const applied = await app.inject({ method: 'POST', url: '/api/v1/tasks/bulk-delete/apply', headers: { cookie: A }, payload: { ...one, expected: { total: pd.total, affected: pd.affected } } });
      expect(applied.json()).toEqual({ archived: 0, deleted: 1, skipped: 0 });
      // Удалить задачи правила при удалении правила — тоже только с tasks.delete.
      const listed = await app.inject({ url: `/api/v1/tasks?automationId=${rule.id}&archived=true`, headers: { cookie: S } });
      expect(listed.json().automations[0]).toMatchObject({ automationId: rule.id, count: 2 });
      expect(listed.json().automations[0].label).toContain(x.reg.name);
    }));
});
