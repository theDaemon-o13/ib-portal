// Прогон расписания рассылок с настоящей БД (1.9.0, шаг 7b; docs/specs/awareness.md, раздел 19.3–19.7).
// Даты — 2041 год (календаря на него нет): 05.01.2041 — суббота, 25.01.2041 — пятница. Роль — своя, чтобы держатели
// были только тестовые. Люди и правила вымышленные.
import { describe, expect, it } from 'vitest';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import * as rules from './rules.service.js';
import { checkRuleNow, runAwarenessSchedule } from './schedule.service.js';
import * as templates from './templates.service.js';

const at = (iso: string) => new Date(iso);

async function setup(tx: Tx, holders = 2) {
  const role = await tx.role.create({ data: { name: `Рассылки ${Math.random().toString(36).slice(2, 8)}`, permissions: { create: [{ permissionCode: 'ib.work' }] } } });
  const users = [];
  for (let i = 0; i < holders; i++) {
    const u = await makeUser(tx, ['ib_staff']);
    await tx.userRole.create({ data: { userId: u.id, roleId: role.id } });
    users.push(u);
  }
  const author = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
  return { role, users, author };
}

async function taskOfRun(tx: Tx, ruleId: string) {
  return tx.awarenessScheduleRun.findMany({
    where: { ruleId }, orderBy: { plannedDate: 'asc' },
    include: { task: { include: { status: true, category: true, candidates: true } }, letter: { include: { versions: true } } },
  });
}

