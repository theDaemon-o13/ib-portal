// Задачи модуля писем с настоящей БД (1.9.0, шаг 7c; docs/specs/awareness.md, разделы 19.5–19.6): срочная рассылка,
// доработка после возврата, письмо из задачи рассылки, запись в истории задачи при отметке «Отправлено».
// 04.01.2041 — пятница; календаря на 2041 год нет. Люди и письма вымышленные.
import { describe, expect, it } from 'vitest';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import * as letters from './letters.service.js';
import * as rules from './rules.service.js';
import { runAwarenessSchedule } from './schedule.service.js';
import * as templates from './templates.service.js';
import { SIGNATURE_BLOCK } from './variables.js';

const NOW = new Date('2041-01-04T06:00:00Z');
const deps = { now: () => NOW };
const both = { subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: `<p>Текст</p>${SIGNATURE_BLOCK}`, htmlTj: `<p>Матн</p>${SIGNATURE_BLOCK}` };
const dateOf = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

async function people(tx: Tx) {
  const author = await actorFor(tx, (await makeUser(tx, ['ib_staff'], { fullName: 'Автор Задач' })).id);
  const worker = await actorFor(tx, (await makeUser(tx, ['ib_staff'], { fullName: 'Исполнитель Задач' })).id);
  const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
  return { author, worker, head };
}

const taskOf = (tx: Tx, id: string) => tx.task.findUniqueOrThrow({ where: { id }, include: { priority: true, category: true, status: true } });

