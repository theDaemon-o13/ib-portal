// Процесс задач, этап Б1 (ADR-0022): колонка по исполнителю, переходы в task_transitions, перенос задач при обновлении.
import { describe, expect, it } from 'vitest';
import { seedTaskProcess } from '../../../prisma/seed/tasks.js';
import { actorFor, inTx, makeUser, type Tx } from '../../test/db.js';
import { createDocument } from '../documents/service.js';
import { closeDocumentTasks } from '../documents/tasks.js';
import { statusIdOf } from './flow.js';
import * as svc from './service.js';

async function setup(tx: Tx) {
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Исполнитель' });
  const other = await makeUser(tx, ['ib_staff'], { fullName: 'Другой' });
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  return { staff, other, project, actor: await actorFor(tx, staff.id) };
}

const transitions = (tx: Tx, taskId: string) =>
  tx.taskTransition.findMany({ where: { taskId }, orderBy: { at: 'asc' }, include: { fromStatus: true, toStatus: true } });

describe('процесс задач: колонки и переходы', () => {
  it('создание: с исполнителем — «Поставленные», без — Backlog; переход создания записан', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const a = await svc.createTask(tx, x.actor, { title: 'С исполнителем', categoryId: x.project.id, assigneeId: x.staff.id });
      const b = await svc.createTask(tx, x.actor, { title: 'Без исполнителя', categoryId: x.project.id });
      expect([a.status.systemKey, b.status.systemKey]).toEqual(['assigned', 'new']);
      const [t] = await transitions(tx, a.id);
      expect([t?.fromStatusId, t?.toStatus.systemKey, t?.kind, t?.actorId]).toEqual([null, 'assigned', 'process', x.staff.id]);
    }));

  it('исполнитель двигает колонку: назначили — «Поставленные», сняли — Backlog, сменили у «В работе» — «Поставленные»', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      let t = await svc.createTask(tx, x.actor, { title: 'Задача', categoryId: x.project.id });
      t = await svc.updateTask(tx, x.actor, t.id, { version: t.version, assigneeId: x.staff.id });
      expect(t.status.systemKey).toBe('assigned');
      t = await svc.updateTask(tx, x.actor, t.id, { version: t.version, assigneeId: null });
      expect(t.status.systemKey).toBe('new');
      t = await svc.updateTask(tx, x.actor, t.id, { version: t.version, assigneeId: x.staff.id });
      t = await svc.updateTask(tx, x.actor, t.id, { version: t.version, statusId: await statusIdOf(tx, 'work') });
      t = await svc.updateTask(tx, x.actor, t.id, { version: t.version, assigneeId: x.other.id });
      expect(t.status.systemKey).toBe('assigned');
      const kinds = (await transitions(tx, t.id)).map((r) => `${r.kind}:${r.toStatus.systemKey}`);
      expect(kinds).toEqual(['process:new', 'assign:assigned', 'assign:new', 'assign:assigned', 'override:work', 'assign:assigned']);
    }));

  it('системная задача закрывается сама: переход system с комментарием, комментарий виден в ленте задачи', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t = await svc.createTask(tx, x.actor, { title: 'Доработать документ', categoryId: x.project.id, assigneeId: x.staff.id });
      const admin = await makeUser(tx, ['super_admin']);
      const type = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: `Тип ${Math.random().toString(36).slice(2)}` } });
      const doc = await createDocument(tx, await actorFor(tx, admin.id), {
        title: 'Политика', typeId: type.id, ownerId: x.staff.id, onlyofficeUrl: 'https://office.example/doc?id=1', edition: '1.0',
      }).then((id) => ({ id }));
      await tx.task.update({ where: { id: t.id }, data: { documentId: doc.id, documentReason: 'returned', source: 'document' } });
      await closeDocumentTasks(tx, doc.id, 'returned', 'Документ отправлен на согласование');
      const last = (await transitions(tx, t.id)).at(-1);
      expect([last?.kind, last?.toStatus.systemKey]).toEqual(['system', 'done']);
      const comments = await tx.taskComment.findMany({ where: { taskId: t.id } });
      expect(comments.some((c) => c.transitionId === last?.id && c.body.includes('закрыта автоматически'))).toBe(true);
    }));

  it('task_transitions только пополняется: правка и удаление отклоняются', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t = await svc.createTask(tx, x.actor, { title: 'Задача', categoryId: x.project.id });
      for (const sql of [`UPDATE task_transitions SET comment = 'x' WHERE task_id = '${t.id}'`, `DELETE FROM task_transitions WHERE task_id = '${t.id}'`]) {
        await tx.$executeRawUnsafe('SAVEPOINT tt');
        await expect(tx.$executeRawUnsafe(sql)).rejects.toThrow(/permission denied|только пополняется/);
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tt');
      }
    }));
});

