// Цепочки задач (релиз 1.7.0, ADR-0035): видимость, состав и счётчики, права, закрытие и повторное открытие,
// привязка выполненных и архивных, отвязка, перенос, мягкое удаление, журнал; процесс задач не меняется.
// Заголовки и люди — вымышленные. Каждый тест — в транзакции с откатом.
import { describe, expect, it } from 'vitest';
import type { User } from '../../generated/prisma/client.js';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { attentionOf } from '../attention/service.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as chains from './chains.js';
import { statusIdOf } from './flow.js';
import * as svc from './service.js';

const PASSWORD = 'Chains-Test-2026-Zq';

async function setup(tx: Tx) {
  const hash = await argon2Hasher.hash(PASSWORD);
  const author = await makeUser(tx, ['ib_staff'], { fullName: 'Иванов И.И.', passwordHash: hash });
  const other = await makeUser(tx, ['ib_staff'], { fullName: 'Петров П.П.', passwordHash: hash });
  const head = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Сидорова С.С.', passwordHash: hash });
  const reader = await makeUser(tx, ['doc_reader'], { fullName: 'Читатель Тестов', passwordHash: hash });
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  const a = { author: await actorFor(tx, author.id), other: await actorFor(tx, other.id), head: await actorFor(tx, head.id), reader: await actorFor(tx, reader.id) };
  const task = (title: string, extra: Partial<svc.NewTaskInput> = {}) => svc.createTask(tx, a.author, { title, categoryId: project.id, ...extra });
  return { author, other, head, reader, project, a, task };
}

/** Выполнить или отправить в архив напрямую: процесс здесь не проверяется. */
async function markDone(tx: Tx, id: string) {
  await tx.task.update({ where: { id }, data: { statusId: await statusIdOf(tx, 'done'), completedAt: new Date(), version: { increment: 1 } } });
}
const ref = async (tx: Tx, id: string) => ({ id, version: (await tx.task.findUniqueOrThrow({ where: { id } })).version });
const chainHistory = (tx: Tx, id: string) => tx.auditLog.findMany({ where: { entity: 'task_chain', entityId: id }, orderBy: { id: 'asc' }, select: { action: true, diff: true } });
const taskActions = async (tx: Tx, id: string) => (await tx.auditLog.findMany({ where: { entity: 'task', entityId: id }, orderBy: { id: 'asc' }, select: { action: true } })).map((r) => r.action);

