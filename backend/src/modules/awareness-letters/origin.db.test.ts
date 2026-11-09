// Происхождение задач модуля писем и терпимость API задач к неизвестному source (1.9.0, шаг 7d; вариант A и
// «расширить → перенести → сузить», CLAUDE.md 3.3). Люди, правила и письма вымышленные.
import { describe, expect, it } from 'vitest';
import { testDbConfig } from '../../../scripts/test-db.js';
import { buildApp } from '../../app.js';
import { createPrisma } from '../../lib/db.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { todayIso } from '../../lib/today.js';
import { getTaskRow, toTaskDto } from '../tasks/service.js';
import * as letters from './letters.service.js';
import * as rules from './rules.service.js';
import { runAwarenessSchedule } from './schedule.service.js';
import { SIGNATURE_BLOCK } from './variables.js';

const NOW = new Date('2041-01-04T06:00:00Z');
const both = { subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: `<p>Текст</p>${SIGNATURE_BLOCK}`, htmlTj: `<p>Матн</p>${SIGNATURE_BLOCK}` };
const PASSWORD = 'Origin-Test-Pass-2026';

const dto = async (tx: Tx, id: string, now: Date) => toTaskDto(await getTaskRow(tx, id), todayIso(now));

async function appWith(db: Tx) {
  return buildApp({
    db, repo: prismaAuthRepository(db), audit: prismaAuditWriter(db), hasher: argon2Hasher,
    sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
  });
}

describe('происхождение задач модуля писем', () => {
  it('задача рассылки: правило, плановая дата, этапы по статусу письма; срочная и доработка — «Учебное письмо № N»; обычная — null', () =>
    inTx(async (tx) => {
      const worker = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
      const role = await tx.role.create({ data: { name: 'Рассылки 7d', permissions: { create: [{ permissionCode: 'ib.work' }] } } });
      await tx.userRole.create({ data: { userId: worker.id, roleId: role.id } });
      const rule = await rules.createRule(tx, worker, { title: 'Пятнадцатое', cadence: { kind: 'monthly', day: 15 }, startsOn: '2041-01-01', roleId: role.id, leadDays: 14 }, NOW);
      await runAwarenessSchedule(tx, { now: NOW });
      const run = await tx.awarenessScheduleRun.findFirstOrThrow({ where: { ruleId: rule.id } });

      const t0 = await dto(tx, run.taskId, NOW);
      expect(t0.source).toBe('manual');
      expect(t0.origin).toEqual({
        kind: 'schedule', rule: { id: rule.id, title: 'Пятнадцатое' }, plannedDate: '2041-01-15', letter: null, letterSent: false,
        // Согласование: 12.01 — суббота, перенос на пятницу 11.01.
        stages: [
          { key: 'draft', due: '2041-01-08', done: false, overdue: false },
          { key: 'review', due: '2041-01-11', done: false, overdue: false },
          { key: 'send', due: '2041-01-15', done: false, overdue: false },
        ],
      });

      const { letter } = await letters.createLetter(tx, worker, { title: 'Январь', kind: 'planned', ...both }, {}, { taskId: run.taskId });
      const s = await letters.submitLetter(tx, worker, letter.id, { version: letter.version });
      const t1 = await dto(tx, run.taskId, new Date('2041-01-12T06:00:00Z'));
      expect(t1.origin?.kind === 'schedule' && t1.origin.stages.map((x) => [x.key, x.done, x.overdue])).toEqual(
        [['draft', true, false], ['review', false, true], ['send', false, false]],
      );
      expect(t1.origin?.kind === 'schedule' && t1.origin.letter).toEqual({ id: letter.id, number: letter.number, status: 'review', deleted: false });

      const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      await letters.sendLetter(tx, worker, letter.id, { version: a.version, sentOn: '2041-01-04', audience: 'Все сотрудники' }, { now: () => NOW });
      const t2 = await dto(tx, run.taskId, NOW);
      expect([t2.origin && 'letterSent' in t2.origin ? t2.origin.letterSent : undefined, t2.completedAt]).toEqual([true, null]);

      const urgent = await letters.urgentMailing(tx, worker, { title: 'Срочно', reason: 'Инцидент' }, { now: () => NOW });
      const tu = await dto(tx, must(urgent.letter.task).id, NOW);
      expect(tu.origin).toEqual({ kind: 'letter', reason: 'urgent', letter: { id: urgent.letter.id, number: urgent.letter.number, status: 'draft', deleted: false }, letterSent: false });

      const { letter: l2 } = await letters.createLetter(tx, worker, { title: 'На доработку', kind: 'planned', ...both });
      const s2 = await letters.submitLetter(tx, worker, l2.id, { version: l2.version });
      const ret = await letters.returnLetter(tx, head, l2.id, { version: s2.version, comment: 'Поправьте' }, { now: () => NOW });
      const tr = await dto(tx, must(must(ret.events[0]).task).id, NOW);
      expect(tr.origin).toMatchObject({ kind: 'letter', reason: 'rework', letter: { number: l2.number } });

      const category = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', systemKey: 'mail' } });
      const plain = await tx.task.create({
        data: {
          title: 'Обычная', statusId: t0.status.id, priorityId: t0.priority.id, categoryId: category.id, source: 'manual', createdBy: worker.id,
        },
      });
      expect((await dto(tx, plain.id, NOW)).origin).toBeNull();
    }));
});

describe('API задач и неизвестный source', () => {
  it('задача с source из более новой версии портала — доска и карточка отвечают 200 и отдают значение как есть', async () => {
    // Под владельцем схемы в транзакции с откатом на одноразовой ibportal_test: снять tasks_source_check и вставить
    // задачу «из будущего». После теста ограничение и данные возвращаются откатом.
    const owner = createPrisma(testDbConfig().ownerUrl);
    class Rollback extends Error {}
    try {
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE tasks DROP CONSTRAINT tasks_source_check');
        const hash = await argon2Hasher.hash(PASSWORD);
        const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
        const status = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_statuses', systemKey: 'new' } });
        const priority = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_priorities', systemKey: 'normal' } });
        const category = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', systemKey: 'awareness' } });
        const t = await tx.task.create({ data: { title: 'Из будущей версии', statusId: status.id, priorityId: priority.id, categoryId: category.id, source: 'awareness' } });

        const app = await appWith(tx);
        const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: staff.login, password: PASSWORD } });
        const cookie = `ib_session=${login.cookies.find((x) => x.name === 'ib_session')?.value}`;
        const card = await app.inject({ url: `/api/v1/tasks/${t.id}`, headers: { cookie } });
        expect([card.statusCode, card.json().source]).toEqual([200, 'awareness']);
        const board = await app.inject({ url: '/api/v1/tasks', headers: { cookie } });
        expect(board.statusCode).toBe(200);
        expect((board.json().items as { id: string; source: string }[]).find((x) => x.id === t.id)?.source).toBe('awareness');
        throw new Rollback();
      }, { timeout: 60_000 });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    } finally {
      await owner.$disconnect();
    }
  });
});