describe('обновление на 1.2.0: шаг seed tasks.process.v1_2', () => {
  /** Состояние 1.1.0: прежние названия и порядок, задачи с исполнителем — в «Новые», шага ещё не было. */
  async function asBefore(tx: Tx, opts: { adminRenamedDone?: boolean } = {}) {
    const ids = { new: await statusIdOf(tx, 'new'), assigned: await statusIdOf(tx, 'assigned'), done: await statusIdOf(tx, 'done') };
    await tx.catalogItem.update({ where: { id: ids.new }, data: { value: 'Новые' } });
    await tx.catalogItem.update({ where: { id: ids.done }, data: { value: opts.adminRenamedDone ? 'Закрыто' : 'Готово', commentForward: false } });
    await tx.seedMarker.deleteMany({ where: { key: 'tasks.process.v1_2' } });
    const x = await setup(tx);
    const prio = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_priorities', systemKey: 'normal' } });
    const make = (title: string, assigneeId: string | null, extra: object = {}) =>
      tx.task.create({ data: { title, statusId: ids.new, priorityId: prio.id, categoryId: x.project.id, source: 'manual', assigneeId, ...extra } });
    return {
      ids, x,
      withAssignee: await make('С исполнителем', x.staff.id),
      archived: await make('Архивная с исполнителем', x.staff.id, { archivedAt: new Date() }),
      deleted: await make('Удалённая с исполнителем', x.staff.id, { deletedAt: new Date() }),
      backlog: await make('Без исполнителя', null),
    };
  }

  it('переносит задачи «Новые» с исполнителем (и архивные) в «Поставленные», удалённые и без исполнителя не трогает; переименовывает', () =>
    inTx(async (tx) => {
      const b = await asBefore(tx);
      await seedTaskProcess(tx);
      const status = async (id: string) => (await tx.task.findUniqueOrThrow({ where: { id }, include: { status: true } })).status.systemKey;
      expect(await status(b.withAssignee.id)).toBe('assigned');
      expect(await status(b.archived.id)).toBe('assigned');
      expect(await status(b.deleted.id)).toBe('new');
      expect(await status(b.backlog.id)).toBe('new');
      const tr = await tx.taskTransition.findFirstOrThrow({ where: { taskId: b.withAssignee.id } });
      expect([tr.kind, tr.comment, tr.actorId]).toEqual(['migration', 'Перенесена при обновлении на 1.2.0', null]);
      const names = await tx.catalogItem.findMany({ where: { id: { in: [b.ids.new, b.ids.done] } } });
      expect(names.map((n) => n.value).sort()).toEqual(['Backlog', 'Выполнено']);
      expect(names.find((n) => n.id === b.ids.done)?.commentForward).toBe(true);

      // Повторный запуск ничего не меняет.
      const before = await tx.taskTransition.count();
      await seedTaskProcess(tx);
      expect(await tx.taskTransition.count()).toBe(before);
    }));

  it('название, заданное администратором, не переименовывается', () =>
    inTx(async (tx) => {
      const b = await asBefore(tx, { adminRenamedDone: true });
      await seedTaskProcess(tx);
      expect((await tx.catalogItem.findUniqueOrThrow({ where: { id: b.ids.done } })).value).toBe('Закрыто');
    }));

  it('выравнивание после отката: открытая задача в Backlog с исполнителем → «Поставленные» при каждом запуске', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      await seedTaskProcess(tx); // шаг уже выполнен
      const prio = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_priorities', systemKey: 'normal' } });
      // Так задачу создал бы backend 1.1.0.
      const t = await tx.task.create({ data: { title: 'Создана на 1.1.0', statusId: await statusIdOf(tx, 'new'), priorityId: prio.id, categoryId: x.project.id, source: 'manual', assigneeId: x.staff.id } });
      await seedTaskProcess(tx);
      expect((await tx.task.findUniqueOrThrow({ where: { id: t.id }, include: { status: true } })).status.systemKey).toBe('assigned');
      expect((await tx.taskTransition.findFirstOrThrow({ where: { taskId: t.id } })).kind).toBe('system');
    }));
});