describe('прогон расписания', () => {
  it('окно и идемпотентность: задача общая, без автора; черновик из шаблона; граница суток по Душанбе; прошлые даты не догоняются', () =>
    inTx(async (tx) => {
      const { role, users, author } = await setup(tx);
      const { template } = await templates.createTemplate(tx, author, {
        title: 'Ежемесячный шаблон', subjectRu: 'Осторожно: {{схема}}', subjectTj: 'Эҳтиёт: {{схема}}', htmlRu: '<p>{{схема}}</p><p>{{подпись}}</p>', htmlTj: '<p>{{схема}}</p>',
      });
      const rule = await rules.createRule(tx, author, {
        title: 'Ежемесячная', cadence: { kind: 'monthly', day: 5 }, startsOn: '2041-01-01', roleId: role.id, templateId: template.id,
      }, at('2041-01-01T06:00:00Z'));

      const r1 = await runAwarenessSchedule(tx, { now: at('2041-01-01T06:00:00Z') });
      expect([r1.ran, r1.created, r1.letters]).toEqual([true, 1, 1]);
      expect((await runAwarenessSchedule(tx, { now: at('2041-01-01T07:00:00Z') })).created).toBe(0);

      const run = must((await taskOfRun(tx, rule.id))[0], 'запуск');
      const t = run.task;
      expect([t.title, t.source, t.createdBy, t.assigneeId, t.status.systemKey, t.category.systemKey, t.dueDate?.toISOString().slice(0, 10)]).toEqual(
        ['Рассылка: Ежемесячная — 04.01.2041', 'manual', null, null, 'new', 'awareness', '2041-01-04'],
      );
      expect(t.candidates.map((c) => c.userId).sort()).toEqual(users.map((u) => u.id).sort());
      // Этапы — не раньше дня создания задачи.
      expect([run.nominalDate, run.plannedDate, run.draftDue, run.reviewDue].map((d) => d.toISOString().slice(0, 10))).toEqual(
        ['2041-01-05', '2041-01-04', '2041-01-01', '2041-01-01'],
      );
      expect(t.description).toContain('• черновик — до 01.01.2041');
      expect(run.letter).toMatchObject({ kind: 'planned', templateId: template.id, taskId: t.id, createdBy: author.id, status: 'draft' });
      expect(run.letter?.versions.map((v) => v.reason)).toEqual(['template']);
      expect(run.letter?.versions[0]?.subjectRu).toBe('Осторожно: {{схема}}');
      expect(t.description).toContain(`учебное письмо № ${run.letter?.number}`);

      // Граница суток: 18:59Z — ещё 25.01 (окно до 04.02), 19:00Z — уже 26.01 (окно до 05.02).
      expect((await runAwarenessSchedule(tx, { now: at('2041-01-25T18:59:00Z') })).created).toBe(0);
      expect((await runAwarenessSchedule(tx, { now: at('2041-01-25T19:00:00Z') })).created).toBe(1);
      // После простоя: 05.03 уже прошло — не создаётся; 05.04 ещё не в окне.
      expect((await runAwarenessSchedule(tx, { now: at('2041-03-10T06:00:00Z') })).created).toBe(0);
      expect((await taskOfRun(tx, rule.id)).map((x) => x.plannedDate.toISOString().slice(0, 10))).toEqual(['2041-01-04', '2041-02-05']);
    }));

  it('отключённое правило задач не создаёт; «Проверить сейчас» — только для активного; архивный шаблон — задача без черновика', () =>
    inTx(async (tx) => {
      const { role, author } = await setup(tx, 1);
      const { template } = await templates.createTemplate(tx, author, { title: 'В архив', subjectRu: 'Т', subjectTj: 'Т', htmlRu: '<p>т</p>', htmlTj: '<p>т</p>' });
      const now = at('2041-01-01T06:00:00Z');
      const base = { title: 'Еженедельная', cadence: { kind: 'weekly', every: 1, weekday: 3 } as const, startsOn: '2041-01-01', roleId: role.id, templateId: template.id };
      const rule = await rules.createRule(tx, author, { ...base, active: false }, now);
      expect((await runAwarenessSchedule(tx, { now })).created).toBe(0);
      await expectCode(checkRuleNow(tx, rule.id, now), 'RULE_INACTIVE');

      await templates.archiveTemplate(tx, author, template.id, { version: template.version, archived: true });
      await rules.updateRule(tx, author, rule.id, { ...base, version: rule.version }, now);
      const r = await checkRuleNow(tx, rule.id, now);
      // Среды в окне 01.01–11.01: 02.01 и 09.01.
      expect([r.created, r.letters]).toEqual([2, 0]);
      const runs = await taskOfRun(tx, rule.id);
      expect(runs.every((x) => x.letterId === null)).toBe(true);
      expect(runs[0]?.task.description).toContain('Шаблон «В архив» в архиве — черновик не создан.');
    }));

  it('кандидаты обновляются, пока задачу не взяли; эскалация — за 3 рабочих дня, один раз; без держателей — сразу', () =>
    inTx(async (tx) => {
      const { role, users, author } = await setup(tx, 1);
      const head = await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true });
      const rule = await rules.createRule(tx, author, {
        title: 'Двадцать пятое', cadence: { kind: 'monthly', day: 25 }, startsOn: '2041-01-01', roleId: role.id, leadDays: 30,
      }, at('2041-01-01T06:00:00Z'));
      expect((await runAwarenessSchedule(tx, { now: at('2041-01-01T06:00:00Z') })).escalated).toBe(0);

      // Новый держатель роли — добавлен; отключённый — убран.
      const fresh = await makeUser(tx, ['ib_staff']);
      await tx.userRole.create({ data: { userId: fresh.id, roleId: role.id } });
      await tx.user.update({ where: { id: must(users[0]).id }, data: { isActive: false } });
      expect((await runAwarenessSchedule(tx, { now: at('2041-01-02T06:00:00Z') })).candidatesUpdated).toBe(1);
      const run = must((await taskOfRun(tx, rule.id))[0], 'запуск');
      expect(run.task.candidates.map((c) => c.userId)).toEqual([fresh.id]);

      // 22.01 (вт): до 25.01 (пт) — 3 рабочих дня → эскалация начальнику ИБ, один раз.
      expect((await runAwarenessSchedule(tx, { now: at('2041-01-21T06:00:00Z') })).escalated).toBe(0);
      expect((await runAwarenessSchedule(tx, { now: at('2041-01-22T06:00:00Z') })).escalated).toBe(1);
      expect((await runAwarenessSchedule(tx, { now: at('2041-01-23T06:00:00Z') })).escalated).toBe(0);
      const n = await tx.notification.findMany({ where: { kind: 'awareness_unclaimed' } });
      expect(n.map((x) => [x.userId, x.taskId, x.title])).toEqual([[head.id, run.taskId, 'Рассылку «Двадцать пятое» никто не взял, срок 25.01']]);

      // Роль без держателей: задача без кандидатов, эскалация сразу; отметки нет — держателям роли «Начальник ИБ».
      await tx.user.update({ where: { id: head.id }, data: { isIbHead: false } });
      const empty = await tx.role.create({ data: { name: 'Пустая роль рассылок', permissions: { create: [{ permissionCode: 'ib.work' }] } } });
      const rule2 = await rules.createRule(tx, author, {
        title: 'Без людей', cadence: { kind: 'monthly', day: 25 }, startsOn: '2041-01-01', roleId: empty.id, leadDays: 30,
      }, at('2041-01-01T06:00:00Z'));
      const r2 = await checkRuleNow(tx, rule2.id, at('2041-01-01T06:00:00Z'));
      expect([r2.created, r2.escalated]).toEqual([1, 1]);
      const run2 = must((await taskOfRun(tx, rule2.id))[0], 'запуск');
      expect(run2.task.candidates).toEqual([]);
      const n2 = await tx.notification.findMany({ where: { kind: 'awareness_unclaimed', taskId: run2.taskId } });
      expect(n2.map((x) => x.userId)).toContain(head.id);
    }));

  it('взятую задачу кандидаты и эскалация не трогают', () =>
    inTx(async (tx) => {
      const { role, users, author } = await setup(tx, 1);
      await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true });
      const rule = await rules.createRule(tx, author, {
        title: 'Взята', cadence: { kind: 'monthly', day: 25 }, startsOn: '2041-01-01', roleId: role.id, leadDays: 30,
      }, at('2041-01-01T06:00:00Z'));
      await runAwarenessSchedule(tx, { now: at('2041-01-01T06:00:00Z') });
      const run = must((await taskOfRun(tx, rule.id))[0], 'запуск');
      await tx.task.update({ where: { id: run.taskId }, data: { assigneeId: must(users[0]).id } });
      const r = await runAwarenessSchedule(tx, { now: at('2041-01-24T06:00:00Z') });
      expect([r.escalated, r.candidatesUpdated]).toEqual([0, 0]);
    }));
});
