// Индикаторы «ждёт вашего действия» (релиз 1.4.0): задачи на моей проверке, документы «ждут вас», сумма.
import { describe, expect, it } from 'vitest';
import { actorFor, inTx, makeUser, type Tx } from '../../test/db.js';
import { createDocument } from '../documents/service.js';
import { statusIdOf } from '../tasks/flow.js';
import { runAction } from '../tasks/process.js';
import * as tasks from '../tasks/service.js';
import { attentionOf } from './service.js';

async function team(tx: Tx) {
  const boss = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник' });
  const lead = await makeUser(tx, ['ib_staff'], { fullName: 'Руководитель группы', manager: { connect: { id: boss.id } } });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Исполнитель', manager: { connect: { id: lead.id } } });
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  return { boss, lead, staff, project, B: await actorFor(tx, boss.id), L: await actorFor(tx, lead.id), S: await actorFor(tx, staff.id) };
}

describe('GET /me/attention', () => {
  it('«Задачи» — только задачи на моей проверке: у проверяющего 1, у старшего выше и у исполнителя 0; в архиве — 0', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      let t = await tasks.createTask(tx, x.B, { title: 'На проверку', categoryId: x.project.id, assigneeId: x.staff.id });
      t = await runAction(tx, x.S, t.id, 'start', { version: t.version });
      t = await runAction(tx, x.S, t.id, 'submit', { version: t.version, comment: 'готово' });
      const [l, b, s] = await Promise.all([attentionOf(tx, x.L), attentionOf(tx, x.B), attentionOf(tx, x.S)]);
      expect([l.tasks, b.tasks, s.tasks]).toEqual([1, 0, 0]);
      expect(l.total).toBe(l.tasks + l.documents);
      // В архиве — не ждёт.
      await tasks.setTaskArchived(tx, x.B, t.id, t.version, true);
      expect((await attentionOf(tx, x.L)).tasks).toBe(0);
    }));

  it('задача до 1.4.0 без проверяющего — у того, кто может её принять по прежним правилам (tasks.review и старший)', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      const t = await tasks.createTask(tx, x.B, { title: 'Отправлена на 1.3.0', categoryId: x.project.id, assigneeId: x.staff.id });
      await tx.task.update({ where: { id: t.id }, data: { statusId: await statusIdOf(tx, 'review') } });
      const [b, l] = await Promise.all([attentionOf(tx, x.B), attentionOf(tx, x.L)]);
      expect([b.tasks, l.tasks]).toEqual([1, 0]); // руководитель группы без tasks.review по старым правилам не принимает
    }));

  it('«Документы» — «ждут вас» (драфт ждёт автора); колокольчик — сумма; без доступа к разделам ИБ задач нет', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      const admin = await makeUser(tx, ['super_admin']);
      const before = await attentionOf(tx, x.L);
      const type = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: `Тип ${Math.random().toString(36).slice(2)}` } });
      await createDocument(tx, await actorFor(tx, admin.id), {
        title: 'Политика', typeId: type.id, ownerId: x.lead.id, onlyofficeUrl: 'https://office.example/doc?id=7', edition: '1.0',
      });
      let t = await tasks.createTask(tx, x.B, { title: 'На проверку', categoryId: x.project.id, assigneeId: x.staff.id });
      t = await runAction(tx, x.S, t.id, 'start', { version: t.version });
      await runAction(tx, x.S, t.id, 'submit', { version: t.version, comment: 'готово' });
      const after = await attentionOf(tx, x.L);
      expect([after.tasks, after.documents - before.documents, after.total]).toEqual([1, 1, after.tasks + after.documents]);
      // «Читатель документов» (без ib.work): задач в индикаторе нет.
      const reader = await makeUser(tx, ['doc_reader']);
      expect((await attentionOf(tx, await actorFor(tx, reader.id))).tasks).toBe(0);
    }));
});