describe('цепочки задач (1.7.0)', () => {
  it('видимость: сотрудник ИБ видит цепочку и счётчики, без ib.work — ничего; удалённые задачи не считаются', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('RE: Тестовая тема');
      const t2 = await x.task('FW: Тестовая тема');
      const t3 = await x.task('Тестовая тема');
      const c = await chains.createChain(tx, x.a.author, { title: 'Тестовая тема', tasks: [await ref(tx, t1.id), await ref(tx, t2.id), await ref(tx, t3.id)] });
      expect(c.counts).toEqual({ total: 3, done: 0 });

      await svc.deleteTask(tx, x.a.head, t3.id, (await ref(tx, t3.id)).version);
      const seen = await chains.getChain(tx, x.a.other, c.id);
      expect(seen.counts).toEqual({ total: 2, done: 0 });
      expect(seen.tasks.map((t) => t.id)).toEqual([t1.id, t2.id]);
      expect((await chains.listChains(tx, x.a.other, { limit: 50 })).items.find((i) => i.id === c.id)?.counts.total).toBe(2);

      // Без ib.work: ни списка, ни цепочки.
      expect((await chains.listChains(tx, x.a.reader, { limit: 50 })).items).toEqual([]);
      await expectCode(chains.getChain(tx, x.a.reader, c.id), 'NOT_FOUND');

      // Все задачи удалены — цепочки не видно никому.
      await svc.deleteTask(tx, x.a.head, t1.id, (await ref(tx, t1.id)).version);
      await svc.deleteTask(tx, x.a.head, t2.id, (await ref(tx, t2.id)).version);
      await expectCode(chains.getChain(tx, x.a.author, c.id), 'NOT_FOUND');
      expect((await chains.listChains(tx, x.a.author, { limit: 50 })).items.some((i) => i.id === c.id)).toBe(false);
    }));

  it('выполненные и архивные задачи привязываются, остаются в хронологии и счётчике; привязка меняет только chain_id', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('RE: Тестовая тема', { assigneeId: x.author.id });
      const t2 = await x.task('Тестовая тема');
      await markDone(tx, t1.id);
      await svc.setTaskArchived(tx, x.a.author, t2.id, (await ref(tx, t2.id)).version, true);
      const before = await tx.task.findUniqueOrThrow({ where: { id: t2.id } });

      const c = await chains.createChain(tx, x.a.other, { title: chains.chainTitleFrom('RE: Тестовая тема'), tasks: [await ref(tx, t1.id), await ref(tx, t2.id)] });
      expect(c.title).toBe('Тестовая тема');
      expect(c.counts).toEqual({ total: 2, done: 1 });
      expect(c.tasks.map((t) => [t.id, t.archived, !!t.completedAt])).toEqual([[t1.id, false, true], [t2.id, true, false]]);

      const after = await tx.task.findUniqueOrThrow({ where: { id: t2.id } });
      expect([after.statusId, after.archivedAt?.getTime(), after.assigneeId, after.version]).toEqual([before.statusId, before.archivedAt?.getTime(), before.assigneeId, before.version + 1]);
      expect(after.chainId).toBe(c.id);
      expect(await taskActions(tx, t2.id)).toContain('task.chain_linked');
      // История задачи — из журнала: строка «Цепочка: — → «Тестовая тема»».
      const hist = await svc.taskHistory(tx, t2.id);
      expect(hist[0]?.changes).toEqual([{ label: 'Цепочка', from: '—', to: `«Тестовая тема» (#${c.number})` }]);

      await markDone(tx, t2.id);
      expect((await chains.getChain(tx, x.a.author, c.id)).allDone).toBe(true);
    }));

  it('права: править, закрывать, удалять — создатель, ответственный, tasks.assign; другой сотрудник — 403; привязать может любой', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('Тестовая тема');
      const c = await chains.createChain(tx, x.a.author, { title: 'Тестовая тема', tasks: [await ref(tx, t1.id)] });
      expect((await chains.getChain(tx, x.a.other, c.id)).canManage).toBe(false);
      await expectCode(chains.updateChain(tx, x.a.other, c.id, { version: c.version, title: 'Чужая правка' }), 'CHAIN_FORBIDDEN');
      await expectCode(chains.closeChain(tx, x.a.other, c.id, c.version), 'CHAIN_FORBIDDEN');
      await expectCode(chains.deleteChain(tx, x.a.other, c.id, c.version), 'CHAIN_FORBIDDEN');

      // Ответственный — может; начальник ИБ (tasks.assign) — может.
      let cur = await chains.updateChain(tx, x.a.author, c.id, { version: c.version, ownerId: x.other.id, dueDate: '2026-12-01', summary: 'Итог обсуждения' });
      expect([cur.owner?.id, cur.dueDate, cur.summary]).toEqual([x.other.id, '2026-12-01', 'Итог обсуждения']);
      cur = await chains.updateChain(tx, x.a.other, c.id, { version: cur.version, title: 'RE: Тестовая тема — этап 2' });
      expect((await tx.taskChain.findUniqueOrThrow({ where: { id: c.id } })).titleKey).toBe('тестовая тема — этап 2');
      cur = await chains.closeChain(tx, x.a.head, c.id, cur.version);
      expect(cur.status).toBe('closed');

      // Привязать к открытой может любой сотрудник ИБ.
      cur = await chains.reopenChain(tx, x.a.head, c.id, cur.version);
      const t2 = await svc.createTask(tx, x.a.other, { title: 'RE: Тестовая тема', categoryId: x.project.id });
      cur = await chains.attachTasks(tx, x.a.other, c.id, { tasks: [await ref(tx, t2.id)] });
      expect(cur.counts.total).toBe(2);
      // Ответственный — только активный сотрудник ИБ.
      await expectCode(chains.updateChain(tx, x.a.author, c.id, { version: cur.version, ownerId: x.reader.id }), 'BAD_ASSIGNEE');
    }));

  it('закрытие с незавершёнными задачами — не блокируется, число в журнале; закрытая не принимает задачи без «Вернуть в работу»', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('Тестовая тема');
      const t2 = await x.task('RE: Тестовая тема');
      await markDone(tx, t1.id);
      let c = await chains.createChain(tx, x.a.author, { title: 'Тестовая тема', tasks: [await ref(tx, t1.id)] });
      c = await chains.attachTasks(tx, x.a.author, c.id, { tasks: [await ref(tx, t2.id)] });
      c = await chains.closeChain(tx, x.a.author, c.id, c.version);
      expect([c.status, c.closedAt !== null]).toEqual(['closed', true]);
      const log = await chainHistory(tx, c.id);
      expect(log.map((l) => l.action)).toEqual(['task_chain.created', 'task_chain.closed']);
      expect((log[1]?.diff as { after: { openTasks: number } }).after.openTasks).toBe(1);

      const t3 = await x.task('Отв: Тестовая тема');
      await expectCode(chains.attachTasks(tx, x.a.author, c.id, { tasks: [await ref(tx, t3.id)] }), 'CHAIN_CLOSED');
      // «Вернуть в работу и добавить»: без прав на цепочку — 403, с правами — открыта и задача добавлена.
      await expectCode(chains.attachTasks(tx, x.a.other, c.id, { tasks: [await ref(tx, t3.id)], reopen: true }), 'CHAIN_FORBIDDEN');
      c = await chains.attachTasks(tx, x.a.author, c.id, { tasks: [await ref(tx, t3.id)], reopen: true });
      expect([c.status, c.closedAt, c.counts.total]).toEqual(['open', null, 3]);
      expect((await chainHistory(tx, c.id)).map((l) => l.action)).toEqual(['task_chain.created', 'task_chain.closed', 'task_chain.reopened']);
    }));

  it('отвязка и перенос: журнал у задачи; повторная привязка и чужая цепочка — 409; устаревшая версия — 409', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('Тестовая тема');
      const t2 = await x.task('Вторая тестовая тема');
      const c1 = await chains.createChain(tx, x.a.author, { title: 'Тестовая тема', tasks: [await ref(tx, t1.id)] });
      const c2 = await chains.createChain(tx, x.a.author, { title: 'Вторая тестовая тема', tasks: [await ref(tx, t2.id)] });

      await expectCode(chains.attachTasks(tx, x.a.author, c1.id, { tasks: [await ref(tx, t1.id)] }), 'TASK_IN_CHAIN');
      await expectCode(chains.attachTasks(tx, x.a.author, c1.id, { tasks: [await ref(tx, t2.id)] }), 'TASK_IN_OTHER_CHAIN');
      await expectCode(chains.attachTasks(tx, x.a.author, c1.id, { tasks: [{ id: t2.id, version: 1 }] }), 'VERSION_CONFLICT');

      const moved = await chains.moveTask(tx, x.a.other, t2.id, { version: (await ref(tx, t2.id)).version, toChainId: c1.id });
      expect(moved.tasks.map((t) => t.id)).toEqual([t1.id, t2.id]);
      await chains.detachTask(tx, x.a.other, c1.id, t1.id, (await ref(tx, t1.id)).version);
      await expectCode(chains.detachTask(tx, x.a.other, c2.id, t1.id, (await ref(tx, t1.id)).version), 'TASK_NOT_IN_CHAIN');
      expect((await tx.task.findUniqueOrThrow({ where: { id: t1.id } })).chainId).toBeNull();
      expect(await taskActions(tx, t1.id)).toEqual(['task.created', 'task.chain_linked', 'task.chain_unlinked']);
      expect(await taskActions(tx, t2.id)).toEqual(['task.created', 'task.chain_linked', 'task.chain_moved']);
      // Задача в архиве тоже отвязывается.
      await svc.setTaskArchived(tx, x.a.author, t2.id, (await ref(tx, t2.id)).version, true);
      await chains.detachTask(tx, x.a.author, c1.id, t2.id, (await ref(tx, t2.id)).version);
      expect((await tx.task.findUniqueOrThrow({ where: { id: t2.id } })).archivedAt).not.toBeNull();
    }));

  it('мягкое удаление: задачи отвязаны и остаются, журнал со списком; цепочки нет в списке', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('Тестовая тема');
      const t2 = await x.task('RE: Тестовая тема');
      const c = await chains.createChain(tx, x.a.author, { title: 'Тестовая тема', tasks: [await ref(tx, t1.id), await ref(tx, t2.id)] });
      await chains.deleteChain(tx, x.a.author, c.id, c.version);
      const row = await tx.taskChain.findUniqueOrThrow({ where: { id: c.id } });
      expect(row.deletedAt).not.toBeNull();
      const tasks = await tx.task.findMany({ where: { id: { in: [t1.id, t2.id] } } });
      expect(tasks.map((t) => [t.chainId, t.deletedAt])).toEqual([[null, null], [null, null]]);
      const del = must((await chainHistory(tx, c.id)).find((l) => l.action === 'task_chain.deleted'), 'запись об удалении');
      expect(new Set((del.diff as { after: { unlinked: number[] } }).after.unlinked)).toEqual(new Set([t1.number, t2.number]));
      expect(await taskActions(tx, t1.id)).toEqual(['task.created', 'task.chain_linked', 'task.chain_unlinked']);
      await expectCode(chains.getChain(tx, x.a.author, c.id), 'NOT_FOUND');
      expect((await svc.getTask(tx, t1.id)).chain).toBeNull();
    }));

  it('процесс не меняется: в цепочке те же REVIEW_REQUIRED и NO_REVIEWER; индикаторы и уведомления не трогаются', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      await tx.user.update({ where: { id: x.author.id }, data: { managerId: x.head.id } });
      const t1 = await svc.createTask(tx, x.a.head, { title: 'Тестовая тема', categoryId: x.project.id, assigneeId: x.author.id });
      const t2 = await svc.createTask(tx, x.a.head, { title: 'RE: Тестовая тема', categoryId: x.project.id, assigneeId: x.other.id });
      const before = { attention: await attentionOf(tx, x.a.head), notes: await tx.notification.count() };
      await chains.createChain(tx, x.a.author, { title: 'Тестовая тема', tasks: [await ref(tx, t1.id), await ref(tx, t2.id)] });
      expect(await attentionOf(tx, x.a.head)).toEqual(before.attention);
      expect(await tx.notification.count()).toBe(before.notes);

      const done = await statusIdOf(tx, 'done');
      const review = await statusIdOf(tx, 'review');
      await expectCode(svc.updateTask(tx, x.a.head, t1.id, { version: (await ref(tx, t1.id)).version, statusId: done, comment: 'Закрываю' }), 'REVIEW_REQUIRED');
      await expectCode(svc.updateTask(tx, x.a.head, t2.id, { version: (await ref(tx, t2.id)).version, statusId: review, comment: 'На проверку' }), 'NO_REVIEWER');
    }));

  it('по HTTP: маршруты цепочек — только ib.work (403 без права); создание и чтение', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('RE: Тестовая тема');
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: false,
      });
      const login = async (u: User) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u.login, password: PASSWORD } });
        expect(res.statusCode).toBe(200);
        return { cookie: `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`, origin: TEST_PORTAL_URL };
      };
      const A = await login(x.author);
      const R = await login(x.reader);
      const created = await app.inject({ method: 'POST', url: '/api/v1/task-chains', headers: A, payload: { title: 'Тестовая тема', tasks: [await ref(tx, t1.id)] } });
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { id: string }).id;
      expect((await app.inject({ url: `/api/v1/task-chains/${id}`, headers: A })).statusCode).toBe(200);
      const list = await app.inject({ url: '/api/v1/tasks?chainId=' + id, headers: A });
      expect((list.json() as { items: { id: string; chain: { id: string } | null }[] }).items.map((t) => [t.id, t.chain?.id])).toEqual([[t1.id, id]]);
      for (const [method, url] of [['GET', '/api/v1/task-chains'], ['GET', `/api/v1/task-chains/${id}`], ['POST', `/api/v1/task-chains/${id}/close`]] as const) {
        const res = await app.inject({ method, url, headers: R, ...(method === 'POST' ? { payload: { version: 1 } } : {}) });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
      await app.close();
    }));
});
