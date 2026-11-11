// Самооценка (этап Д3): задачи по разрывам без «Задачи: постановка другим» и без следа самооценки в задаче;
// напоминание о переоценке за 30 дней до годовщины. БД — транзакция с откатом.
import { describe, expect, it } from 'vitest';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { listNotifications } from '../notifications/service.js';
import * as tasks from '../tasks/service.js';
import * as svc from './service.js';

async function fixture(tx: Tx) {
  const owner = await makeUser(tx, ['assessment'], { fullName: 'Владелец самооценки' });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Сотрудник ИБ' });
  const reader = await makeUser(tx, ['doc_reader'], { fullName: 'Читатель документов' });
  // Оценки других прогонов (вне транзакции) не должны влиять: в архив на время теста.
  await tx.assessment.updateMany({ where: { status: { not: 'archived' } }, data: { status: 'archived', archivedAt: new Date() } });
  const category = must(await tx.catalogItem.findFirst({ where: { catalogCode: 'task_categories', deletedAt: null, archivedAt: null } }));
  const as = async () => actorFor(tx, owner.id);
  const create = async (title = 'Экспресс-оценка 2026') => svc.createAssessment(tx, await as(), { title, assessedOn: '2026-10-30' });
  return { owner, staff, reader, category, as, create };
}

describe('самооценка: задачи по разрывам (ADR-0026)', () => {
  it('ставит владелец без tasks.assign; исполнитель без ib.work — 400; статус задачи виден в разделе', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const input = { title: 'Контроль устранения уязвимостей: усилить', categoryId: x.category.id, dueDate: '2026-12-31' };
      await expectCode(svc.createGapTask(tx, await x.as(), id, '5.3', { ...input, assigneeId: x.reader.id }), 'BAD_ASSIGNEE');
      await expectCode(svc.createGapTask(tx, await x.as(), id, '5.3', { ...input, assigneeId: x.owner.id }), 'BAD_ASSIGNEE');
      const linked = await svc.createGapTask(tx, await x.as(), id, '5.3', { ...input, assigneeId: x.staff.id });
      expect(linked).toMatchObject({ code: '5.3', title: input.title, assignee: 'Сотрудник ИБ', dueDate: '2026-12-31', done: false, archived: false });

      const t = await tasks.getTaskRow(tx, linked.id);
      expect(t).toMatchObject({ source: 'manual', assigneeId: x.staff.id, createdBy: x.owner.id, categoryId: x.category.id });
      // Статус задачи — в разделе, как на доске.
      expect((await svc.getAssessment(tx, id)).tasks).toEqual([expect.objectContaining({ id: t.id, status: t.status.value })]);
      // Исполнитель получил обычное уведомление о назначении.
      expect(await tx.notification.count({ where: { userId: x.staff.id, taskId: t.id, kind: 'task_assigned' } })).toBe(1);
      // Связь — в журнале оценки и в истории раздела.
      expect((await svc.assessmentLog(tx, id, '5.3')).items.map((h) => h.action)).toEqual(['assessment.task_linked']);
    }));

  it('в задаче и её журнале нет ни раздела, ни баллов, ни ссылки на самооценку', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Тайная оценка 2026');
      const a = must((await svc.getAssessment(tx, id)).answers.find((s) => s.code === '5.3'));
      await svc.saveAnswer(tx, await x.as(), id, '5.3', { version: a.version, level: 2, targetLevel: 4, comment: 'Подробность раздела' });
      const linked = await svc.createGapTask(tx, await x.as(), id, '5.3', { title: 'Контроль устранения уязвимостей: усилить', categoryId: x.category.id, assigneeId: x.staff.id });

      const dto = JSON.stringify(await tasks.getTask(tx, linked.id));
      const log = await tx.auditLog.findMany({ where: { entity: 'task', entityId: linked.id } });
      expect(log.map((r) => r.action)).toEqual(['task.created']);
      const history = JSON.stringify(await tasks.taskHistory(tx, linked.id));
      for (const text of [dto, JSON.stringify(log.map((r) => ({ action: r.action, entity: r.entity, summary: (r.diff as { summary: string }).summary, after: (r.diff as { after: unknown }).after }))), history]) {
        for (const trace of [id, 'Тайная оценка', 'Подробность раздела', 'assessment', 'Самооценк']) expect(text).not.toContain(trace);
        // Код раздела, а не часть времени: «12:45.312Z» содержит те же символы, и тест падал случайно.
        expect(text).not.toMatch(/(?<!\d)5\.3(?!\d)/);
      }
      expect((log[0]?.diff as { summary: string }).summary).toBe(`Задача #${linked.number} «Контроль устранения уязвимостей: усилить» создана`);
    }));

  it('в архивной оценке задачи не ставятся; неизвестный раздел — 404', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const input = { title: 'Задача', categoryId: x.category.id, assigneeId: x.staff.id };
      await expectCode(svc.createGapTask(tx, await x.as(), id, '12.1', input), 'NOT_FOUND');
      const v = (await tx.assessment.findUniqueOrThrow({ where: { id } })).version;
      await svc.archiveAssessment(tx, await x.as(), id, { version: v });
      await expectCode(svc.createGapTask(tx, await x.as(), id, '5.3', input), 'ARCHIVED');
    }));

  it('исполнители — только активные сотрудники с ib.work, только id и имя', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const { items } = await svc.taskAssignees(tx);
      expect(items.some((u) => u.id === x.staff.id)).toBe(true);
      expect(items.some((u) => u.id === x.reader.id || u.id === x.owner.id)).toBe(false);
      expect(Object.keys(must(items[0])).sort()).toEqual(['fullName', 'id']);
    }));
});