describe('задачи модуля писем', () => {
  it('«Срочная рассылка»: письмо «Срочное» и задача нажавшему — 1 рабочий день, «Высокий», без автора', () =>
    inTx(async (tx) => {
      const { author } = await people(tx);
      await expectCode(letters.urgentMailing(tx, author, { title: 'Атака', reason: ' ' }, deps), 'REASON_REQUIRED');
      const { letter } = await letters.urgentMailing(tx, author, { title: 'Атака на почту', reason: 'Новая схема мошенничества' }, deps);
      expect([letter.kind, letter.reason, letter.status, letter.task?.title]).toEqual(['urgent', 'Новая схема мошенничества', 'draft', 'Срочная рассылка: Атака на почту']);
      const t = await taskOf(tx, must(letter.task).id);
      expect([t.assigneeId, t.createdBy, t.source, t.priority.systemKey, t.category.systemKey, t.status.systemKey, dateOf(t.dueDate)]).toEqual(
        [author.id, null, 'manual', 'high', 'awareness', 'assigned', '2041-01-07'],
      );
      expect(t.description).toContain(`Учебное письмо № ${letter.number}`);

      const { template } = await templates.createTemplate(tx, author, { title: 'Срочный шаблон', ...both, subjectRu: 'Внимание: {{схема}}' });
      const fromTpl = await letters.urgentMailing(tx, author, { title: 'По шаблону', reason: 'Инцидент', templateId: template.id }, deps);
      expect([fromTpl.letter.template?.id, fromTpl.letter.versions[0]?.reason, fromTpl.letter.content.subjectRu]).toEqual([template.id, 'template', 'Внимание: {{схема}}']);
    }));

  it('возврат на доработку: задача автору, 3 рабочих дня, с комментарием; событие ссылается на задачу', () =>
    inTx(async (tx) => {
      const { author, head } = await people(tx);
      const { letter } = await letters.createLetter(tx, author, { title: 'Мартовское', kind: 'planned', ...both });
      const s = await letters.submitLetter(tx, author, letter.id, { version: letter.version });
      const r = await letters.returnLetter(tx, head, letter.id, { version: s.version, comment: 'Уточните тему' }, deps);
      const ev = must(r.events[0]);
      expect([ev.action, ev.task?.number !== undefined]).toEqual(['returned', true]);
      const t = await taskOf(tx, must(ev.task).id);
      expect([t.title, t.assigneeId, t.createdBy, t.category.systemKey, dateOf(t.dueDate)]).toEqual(['Доработать письмо: Мартовское', author.id, null, 'awareness', '2041-01-09']);
      expect(t.description).toContain('Уточните тему');
      expect(await tx.notification.count({ where: { userId: author.id, kind: 'task_assigned', taskId: t.id } })).toBe(1);
    }));

  it('письмо из задачи рассылки; доработка — исполнителю задачи со сроком отправки; «Отправлено» — в истории задачи, задача открыта', () =>
    inTx(async (tx) => {
      const { author, worker, head } = await people(tx);
      const role = await tx.role.create({ data: { name: 'Рассылки 7c', permissions: { create: [{ permissionCode: 'ib.work' }] } } });
      await tx.userRole.create({ data: { userId: worker.id, roleId: role.id } });
      const rule = await rules.createRule(tx, author, { title: 'Ежемесячная', cadence: { kind: 'monthly', day: 15 }, startsOn: '2041-01-01', roleId: role.id, leadDays: 14 }, NOW);
      await runAwarenessSchedule(tx, { now: NOW });
      const run = await tx.awarenessScheduleRun.findFirstOrThrow({ where: { ruleId: rule.id } });
      await tx.task.update({ where: { id: run.taskId }, data: { assigneeId: worker.id } });

      // Задача не из расписания (срочная рассылка) — 404.
      const urgent = await letters.urgentMailing(tx, worker, { title: 'Срочно', reason: 'Инцидент' }, deps);
      await expectCode(letters.createLetter(tx, worker, { title: 'x', kind: 'planned' }, {}, { taskId: must(urgent.letter.task).id }), 'NOT_FOUND');
      const { letter } = await letters.createLetter(tx, worker, { title: 'Январская рассылка', kind: 'planned' }, {}, { taskId: run.taskId });
      expect([letter.task?.id, (await tx.awarenessScheduleRun.findUniqueOrThrow({ where: { id: run.id } })).letterId]).toEqual([run.taskId, letter.id]);
      await expectCode(letters.createLetter(tx, worker, { title: 'Второе', kind: 'planned' }, {}, { taskId: run.taskId }), 'TASK_HAS_LETTER');

      const filled = await letters.saveLetter(tx, worker, letter.id, { version: letter.version, ...both });
      const s = await letters.submitLetter(tx, worker, letter.id, { version: filled.letter.version });
      const ret = await letters.returnLetter(tx, head, letter.id, { version: s.version, comment: 'Добавьте пример' }, deps);
      const rework = await taskOf(tx, must(must(ret.events[0]).task).id);
      expect([rework.assigneeId, dateOf(rework.dueDate)]).toEqual([worker.id, '2041-01-15']);

      const s2 = await letters.submitLetter(tx, worker, letter.id, { version: ret.version });
      const a = await letters.approveLetter(tx, head, letter.id, { version: s2.version });
      await letters.sendLetter(tx, worker, letter.id, { version: a.version, sentOn: '2041-01-04', audience: 'Все сотрудники' }, deps);
      const note = await tx.auditLog.findFirstOrThrow({ where: { entity: 'task', entityId: run.taskId, action: 'task.awareness_sent' } });
      expect((note.diff as { summary: string }).summary).toContain(`письмо № ${letter.number} отмечено отправленным 04.01.2041`);
      expect((await taskOf(tx, run.taskId)).completedAt).toBeNull();
    }));

  it('«без независимого согласования» — по участию: черновик из правила начальника ИБ, написанный сотрудником, — без пометки', () =>
    inTx(async (tx) => {
      const { worker, head } = await people(tx);
      const role = await tx.role.create({ data: { name: 'Рассылки самосогласование', permissions: { create: [{ permissionCode: 'ib.work' }] } } });
      await tx.userRole.create({ data: { userId: worker.id, roleId: role.id } });
      await tx.userRole.create({ data: { userId: head.id, roleId: role.id } });
      const { template } = await templates.createTemplate(tx, head, { title: 'Шаблон начальника', ...both });
      const rule = await rules.createRule(tx, head, { title: 'Правило начальника', cadence: { kind: 'monthly', day: 15 }, startsOn: '2041-01-01', roleId: role.id, leadDays: 14, templateId: template.id }, NOW);
      await runAwarenessSchedule(tx, { now: NOW });
      const run = await tx.awarenessScheduleRun.findFirstOrThrow({ where: { ruleId: rule.id } });
      const letterId = must(run.letterId);
      expect((await letters.getLetter(tx, head.id, letterId)).createdBy.id).toBe(head.id);

      // Сотрудник взял задачу и написал письмо — начальник ИБ утверждает без пометки.
      await tx.task.update({ where: { id: run.taskId }, data: { assigneeId: worker.id } });
      const l0 = await letters.getLetter(tx, worker.id, letterId);
      const ed = await letters.saveLetter(tx, worker, letterId, { version: l0.version, ...both, htmlRu: `<p>Текст сотрудника</p>${SIGNATURE_BLOCK}` });
      const s = await letters.submitLetter(tx, worker, letterId, { version: ed.letter.version });
      const a = await letters.approveLetter(tx, head, letterId, { version: s.version });
      expect([a.selfApproved, a.events[0]?.selfApproved]).toEqual([false, false]);
    }));

  it('«без независимого согласования» — начальник ИБ правил чужое письмо или ведёт его задачу — с пометкой', () =>
    inTx(async (tx) => {
      const { author, head } = await people(tx);
      // Правил сам письмо другого автора.
      const { letter } = await letters.createLetter(tx, author, { title: 'Чужое', kind: 'planned', ...both });
      const ed = await letters.saveLetter(tx, head, letter.id, { version: letter.version, ...both, subjectRu: 'Тема начальника' });
      const s = await letters.submitLetter(tx, author, letter.id, { version: ed.letter.version });
      expect((await letters.approveLetter(tx, head, letter.id, { version: s.version })).selfApproved).toBe(true);

      // Исполнитель задачи письма (срочная рассылка, письмо создал другой) — тоже участие.
      const urgent = await letters.urgentMailing(tx, author, { title: 'Срочно', reason: 'Инцидент' }, deps);
      await tx.task.update({ where: { id: must(urgent.letter.task).id }, data: { assigneeId: head.id } });
      const filled = await letters.saveLetter(tx, author, urgent.letter.id, { version: urgent.letter.version, ...both });
      const s2 = await letters.submitLetter(tx, author, urgent.letter.id, { version: filled.letter.version });
      expect((await letters.approveLetter(tx, head, urgent.letter.id, { version: s2.version })).selfApproved).toBe(true);

      // Не участвовал — без пометки.
      const { letter: l3 } = await letters.createLetter(tx, author, { title: 'Независимое', kind: 'planned', ...both });
      const s3 = await letters.submitLetter(tx, author, l3.id, { version: l3.version });
      expect((await letters.approveLetter(tx, head, l3.id, { version: s3.version })).selfApproved).toBe(false);
    }));
});
