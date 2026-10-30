// Уведомления (этап В, ADR-0023): кому приходят события задач, без дублей, себе — никогда; сроки; очистка; доступ по HTTP.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { parseIpList } from '../../lib/ip-list.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { addDaysIso, todayIso } from '../../lib/today.js';
import { actorFor, inTx, makeUser, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { statusIdOf } from '../tasks/flow.js';
import { runAction } from '../tasks/process.js';
import * as tasks from '../tasks/service.js';
import * as svc from './service.js';

/** Начальник ← руководитель группы ← исполнитель (проверяющий — руководитель группы); автор — отдельный начальник; посторонний. */
async function team(tx: Tx) {
  const boss = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник' });
  const lead = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Руководитель группы', manager: { connect: { id: boss.id } } });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Исполнитель', manager: { connect: { id: lead.id } } });
  const author = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Автор' });
  const plainAuthor = await makeUser(tx, ['ib_staff'], { fullName: 'Автор без права' });
  const stranger = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Посторонний' });
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  const a = async (u: { id: string }) => actorFor(tx, u.id);
  return {
    boss, lead, staff, author, plainAuthor, stranger, project,
    B: await a(boss), L: await a(lead), S: await a(staff), A: await a(author), P: await a(plainAuthor), X: await a(stranger),
  };
}