describe('самооценка: напоминание о переоценке (правило 11)', () => {
  it('за 31 день — нет, за 30 — одно, повтор — нет; при открытом черновике — нет; ссылка — в раздел', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const second = await makeUser(tx, ['assessment'], { fullName: 'Второй владелец' });
      const id = await x.create('Экспресс-оценка 2025');
      // Зафиксированная от 29.11.2025: годовщина 29.11.2026, напоминание — с 30.10.2026.
      await tx.assessment.update({ where: { id }, data: { status: 'final', result: {}, finalizedAt: new Date(), assessedOn: new Date('2025-11-29T00:00:00Z') } });
      const mine = () => tx.notification.count({ where: { kind: svc.REMINDER_KIND, userId: { in: [x.owner.id, second.id] } } });

      await svc.notifyReassessment(tx, new Date('2026-10-29T08:00:00Z'));
      expect(await mine()).toBe(0);

      const draft = await x.create('Черновик 2026');
      await svc.notifyReassessment(tx, new Date('2026-10-30T08:00:00Z'));
      expect(await mine()).toBe(0);
      const v = (await tx.assessment.findUniqueOrThrow({ where: { id: draft } })).version;
      await svc.archiveAssessment(tx, await x.as(), draft, { version: v });

      await svc.notifyReassessment(tx, new Date('2026-10-30T08:00:00Z'));
      expect(await mine()).toBe(2);
      await svc.notifyReassessment(tx, new Date('2026-10-30T09:00:00Z'));
      await svc.notifyReassessment(tx, new Date('2026-11-15T08:00:00Z'));
      expect(await mine()).toBe(2);
      // Сотрудник без права не получает.
      expect(await tx.notification.count({ where: { kind: svc.REMINDER_KIND, userId: x.staff.id } })).toBe(0);

      const n = must((await listNotifications(tx, x.owner.id, {})).items.find((i) => i.kind === svc.REMINDER_KIND));
      expect(n).toMatchObject({ title: 'Пора провести самооценку', link: '/assessment/overview', actor: null, task: null });
      expect(n.body).toContain('29.11.2026');
    }));

  it('годовщина 29 февраля — 1 марта', () => {
    expect(svc.anniversaryOf('2024-02-29')).toBe('2025-03-01');
    expect(svc.anniversaryOf('2025-07-07')).toBe('2026-07-07');
  });
});
