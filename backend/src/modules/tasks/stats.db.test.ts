// Отчёт по выполненным задачам (1.6.4): цифры, недели, сотрудники, кто закрыл; архив; по HTTP — право tasks.report.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { todayIso } from '../../lib/today.js';
import { actorFor, inTx, makeUser, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { closeTasks } from '../documents/tasks.js';
import { runAction } from './process.js';
import * as svc from './service.js';
import { taskStats, weekStart } from './stats.js';

const PASSWORD = 'Stats-Test-Pass-2026';

async function setup(tx: Tx) {
  const head = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник Отчёта' });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Исполнитель Отчёта', manager: { connect: { id: head.id } } });
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  return { head, staff, project, h: await actorFor(tx, head.id), s: await actorFor(tx, staff.id) };
}

describe('отчёт по выполненным задачам', () => {
  it('в срок и с опозданием, по сотрудникам и неделям; кто закрыл; архив — только с «С архивом»', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const today = todayIso();
      // Исполнитель → проверка → принял начальник; срок давно прошёл.
      let a = await svc.createTask(tx, x.h, { title: 'Принята с опозданием', categoryId: x.project.id, assigneeId: x.staff.id, dueDate: '2020-01-10' });
      a = await runAction(tx, x.s, a.id, 'start', { version: a.version });
      a = await runAction(tx, x.s, a.id, 'submit', { version: a.version, comment: 'готово' });
      await runAction(tx, x.h, a.id, 'accept', { version: a.version, comment: 'принято' });
      // Начальник без руководителя — «Завершить» сам, в срок.
      let b = await svc.createTask(tx, x.h, { title: 'Сам завершил', categoryId: x.project.id, assigneeId: x.head.id, dueDate: '2099-01-01' });
      b = await runAction(tx, x.h, b.id, 'start', { version: b.version });
      await runAction(tx, x.h, b.id, 'complete', { version: b.version, comment: 'сделано' });
      // Закрыта системой и в архиве (прежний ответственный) — не в отчёте без «С архивом».
      const c = await svc.createTask(tx, x.h, { title: 'Ушла в архив', categoryId: x.project.id, assigneeId: x.staff.id });
      const row = await tx.task.findUniqueOrThrow({ where: { id: c.id } });
      await closeTasks(tx, [row], 'Ответственный по этапу сменился', { archive: true });

      const mine = async (extra: Partial<Parameters<typeof taskStats>[1]> = {}) => {
        const r = await taskStats(tx, { from: today, to: today, ...extra });
        return { ...r, items: r.items.filter((i) => [a.id, b.id, c.id].includes(i.id)) };
      };
      const r = await mine();
      expect(r.items.map((i) => [i.title, i.lateDays !== null && i.lateDays > 0, i.closedBy.how, i.closedBy.fullName])).toEqual(expect.arrayContaining([
        ['Принята с опозданием', true, 'accepted', 'Начальник Отчёта'],
        ['Сам завершил', false, 'self', 'Начальник Отчёта'],
      ]));
      expect(r.items).toHaveLength(2);
      expect(r.items.find((i) => i.id === a.id)).toMatchObject({ startedAt: today, completedAt: today, dueDate: '2020-01-10', leadDays: 0 });
      const staffRow = r.byAssignee.find((p) => p.id === x.staff.id);
      expect(staffRow).toMatchObject({ done: 1, late: 1, onTime: 0 });
      expect(r.weeks.map((w) => w.week)).toEqual([weekStart(today)]);
      expect(r.summary.done).toBeGreaterThanOrEqual(2);

      expect((await mine({ archived: true })).items.find((i) => i.id === c.id)?.closedBy.how).toBe('system');
      expect((await mine({ late: true })).items.map((i) => i.title)).toEqual(['Принята с опозданием']);
      expect((await mine({ assigneeId: x.head.id })).items.map((i) => i.title)).toEqual(['Сам завершил']);
      expect((await mine({ from: '2000-01-01', to: '2000-01-31' })).items).toEqual([]);
      expect(weekStart('2026-11-08')).toBe('2026-11-02');
      expect(weekStart('2026-11-02')).toBe('2026-11-02');
    }));

  it('по HTTP: без tasks.report — 403; начало позже конца — 400; с правом — 200', () =>
    inTx(async (tx) => {
      const hash = await argon2Hasher.hash(PASSWORD);
      const x = await setup(tx);
      await tx.user.updateMany({ where: { id: { in: [x.head.id, x.staff.id] } }, data: { passwordHash: hash } });
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
      });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const url = '/api/v1/tasks/stats?from=2026-11-01&to=2026-11-30';
      expect((await app.inject({ url, headers: { cookie: await login(x.staff.login) } })).statusCode).toBe(403);
      const head = await login(x.head.login);
      expect((await app.inject({ url: '/api/v1/tasks/stats?from=2026-12-01&to=2026-11-01', headers: { cookie: head } })).statusCode).toBe(400);
      const res = await app.inject({ url, headers: { cookie: head } });
      expect(res.statusCode).toBe(200);
      // 1 ноября 2026 — воскресенье: неделя 26.10 и ещё пять.
      expect(res.json().weeks.length).toBe(6);
    }));
});