const inbox = async (tx: Tx, userId: string) =>
  (await tx.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map((n) => `${n.kind}: ${n.title}${n.body ? ` | ${n.body}` : ''}`);
const kinds = async (tx: Tx, userId: string) => (await tx.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map((n) => n.kind);

describe('уведомления о задачах', () => {
  it('назначение и смена исполнителя: новому — «назначена», прежнему — «снята»; себе и отключённому — нет', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      let t = await tasks.createTask(tx, x.A, { title: 'Проверить права', categoryId: x.project.id, assigneeId: x.staff.id });
      expect(await inbox(tx, x.staff.id)).toEqual([`task_assigned: Вам назначена задача #${t.number} «Проверить права» | Назначил: Автор`]);
      expect(await kinds(tx, x.author.id)).toEqual([]);
      // Себе: взял задачу сам — уведомления нет.
      const own = await tasks.createTask(tx, x.S, { title: 'Себе', categoryId: x.project.id, assigneeId: x.staff.id });
      expect((await kinds(tx, x.staff.id)).length).toBe(1);
      expect(own.status.systemKey).toBe('assigned');

      t = await tasks.updateTask(tx, x.A, t.id, { version: t.version, assigneeId: x.lead.id });
      expect(await kinds(tx, x.lead.id)).toEqual(['task_assigned']);
      expect((await inbox(tx, x.staff.id)).at(-1)).toBe(`task_unassigned: С вас снята задача #${t.number} «Проверить права» | Исполнитель: Руководитель группы. Изменил: Автор`);
      // Отключённый пользователь уведомлений не получает.
      await tx.user.update({ where: { id: x.staff.id }, data: { isActive: false } });
      await tasks.createTask(tx, x.A, { title: 'Отключённому', categoryId: x.project.id, assigneeId: x.lead.id });
      await tasks.updateTask(tx, x.A, t.id, { version: t.version, assigneeId: null });
      expect((await kinds(tx, x.staff.id)).length).toBe(2);
    }));

  it('«ждёт вашей проверки» — только проверяющему (руководитель исполнителя); автору, старшим и исполнителю — нет; «вернули» и «принята» — исполнителю', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      let t = await tasks.createTask(tx, x.A, { title: 'На проверку', categoryId: x.project.id, assigneeId: x.staff.id });
      t = await runAction(tx, x.S, t.id, 'start', { version: t.version });
      t = await runAction(tx, x.S, t.id, 'submit', { version: t.version, comment: 'Готово, отчёт в письме' });
      expect(await inbox(tx, x.lead.id)).toEqual([`task_submitted: Задача #${t.number} «На проверку» ждёт вашей проверки | Исполнитель: Готово, отчёт в письме`]);
      for (const u of [x.author, x.boss, x.stranger]) expect(await kinds(tx, u.id)).toEqual([]);
      expect(await kinds(tx, x.staff.id)).toEqual(['task_assigned']);

      t = await runAction(tx, x.L, t.id, 'return', { version: t.version, comment: 'Нет отчёта' });
      t = await runAction(tx, x.S, t.id, 'submit', { version: t.version, comment: 'Приложил' });
      await runAction(tx, x.L, t.id, 'accept', { version: t.version, comment: 'Принято' });
      expect(await inbox(tx, x.staff.id)).toEqual([
        `task_assigned: Вам назначена задача #${t.number} «На проверку» | Назначил: Автор`,
        `task_returned: Задачу #${t.number} «На проверку» вернули в работу | Руководитель группы: Нет отчёта`,
        `task_accepted: Задача #${t.number} «На проверку» принята | Руководитель группы: Принято`,
      ]);
      expect(await kinds(tx, x.lead.id)).toEqual(['task_submitted', 'task_submitted']);
    }));

  it('у исполнителя нет руководителя — «Завершить» без проверки: «выполнена» автору; «ждёт проверки» — никому', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      const lone = await makeUser(tx, ['ib_staff'], { fullName: 'Без руководителя' });
      let t = await tasks.createTask(tx, x.B, { title: 'Одиночка', categoryId: x.project.id, assigneeId: lone.id });
      await tx.task.update({ where: { id: t.id }, data: { createdBy: x.plainAuthor.id } });
      const L = await actorFor(tx, lone.id);
      t = await runAction(tx, L, t.id, 'start', { version: t.version });
      await runAction(tx, L, t.id, 'complete', { version: t.version, comment: 'Готово' });
      expect(await inbox(tx, x.plainAuthor.id)).toEqual([`task_completed: Задача #${t.number} «Одиночка» выполнена | Без руководителя: Готово`]);
      expect(await tx.notification.count({ where: { taskId: t.id, kind: 'task_submitted' } })).toBe(0);
      expect(await kinds(tx, lone.id)).toEqual(['task_assigned']);
    }));

  it('свободная смена статуса — исполнителю: кто перенёс и комментарий; перенёс сам — нет', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      // Исполнитель без руководителя: с руководителем в «Выполнено» — только через проверку (1.4.0).
      let t = await tasks.createTask(tx, x.B, { title: 'Перенос', categoryId: x.project.id, assigneeId: x.plainAuthor.id });
      t = await tasks.updateTask(tx, x.B, t.id, { version: t.version, statusId: await statusIdOf(tx, 'done'), comment: 'Закрываю сам' });
      expect((await inbox(tx, x.plainAuthor.id)).at(-1)).toBe(`task_moved: Задачу #${t.number} «Перенос» перенесли: «Поставленные» → «Выполнено» | Начальник: Закрываю сам`);
      const mine = await tasks.createTask(tx, x.B, { title: 'Своя', categoryId: x.project.id, assigneeId: x.boss.id });
      await tasks.updateTask(tx, x.B, mine.id, { version: mine.version, statusId: await statusIdOf(tx, 'work') });
      expect(await kinds(tx, x.boss.id)).toEqual([]);
    }));

  it('комментарий человека — исполнителю и автору, кроме написавшего; комментарий шага — не дублируется', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      let t = await tasks.createTask(tx, x.A, { title: 'Обсуждение', categoryId: x.project.id, assigneeId: x.staff.id });
      await tasks.addComment(tx, x.X, t.id, 'Посмотрите лог за вчера');
      expect((await inbox(tx, x.author.id))).toEqual([`task_commented: Комментарий в задаче #${t.number} «Обсуждение» | Посторонний: Посмотрите лог за вчера`]);
      expect(await kinds(tx, x.staff.id)).toEqual(['task_assigned', 'task_commented']);
      await tasks.addComment(tx, x.S, t.id, 'Посмотрел');
      expect(await kinds(tx, x.staff.id)).toEqual(['task_assigned', 'task_commented']);
      expect(await kinds(tx, x.author.id)).toEqual(['task_commented', 'task_commented']);
      t = await runAction(tx, x.S, t.id, 'start', { version: t.version });
      await runAction(tx, x.S, t.id, 'submit', { version: t.version, comment: 'Готово' });
      // Комментарий шага не приходит «комментарием»: автор его не получает, проверяющий — «ждёт вашей проверки».
      expect(await kinds(tx, x.author.id)).toEqual(['task_commented', 'task_commented']);
      expect(await kinds(tx, x.lead.id)).toEqual(['task_submitted']);
    }));

  it('откат действия — уведомления нет', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      await tx.$executeRawUnsafe('SAVEPOINT n1');
      await tasks.createTask(tx, x.A, { title: 'Откатится', categoryId: x.project.id, assigneeId: x.staff.id });
      expect(await kinds(tx, x.staff.id)).toEqual(['task_assigned']);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT n1');
      expect(await kinds(tx, x.staff.id)).toEqual([]);
    }));
});

