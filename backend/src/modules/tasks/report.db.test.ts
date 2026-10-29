// Отчёт по задачам (этап Б4, ADR-0022): фильтры, даты переходов, просрочка, предел строк; по HTTP — право tasks.report и Excel.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { todayIso } from '../../lib/today.js';
import { actorFor, expectCode, inTx, makeUser, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { statusIdOf } from './flow.js';
import { runAction } from './process.js';
import { taskReport } from './report.js';
import * as svc from './service.js';

const PASSWORD = 'Report-Test-Pass-2026';

async function setup(tx: Tx) {
  const head = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник Отчёта' });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Исполнитель Отчёта', manager: { connect: { id: head.id } } });
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  return { head, staff, project, h: await actorFor(tx, head.id), s: await actorFor(tx, staff.id) };
}

describe('отчёт по задачам', () => {
  it('даты переходов из task_transitions, выполнена — completed_at; просрочка на дату выполнения; перенос при обновлении не считается', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      let t = await svc.createTask(tx, x.h, { title: 'Пройдёт процесс', categoryId: x.project.id, assigneeId: x.staff.id, dueDate: '2020-01-10' });
      t = await runAction(tx, x.s, t.id, 'start', { version: t.version });
      t = await runAction(tx, x.s, t.id, 'submit', { version: t.version, comment: 'готово' });
      await runAction(tx, x.h, t.id, 'accept', { version: t.version, comment: 'принято' });
      const today = todayIso();
      const [line] = await taskReport(tx, { creatorId: x.head.id });
      expect(line).toMatchObject({
        title: 'Пройдёт процесс', author: 'Начальник Отчёта', assignee: 'Исполнитель Отчёта', status: 'Выполнено',
        created: today, assigned: today, work: today, review: today, done: today, archived: false,
      });
      expect(line?.overdueDays).toBeGreaterThan(2000);

      // Задача 1.1.0: перенос при обновлении (migration) — не «Поставлена»; «В работе» — из журнала аудита.
      const old = await svc.createTask(tx, x.h, { title: 'До обновления', categoryId: x.project.id });
      await tx.taskTransition.create({ data: { taskId: old.id, fromStatusId: await statusIdOf(tx, 'new'), toStatusId: await statusIdOf(tx, 'assigned'), kind: 'migration' } });
      await tx.auditLog.create({
        data: {
          action: 'task.updated', entity: 'task', entityId: old.id, at: new Date('2026-05-04T08:00:00Z'),
          diff: { summary: 'старая правка', after: { changes: [{ field: 'statusId', label: 'Статус', from: 'Новые', to: 'В работе' }] } },
        },
      });
      const oldLine = (await taskReport(tx, { creatorId: x.head.id })).find((l) => l.title === 'До обновления');
      expect([oldLine?.assigned, oldLine?.work, oldLine?.review]).toEqual([null, '2026-05-04', null]);
    }));

  it('фильтры: период по сроку и выполнению, исполнитель, колонка, только просроченные, архив; больше предела — «Сузьте период»', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const mk = (title: string, extra: Partial<Parameters<typeof svc.createTask>[2]> = {}) =>
        svc.createTask(tx, x.h, { title, categoryId: x.project.id, ...extra });
      await mk('Просрочена', { assigneeId: x.staff.id, dueDate: '2020-02-01' });
      await mk('В срок', { assigneeId: x.staff.id, dueDate: '2099-02-01' });
      const backlog = await mk('Без исполнителя', { dueDate: '2020-03-01' });
      await svc.setTaskArchived(tx, x.h, backlog.id, backlog.version, true);
      const titles = async (f: Parameters<typeof taskReport>[1]) => (await taskReport(tx, { creatorId: x.head.id, ...f })).map((l) => l.title).sort();

      expect(await titles({})).toEqual(['В срок', 'Просрочена']);
      expect(await titles({ archived: true })).toEqual(['Без исполнителя', 'В срок', 'Просрочена']);
      expect(await titles({ overdue: true, archived: true })).toEqual(['Без исполнителя', 'Просрочена']);
      expect(await titles({ period: 'due', from: '2020-01-01', to: '2020-02-01' })).toEqual(['Просрочена']);
      expect(await titles({ period: 'completed', from: '2000-01-01' })).toEqual([]);
      expect(await titles({ assigneeId: x.head.id })).toEqual([]);
      expect(await titles({ statusId: await statusIdOf(tx, 'assigned') })).toEqual(['В срок', 'Просрочена']);
      expect(await titles({ period: 'created', from: todayIso(), to: todayIso() })).toEqual(['В срок', 'Просрочена']);
      await expectCode(taskReport(tx, { creatorId: x.head.id }, 1), 'TOO_MANY_ROWS');
    }));

  it('по HTTP: без tasks.report — 403; с правом — Excel с теми же строками и запись в журнале', () =>
    inTx(async (tx) => {
      const hash = await argon2Hasher.hash(PASSWORD);
      const x = await setup(tx);
      await tx.user.updateMany({ where: { id: { in: [x.head.id, x.staff.id] } }, data: { passwordHash: hash } });
      await svc.createTask(tx, x.h, { title: 'В отчёт', categoryId: x.project.id, assigneeId: x.staff.id, dueDate: '2020-01-01' });
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
      });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const url = `/api/v1/tasks/report?creatorId=${x.head.id}&overdue=true`;
      expect((await app.inject({ url, headers: { cookie: await login(x.staff.login) } })).statusCode).toBe(403);
      const res = await app.inject({ url, headers: { cookie: await login(x.head.login) } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/filename\*=UTF-8''/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
      const ws = wb.getWorksheet('Задачи');
      expect(ws?.rowCount).toBe(2);
      expect(ws?.getRow(2).getCell(2).value).toBe('В отчёт');
      expect(ws?.getRow(2).getCell(7).value).toBe('Поставленные');
      expect(Number(ws?.getRow(2).getCell(13).value)).toBeGreaterThan(0);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: 'tasks.report_exported', userId: x.head.id } });
      expect((audit.diff as { rows: number }).rows).toBe(1);
    }));
});