describe('часовой прогон: сроки и очистка', () => {
  it('«срок завтра» — исполнителю, без исполнителя — автору; «просрочено» — исполнителю и автору; без дублей; новый срок — новое', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      const today = todayIso();
      const tomorrow = addDaysIso(today, 1);
      const soon = await tasks.createTask(tx, x.A, { title: 'Завтра', categoryId: x.project.id, assigneeId: x.staff.id, dueDate: tomorrow });
      const soonFree = await tasks.createTask(tx, x.A, { title: 'Завтра без исполнителя', categoryId: x.project.id, dueDate: tomorrow });
      const late = await tasks.createTask(tx, x.A, { title: 'Просрочена', categoryId: x.project.id, assigneeId: x.staff.id, dueDate: addDaysIso(today, -3) });
      await tx.notification.deleteMany({ where: { userId: { in: [x.staff.id, x.author.id] } } });
      // Опорная дата в прошлом: первый прогон после обновления уже был (сводное — отдельный тест).
      await tx.appSetting.upsert({ where: { key: svc.OVERDUE_SINCE_KEY }, create: { key: svc.OVERDUE_SINCE_KEY, value: '2000-01-01' }, update: { value: '2000-01-01' } });

      await svc.notifyDeadlines(tx);
      expect((await kinds(tx, x.staff.id)).sort()).toEqual(['task_due_tomorrow', 'task_overdue']);
      expect((await kinds(tx, x.author.id)).sort()).toEqual(['task_due_tomorrow', 'task_overdue']);
      expect((await tx.notification.findFirstOrThrow({ where: { userId: x.author.id, kind: 'task_due_tomorrow' } })).taskId).toBe(soonFree.id);
      // Повторный прогон — ничего нового.
      expect(await svc.notifyDeadlines(tx)).toMatchObject({ dueTomorrow: 0, overdue: 0 });
      // Перенос срока — новое уведомление по новому сроку.
      await tasks.updateTask(tx, x.A, late.id, { version: late.version, dueDate: addDaysIso(today, -1) });
      expect((await svc.notifyDeadlines(tx)).overdue).toBe(2);
      // Выполненная задача — не напоминаем.
      await tx.task.update({ where: { id: soon.id }, data: { dueDate: new Date(`${addDaysIso(today, -5)}T00:00:00Z`), completedAt: new Date() } });
      expect((await svc.notifyDeadlines(tx)).overdue).toBe(0);
    }));

  it('первый прогон после обновления: просроченное на этот момент — одно сводное «У вас N просроченных задач» каждому; дальше — по задаче', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      const today = todayIso();
      await tx.appSetting.deleteMany({ where: { key: svc.OVERDUE_SINCE_KEY } });
      const mk = (title: string, assigneeId: string | null, due: string) =>
        tasks.createTask(tx, x.A, { title, categoryId: x.project.id, assigneeId, dueDate: due });
      await mk('Старая 1', x.staff.id, addDaysIso(today, -30));
      await mk('Старая 2', x.staff.id, addDaysIso(today, -2));
      await mk('Старая 3', x.lead.id, addDaysIso(today, -1));
      await mk('Через неделю', x.staff.id, addDaysIso(today, 7));
      await tx.notification.deleteMany({ where: { userId: { in: [x.staff.id, x.author.id, x.lead.id] } } });

      const first = await svc.notifyDeadlines(tx);
      expect(first.overdue).toBe(0);
      expect(await inbox(tx, x.staff.id)).toEqual([
        'task_overdue_summary: У вас 2 просроченные задачи | Просрочены на момент обновления портала — откройте доску с фильтром «просрочено». Дальше уведомление приходит по каждой задаче.',
      ]);
      expect(await inbox(tx, x.author.id)).toEqual([expect.stringMatching(/^task_overdue_summary: У вас \d+ просроченн/)]);
      expect(await kinds(tx, x.lead.id)).toEqual(['task_overdue_summary']);
      expect((await tx.appSetting.findUniqueOrThrow({ where: { key: svc.OVERDUE_SINCE_KEY } })).value).toBe(today);
      const list = await svc.listNotifications(tx, x.staff.id, {});
      expect([list.items[0]?.link, list.items[0]?.task]).toEqual([svc.OVERDUE_BOARD_LINK, null]);

      // Повторный прогон — ни сводного, ни по задачам.
      expect(await svc.notifyDeadlines(tx)).toEqual({ dueTomorrow: 0, overdue: 0, overdueSummary: 0 });
      // Через 10 дней «Через неделю» просрочена — по задаче; старые — по-прежнему нет.
      const later = new Date(Date.now() + 10 * 86_400_000);
      expect((await svc.notifyDeadlines(tx, later)).overdue).toBe(2);
      expect((await kinds(tx, x.staff.id)).filter((k) => k === 'task_overdue')).toHaveLength(1);
      expect(overdueWord()).toEqual(['1 просроченная задача', '3 просроченные задачи', '5 просроченных задач', '11 просроченных задач', '22 просроченные задачи']);
    }));

  it('очистка: прочитанные старше 90 дней, непрочитанные старше 180; раз в сутки; запись в журнале только если удалено', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      const now = new Date('2027-06-01T09:00:00Z');
      const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
      const mk = (title: string, createdAt: Date, readAt: Date | null) =>
        tx.notification.create({ data: { userId: x.staff.id, kind: 'task_assigned', title, createdAt, readAt } });
      await tx.notification.deleteMany({ where: { createdAt: { lt: ago(89) } } });
      await mk('прочитано 91', ago(200), ago(91));
      await mk('прочитано 89', ago(200), ago(89));
      await mk('не прочитано 181', ago(181), null);
      await mk('не прочитано 179', ago(179), null);
      await tx.appSetting.deleteMany({ where: { key: 'notifications.cleaned_on' } });
      expect(await svc.cleanupNotifications(tx, now)).toBe(2);
      expect((await tx.notification.findMany({ where: { userId: x.staff.id }, orderBy: { title: 'asc' } })).map((n) => n.title))
        .toEqual(['не прочитано 179', 'прочитано 89']);
      const log = await tx.auditLog.findFirstOrThrow({ where: { action: 'notifications.cleaned' }, orderBy: { id: 'desc' } });
      expect((log.diff as { rows: number }).rows).toBe(2);
      expect(await svc.cleanupNotifications(tx, now)).toBeNull();
      const before = await tx.auditLog.count({ where: { action: 'notifications.cleaned' } });
      expect(await svc.cleanupNotifications(tx, new Date(now.getTime() + 86_400_000))).toBe(0);
      expect(await tx.auditLog.count({ where: { action: 'notifications.cleaned' } })).toBe(before);
    }));
});

describe('уведомления по HTTP', () => {
  it('видит только адресат: чужое — 404; «прочитать все» — только свои; список и счётчик сходятся; монитор — 403', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Notify-Test-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const x = await team(tx);
      await tx.user.updateMany({ where: { id: { in: [x.staff.id, x.author.id] } }, data: { passwordHash: hash } });
      const wall = await makeUser(tx, ['kiosk'], { passwordHash: hash });
      await tasks.createTask(tx, x.A, { title: 'Первая', categoryId: x.project.id, assigneeId: x.staff.id });
      const t2 = await tasks.createTask(tx, x.A, { title: 'Вторая', categoryId: x.project.id, assigneeId: x.staff.id });
      await tasks.addComment(tx, x.S, t2.id, 'Автору');
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
        trustProxy: '172.31.250.6', kioskAllowedIps: parseIpList('10.20.30.40'),
      });
      const login = async (l: string, ip = '10.0.0.5') => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD }, remoteAddress: '172.31.250.6', headers: { 'x-forwarded-for': ip } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const S = await login(x.staff.login);
      const A = await login(x.author.login);
      const get = (cookie: string, url: string) => app.inject({ url, headers: { cookie } });
      const post = (cookie: string, url: string) => app.inject({ method: 'POST', url, headers: { cookie } });

      const list = (await get(S, '/api/v1/notifications')).json() as { items: { id: string; task: { number: number } | null; read: boolean }[]; unread: number };
      expect([list.items.length, list.unread]).toEqual([2, 2]);
      expect((await get(S, '/api/v1/notifications/count')).json()).toEqual({ unread: 2 });
      const authorList = (await get(A, '/api/v1/notifications')).json() as { items: { id: string }[] };
      expect((await post(S, `/api/v1/notifications/${authorList.items[0]?.id}/read`)).statusCode).toBe(404);
      expect((await post(S, `/api/v1/notifications/${list.items[0]?.id}/read`)).statusCode).toBe(204);
      expect((await get(S, '/api/v1/notifications?unread=true')).json().items).toHaveLength(1);
      expect((await post(S, '/api/v1/notifications/read-all')).json()).toEqual({ marked: 1 });
      expect((await get(A, '/api/v1/notifications/count')).json()).toEqual({ unread: 1 });

      const K = await login(wall.login, '10.20.30.40');
      const fromWall = { remoteAddress: '172.31.250.6', headers: { cookie: K, 'x-forwarded-for': '10.20.30.40' } };
      expect((await app.inject({ url: '/api/v1/monitor', ...fromWall })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/v1/notifications/count', ...fromWall })).statusCode).toBe(403);
    }));
});

const overdueWord = () => [1, 3, 5, 11, 22].map(svc.overdueCountLabel);
