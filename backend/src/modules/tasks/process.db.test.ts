// Процесс задач, этап Б1 (ADR-0022): колонка по исполнителю, переходы в task_transitions, перенос задач при обновлении.
// Проверяющий по задаче (релиз 1.4.0, ADR-0028): фиксация при отправке, override, замена, отключение, шаг seed.
import { describe, expect, it } from 'vitest';
import { seedTaskProcess, seedTaskReviewers } from '../../../prisma/seed/tasks.js';
import { actorFor, inTx, makeUser, type Tx } from '../../test/db.js';
import { createDocument } from '../documents/service.js';
import { closeDocumentTasks } from '../documents/tasks.js';
import { setActive } from '../users/service.js';
import { statusIdOf, type TaskActor } from './flow.js';
import { runAction, withActions } from './process.js';
import { replaceReviewer } from './reviewer.js';
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
      const head = await actorFor(tx, (await makeUser(tx, ['ib_head'])).id);
      let t = await svc.createTask(tx, x.actor, { title: 'Задача', categoryId: x.project.id });
      t = await svc.updateTask(tx, x.actor, t.id, { version: t.version, assigneeId: x.staff.id });
      expect(t.status.systemKey).toBe('assigned');
      t = await svc.updateTask(tx, x.actor, t.id, { version: t.version, assigneeId: null });
      expect(t.status.systemKey).toBe('new');
      t = await svc.updateTask(tx, x.actor, t.id, { version: t.version, assigneeId: x.staff.id });
      t = await svc.updateTask(tx, head, t.id, { version: t.version, statusId: await statusIdOf(tx, 'work') });
      t = await svc.updateTask(tx, head, t.id, { version: t.version, assigneeId: x.other.id });
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

/** Статус задачи с HTTP-кодом ошибки: 403 — нет права, 409 — состояние не то. */
async function expectStatus(p: Promise<unknown>, code: string, http: number) {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; statusCode?: number });
  expect([err?.code, err?.statusCode]).toEqual([code, http]);
}

describe('процесс задач: кнопки и права (Б2)', () => {
  /** Цепочка: начальник ← руководитель группы ← исполнитель; автор — отдельный сотрудник. */
  async function team(tx: Tx) {
    const x = await setup(tx);
    const boss = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник' });
    const lead = await makeUser(tx, ['ib_staff'], { fullName: 'Руководитель группы', manager: { connect: { id: boss.id } } });
    await tx.user.update({ where: { id: x.staff.id }, data: { managerId: lead.id } });
    const stranger = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Чужой начальник' });
    const author = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Автор' });
    return {
      ...x,
      boss: await actorFor(tx, boss.id), lead: await actorFor(tx, lead.id), stranger: await actorFor(tx, stranger.id), author: await actorFor(tx, author.id),
      other: await actorFor(tx, x.other.id),
    };
  }
  const act = (tx: Tx, who: Parameters<typeof runAction>[1], t: { id: string; version: number }, a: Parameters<typeof runAction>[3], comment?: string) =>
    runAction(tx, who, t.id, a, { version: t.version, comment });

  it('полный путь: взять себе → в работу → на проверку (проверяющий — руководитель) → вернуть → принять; комментарии и «→ ФИО»', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      let t = await svc.createTask(tx, x.author, { title: 'Путь', categoryId: x.project.id });
      expect(t.status.systemKey).toBe('new');
      t = await act(tx, x.actor, t, 'take');
      expect([t.status.systemKey, t.assignee?.id]).toEqual(['assigned', x.staff.id]);
      await expectStatus(act(tx, x.other, t, 'start'), 'NOT_ASSIGNEE', 403);
      t = await act(tx, x.actor, t, 'start');
      await expectStatus(act(tx, x.actor, t, 'submit'), 'COMMENT_REQUIRED', 400);
      t = await act(tx, x.actor, t, 'submit', 'Сделал, проверьте');
      expect([t.status.systemKey, t.reviewer?.fullName]).toEqual(['review', 'Руководитель группы']);
      // Автор задачи и старший выше по цепочке не проверяют: только зафиксированный проверяющий.
      await expectStatus(act(tx, x.author, t, 'return', 'нет'), 'NOT_REVIEWER', 403);
      await expectStatus(act(tx, x.boss, t, 'accept', 'да'), 'NOT_REVIEWER', 403);
      await expectStatus(act(tx, x.lead, t, 'return'), 'COMMENT_REQUIRED', 400);
      t = await act(tx, x.lead, t, 'return', 'Не хватает отчёта');
      expect([t.status.systemKey, t.reviewer]).toEqual(['work', null]);
      expect((await tx.task.findUniqueOrThrow({ where: { id: t.id } })).reviewerId).toBeNull();
      t = await act(tx, x.actor, t, 'submit', 'Отчёт приложил');
      t = await act(tx, x.lead, t, 'accept', 'Принято');
      expect([t.status.systemKey, t.completedAt !== null]).toEqual(['done', true]);

      const rows = await transitions(tx, t.id);
      expect(rows.map((r) => `${r.kind}:${r.toStatus.systemKey}:${r.reviewerId === x.lead.id ? 'lead' : '-'}`)).toEqual([
        'process:new:-', 'process:assigned:-', 'process:work:-', 'process:review:lead', 'process:work:-', 'process:review:lead', 'process:done:-',
      ]);
      const comments = await svc.listComments(tx, t.id);
      expect(comments.map((c) => [c.body, c.transition?.from, c.transition?.to, c.transition?.reviewer])).toEqual([
        ['Сделал, проверьте', 'В работе', 'На проверке', 'Руководитель группы'], ['Не хватает отчёта', 'На проверке', 'В работе', null],
        ['Отчёт приложил', 'В работе', 'На проверке', 'Руководитель группы'], ['Принято', 'На проверке', 'Выполнено', null],
      ]);
      const audit = await tx.auditLog.findMany({ where: { entityId: t.id, action: 'task.transition' }, orderBy: { id: 'asc' } });
      expect(audit).toHaveLength(6);
      const history = await svc.taskHistory(tx, t.id);
      const submit = history.find((h) => h.summary.includes('Отправить на проверку'));
      expect(submit?.summary).toBe(`Задача #${t.number}: «Отправить на проверку» («В работе» → «На проверке» → Руководитель группы)`);
      expect(submit?.changes).toContainEqual({ label: 'Проверяющий', from: '—', to: 'Руководитель группы' });
    }));

  it('действие не из своей колонки — 409; архивная задача — 409; старая версия — 409', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      const t = await svc.createTask(tx, x.actor, { title: 'Колонка', categoryId: x.project.id, assigneeId: x.staff.id });
      await expectStatus(act(tx, x.actor, t, 'submit', 'рано'), 'WRONG_STATUS', 409);
      await expectStatus(act(tx, x.actor, t, 'take'), 'WRONG_STATUS', 409);
      await expectStatus(act(tx, x.actor, { id: t.id, version: t.version + 5 }, 'start'), 'VERSION_CONFLICT', 409);
      const arch = await svc.setTaskArchived(tx, x.actor, t.id, t.version, true);
      await expectStatus(act(tx, x.actor, arch, 'start'), 'TASK_ARCHIVED', 409);
    }));

  it('проверяющий — ближний активный руководитель: отключённый пропускается; фиксируется при отправке, смена руководителя его не меняет', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      await tx.user.update({ where: { id: x.lead.id }, data: { isActive: false } });
      let t = await svc.createTask(tx, x.author, { title: 'Цепочка', categoryId: x.project.id, assigneeId: x.staff.id });
      t = await act(tx, x.actor, t, 'start');
      t = await act(tx, x.actor, t, 'submit', 'готово');
      expect(t.reviewer?.id).toBe(x.boss.id);
      // Руководителя сменили после отправки — проверяет по-прежнему тот, кто зафиксирован.
      await tx.user.update({ where: { id: x.lead.id }, data: { isActive: true } });
      await tx.user.update({ where: { id: x.staff.id }, data: { managerId: x.other.id } });
      await expectStatus(act(tx, x.other, t, 'accept', 'да'), 'NOT_REVIEWER', 403);
      expect((await act(tx, x.boss, t, 'accept', 'да')).status.systemKey).toBe('done');
    }));

  it('«Завершить»: только исполнитель без руководителя; с руководителем — 409, без — «Отправить на проверку» 409', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      // x.other без руководителя.
      let lone = await svc.createTask(tx, x.author, { title: 'Без руководителя', categoryId: x.project.id, assigneeId: x.other.id });
      lone = await act(tx, x.other, lone, 'start');
      expect((await withActions(tx, x.other, [lone]))[0]?.actions).toEqual(['complete']);
      await expectStatus(act(tx, x.other, lone, 'submit', 'готово'), 'NO_REVIEWER', 409);
      await expectStatus(act(tx, x.actor, lone, 'complete', 'чужая'), 'NOT_ASSIGNEE', 403);
      await expectStatus(act(tx, x.other, lone, 'complete'), 'COMMENT_REQUIRED', 400);
      lone = await act(tx, x.other, lone, 'complete', 'Сделано');
      expect([lone.status.systemKey, lone.completedAt !== null]).toEqual(['done', true]);
      expect((await transitions(tx, lone.id)).at(-1)?.reviewerId).toBeNull();

      let t = await svc.createTask(tx, x.author, { title: 'С руководителем', categoryId: x.project.id, assigneeId: x.staff.id });
      t = await act(tx, x.actor, t, 'start');
      expect((await withActions(tx, x.actor, [t]))[0]?.actions).toEqual(['submit']);
      await expectStatus(act(tx, x.actor, t, 'complete', 'сам'), 'REVIEW_REQUIRED', 409);
    }));

  it('задача на проверке до 1.4.0 (без проверяющего) — по прежним правилам: tasks.review и автор, старший или исполнитель без руководителя', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      const review = await statusIdOf(tx, 'review');
      const legacy = async (assignee: { id: string }, creator: { id: string }) => {
        const t = await svc.createTask(tx, x.boss, { title: 'Отправлена на 1.3.0', categoryId: x.project.id, assigneeId: assignee.id });
        await tx.task.update({ where: { id: t.id }, data: { statusId: review, createdBy: creator.id } });
        return svc.getTask(tx, t.id);
      };
      const a = await legacy(x.actor, x.author);
      expect(a.reviewer).toBeNull();
      await expectStatus(act(tx, x.stranger, a, 'accept', 'да'), 'NOT_REVIEWER', 403);
      await expectStatus(act(tx, x.lead, a, 'accept', 'да'), 'NO_REVIEW', 403); // руководитель группы без tasks.review
      expect((await act(tx, x.boss, a, 'accept', 'да')).status.systemKey).toBe('done');
      const b = await legacy(x.actor, x.author);
      expect((await act(tx, x.author, b, 'return', 'ещё раз')).status.systemKey).toBe('work');
      const c = await legacy(x.boss, x.boss);
      await expectStatus(act(tx, x.boss, c, 'accept', 'сам'), 'OWN_TASK', 409);
      expect((await act(tx, x.stranger, c, 'accept', 'принял')).status.systemKey).toBe('done');
    }));

  it('кнопки на доске и в карточке — только доступные этому пользователю', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      let t = await svc.createTask(tx, x.author, { title: 'Кнопки', categoryId: x.project.id });
      const of = async (who: typeof x.actor) => (await withActions(tx, who, [await svc.getTask(tx, t.id)]))[0]?.actions;
      expect(await of(x.actor)).toEqual(['take']);
      t = await act(tx, x.actor, t, 'take');
      expect([await of(x.actor), await of(x.other)]).toEqual([['start'], []]);
      t = await act(tx, x.actor, t, 'start');
      expect(await of(x.actor)).toEqual(['submit']);
      t = await act(tx, x.actor, t, 'submit', 'готово');
      expect([await of(x.actor), await of(x.lead), await of(x.boss), await of(x.author), await of(x.stranger), await of(x.other)])
        .toEqual([[], ['accept', 'return'], [], [], [], []]);
    }));

  it('исполнитель: без tasks.assign — только себя; снять себя — пока не взял в работу; с правом — любого', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      await expectStatus(svc.createTask(tx, x.actor, { title: 'Другому', categoryId: x.project.id, assigneeId: x.other.id }), 'NO_ASSIGN', 403);
      let t = await svc.createTask(tx, x.actor, { title: 'Себе', categoryId: x.project.id, assigneeId: x.staff.id });
      await expectStatus(svc.updateTask(tx, x.actor, t.id, { version: t.version, assigneeId: x.other.id }), 'NO_ASSIGN', 403);
      await expectStatus(svc.updateTask(tx, x.other, t.id, { version: t.version, assigneeId: null }), 'NO_ASSIGN', 403);
      t = await act(tx, x.actor, t, 'start');
      await expectStatus(svc.updateTask(tx, x.actor, t.id, { version: t.version, assigneeId: null }), 'TASK_TAKEN', 403);
      // Начальник меняет исполнителя у задачи «В работе» — снова «Поставленные».
      t = await svc.updateTask(tx, x.boss, t.id, { version: t.version, assigneeId: x.other.id });
      expect([t.status.systemKey, t.assignee?.id]).toEqual(['assigned', x.other.id]);
      // Новый исполнитель снимает себя, пока не взял в работу.
      t = await svc.updateTask(tx, x.other, t.id, { version: t.version, assigneeId: null });
      expect([t.status.systemKey, t.assignee]).toEqual(['new', null]);
    }));

  it('свободная смена статуса: без tasks.status.override — 403; с правом — признаки колонки действуют; снятый признак — без комментария', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      const done = await statusIdOf(tx, 'done');
      let t = await svc.createTask(tx, x.boss, { title: 'Обход', categoryId: x.project.id, assigneeId: x.staff.id });
      await expectStatus(svc.updateTask(tx, x.actor, t.id, { version: t.version, statusId: done }), 'NO_OVERRIDE', 403);
      await expectStatus(svc.updateTask(tx, x.boss, t.id, { version: t.version, statusId: done }), 'COMMENT_REQUIRED', 400);
      t = await svc.updateTask(tx, x.boss, t.id, { version: t.version, statusId: done, comment: 'Закрыта решением начальника' });
      expect(t.completedAt).not.toBeNull();
      // Переоткрыть — возврат в «В работе»: комментарий по признаку «при возврате».
      const work = await statusIdOf(tx, 'work');
      await expectStatus(svc.updateTask(tx, x.boss, t.id, { version: t.version, statusId: work }), 'COMMENT_REQUIRED', 400);
      t = await svc.updateTask(tx, x.boss, t.id, { version: t.version, statusId: work, comment: 'Переоткрыта' });
      expect(t.completedAt).toBeNull();
      const last = (await transitions(tx, t.id)).at(-1);
      expect([last?.kind, last?.comment]).toEqual(['override', 'Переоткрыта']);

      // Администратор снял признак у «На проверке» — «Отправить на проверку» без комментария.
      await tx.catalogItem.update({ where: { id: await statusIdOf(tx, 'review') }, data: { commentForward: false } });
      expect((await act(tx, x.actor, t, 'submit')).status.systemKey).toBe('review');
    }));

  it('своя колонка: попасть в неё — только свободной сменой; её признак комментария действует', () =>
    inTx(async (tx) => {
      const x = await team(tx);
      // Своя колонка между «В работе» и «На проверке».
      const workItem = await tx.catalogItem.findUniqueOrThrow({ where: { id: await statusIdOf(tx, 'work') } });
      await tx.catalogItem.updateMany({ where: { catalogCode: 'task_statuses', sortOrder: { gt: workItem.sortOrder } }, data: { sortOrder: { increment: 1 } } });
      const custom = await tx.catalogItem.create({
        data: { catalogCode: 'task_statuses', value: `Ждём ответа ${Math.random().toString(36).slice(2)}`, sortOrder: workItem.sortOrder + 1, commentForward: true },
      });
      let t = await svc.createTask(tx, x.boss, { title: 'Своя колонка', categoryId: x.project.id, assigneeId: x.staff.id });
      t = await act(tx, x.actor, t, 'start');
      await expectStatus(svc.updateTask(tx, x.actor, t.id, { version: t.version, statusId: custom.id }), 'NO_OVERRIDE', 403);
      await expectStatus(svc.updateTask(tx, x.boss, t.id, { version: t.version, statusId: custom.id }), 'COMMENT_REQUIRED', 400);
      t = await svc.updateTask(tx, x.boss, t.id, { version: t.version, statusId: custom.id, comment: 'Ждём ДИКТ' });
      expect((await withActions(tx, x.actor, [t]))[0]?.actions).toEqual([]);
      await expectStatus(act(tx, x.actor, t, 'submit', 'готово'), 'WRONG_STATUS', 409);
    }));
});

describe('проверяющий по задаче (1.4.0, ADR-0028)', () => {
  /** Начальник (override) ← исполнитель; руководитель группы (без override) ← второй исполнитель; посторонний начальник. */
  async function crew(tx: Tx) {
    const x = await setup(tx);
    const boss = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник' });
    const lead = await makeUser(tx, ['ib_staff'], { fullName: 'Руководитель группы', manager: { connect: { id: boss.id } } });
    await tx.user.update({ where: { id: x.staff.id }, data: { managerId: boss.id } });
    await tx.user.update({ where: { id: x.other.id }, data: { managerId: lead.id } });
    const head2 = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Другой начальник' });
    const admin = await makeUser(tx, ['super_admin'], { fullName: 'Администратор' });
    const a = (u: { id: string }) => actorFor(tx, u.id);
    return { ...x, bossU: boss, leadU: lead, boss: await a(boss), lead: await a(lead), head2: await a(head2), otherA: await a(x.other), admin: await a(admin) };
  }
  const inWork = async (tx: Tx, by: TaskActor, assignee: TaskActor, projectId: string) => {
    const t = await svc.createTask(tx, by, { title: 'Работа', categoryId: projectId, assigneeId: assignee.id });
    return runAction(tx, assignee, t.id, 'start', { version: t.version });
  };

  it('override: «В работе» → «Выполнено» при руководителе — 409; без — можно; в «На проверке» — с вычислением проверяющего, некому — 409', () =>
    inTx(async (tx) => {
      const x = await crew(tx);
      const [done, review] = [await statusIdOf(tx, 'done'), await statusIdOf(tx, 'review')];
      const t = await inWork(tx, x.boss, x.actor, x.project.id);
      await expectStatus(svc.updateTask(tx, x.head2, t.id, { version: t.version, statusId: done, comment: 'закрыть' }), 'REVIEW_REQUIRED', 409);
      // Перетащили в «На проверке» — проверяющий вычислен и зафиксирован, ему «ждёт вашей проверки».
      const r = await svc.updateTask(tx, x.head2, t.id, { version: t.version, statusId: review, comment: 'на проверку' });
      expect(r.reviewer?.id).toBe(x.bossU.id);
      expect((await transitions(tx, t.id)).at(-1)?.reviewerId).toBe(x.bossU.id);
      expect(await tx.notification.count({ where: { userId: x.bossU.id, taskId: t.id, kind: 'task_submitted' } })).toBe(1);
      // Из «На проверке» переносит только проверяющий.
      await expectStatus(svc.updateTask(tx, x.head2, t.id, { version: r.version, statusId: done, comment: 'да' }), 'NOT_REVIEWER', 403);
      const closed = await svc.updateTask(tx, x.boss, t.id, { version: r.version, statusId: done, comment: 'Принято' });
      expect([closed.status.systemKey, (await tx.task.findUniqueOrThrow({ where: { id: t.id } })).reviewerId]).toEqual(['done', null]);

      // Исполнитель без руководителя: «В работе» → «Выполнено» можно, в «На проверке» — некому проверять.
      const lone = await inWork(tx, x.head2, await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id), x.project.id);
      await expectStatus(svc.updateTask(tx, x.head2, lone.id, { version: lone.version, statusId: review, comment: 'проверка' }), 'NO_REVIEWER', 409);
      expect((await svc.updateTask(tx, x.head2, lone.id, { version: lone.version, statusId: done, comment: 'закрыто' })).status.systemKey).toBe('done');
    }));

  it('«Заменить проверяющего»: только с override, только «На проверке», не исполнитель; переход, журнал, уведомление; прежний больше не принимает', () =>
    inTx(async (tx) => {
      const x = await crew(tx);
      let t = await inWork(tx, x.boss, x.otherA, x.project.id);
      await expectStatus(replaceReviewer(tx, x.head2, t.id, { version: t.version, reviewerId: x.bossU.id }), 'WRONG_STATUS', 409);
      t = await runAction(tx, x.otherA, t.id, 'submit', { version: t.version, comment: 'готово' });
      expect(t.reviewer?.id).toBe(x.leadU.id);
      await expectStatus(replaceReviewer(tx, x.lead, t.id, { version: t.version, reviewerId: x.bossU.id }), 'NO_OVERRIDE', 403);
      await expectStatus(replaceReviewer(tx, x.head2, t.id, { version: t.version, reviewerId: x.other.id }), 'OWN_TASK', 409);
      await expectStatus(replaceReviewer(tx, x.head2, t.id, { version: t.version, reviewerId: x.leadU.id }), 'SAME_REVIEWER', 409);
      const reader = await makeUser(tx, [], { fullName: 'Без доступа к ИБ' });
      await expectStatus(replaceReviewer(tx, x.head2, t.id, { version: t.version, reviewerId: reader.id }), 'BAD_REVIEWER', 400);
      t = await replaceReviewer(tx, x.head2, t.id, { version: t.version, reviewerId: x.bossU.id, comment: 'Руководитель группы в отпуске' });
      expect(t.reviewer?.fullName).toBe('Начальник');
      const last = (await transitions(tx, t.id)).at(-1);
      expect([last?.kind, last?.fromStatus?.systemKey, last?.toStatus.systemKey, last?.reviewerId]).toEqual(['override', 'review', 'review', x.bossU.id]);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { entityId: t.id, action: 'task.reviewer_replaced' } });
      expect((audit.diff as { summary: string }).summary).toBe(`Задача #${t.number}: проверяющий заменён (Руководитель группы → Начальник)`);
      expect(await tx.notification.count({ where: { userId: x.bossU.id, taskId: t.id, kind: 'task_submitted' } })).toBe(1);
      await expectStatus(runAction(tx, x.lead, t.id, 'accept', { version: t.version, comment: 'да' }), 'NOT_REVIEWER', 403);
      expect((await runAction(tx, x.boss, t.id, 'accept', { version: t.version, comment: 'да' })).status.systemKey).toBe('done');
    }));

  it('проверяющего отключили — задачи к следующему по цепочке («проверяющий заменён», уведомление); выше никого — без проверяющего', () =>
    inTx(async (tx) => {
      const x = await crew(tx);
      let t = await inWork(tx, x.boss, x.otherA, x.project.id);
      t = await runAction(tx, x.otherA, t.id, 'submit', { version: t.version, comment: 'готово' });
      const lead = await tx.user.findUniqueOrThrow({ where: { id: x.leadU.id } });
      await setActive(tx, x.admin, lead.id, lead.version, false);
      let row = await svc.getTask(tx, t.id);
      expect(row.reviewer?.id).toBe(x.bossU.id);
      const last = (await transitions(tx, t.id)).at(-1);
      expect([last?.kind, last?.reviewerId, last?.actorId]).toEqual(['system', x.bossU.id, x.admin.id]);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { entityId: t.id, action: 'task.reviewer_replaced' } });
      expect((audit.diff as { summary: string }).summary).toBe(`Задача #${t.number}: проверяющий заменён — Руководитель группы отключён → Начальник`);
      expect(await tx.notification.count({ where: { userId: x.bossU.id, taskId: t.id, kind: 'task_submitted' } })).toBe(1);

      // Отключили и начальника — выше никого: проверяющий снят, задача по правилам до 1.4.0, комментарий в ленте.
      const boss = await tx.user.findUniqueOrThrow({ where: { id: x.bossU.id } });
      await setActive(tx, x.admin, boss.id, boss.version, false);
      row = await svc.getTask(tx, t.id);
      expect(row.reviewer).toBeNull();
      const comments = await svc.listComments(tx, t.id);
      expect(comments.at(-1)?.body).toBe('Проверяющий Начальник отключён, выше по цепочке никого: назначьте проверяющего');
    }));
});

describe('обновление на 1.4.0: шаг seed tasks.reviewer.v1_4', () => {
  it('задачам на проверке без проверяющего — по текущей цепочке; без цепочки и удалённые — не трогает; повтор ничего не меняет', () =>
    inTx(async (tx) => {
      await tx.seedMarker.deleteMany({ where: { key: 'tasks.reviewer.v1_4' } });
      const x = await setup(tx);
      const boss = await makeUser(tx, ['ib_staff'], { fullName: 'Начальник отдела' });
      await tx.user.update({ where: { id: x.staff.id }, data: { managerId: boss.id } });
      const review = await statusIdOf(tx, 'review');
      const prio = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_priorities', systemKey: 'normal' } });
      const make = (assigneeId: string, extra: object = {}) =>
        tx.task.create({ data: { title: 'На проверке с 1.3.0', statusId: review, priorityId: prio.id, categoryId: x.project.id, source: 'manual', assigneeId, ...extra } });
      const chained = await make(x.staff.id);
      const lone = await make(x.other.id);
      const deleted = await make(x.staff.id, { deletedAt: new Date() });

      await seedTaskReviewers(tx);
      const reviewerOf = async (id: string) => (await tx.task.findUniqueOrThrow({ where: { id } })).reviewerId;
      expect([await reviewerOf(chained.id), await reviewerOf(lone.id), await reviewerOf(deleted.id)]).toEqual([boss.id, null, null]);
      const tr = await tx.taskTransition.findFirstOrThrow({ where: { taskId: chained.id } });
      expect([tr.kind, tr.fromStatusId, tr.toStatusId, tr.reviewerId, tr.actorId]).toEqual(['migration', review, review, boss.id, null]);
      expect(tr.comment).toBe('Проверяющий назначен при обновлении на 1.4.0: Начальник отдела');
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: 'tasks.reviewers_assigned' }, orderBy: { id: 'desc' } });
      const after = (audit.diff as { after: { assigned: { id: string }[]; legacy: number[] } }).after;
      expect(after.assigned.map((a) => a.id)).toContain(chained.id);
      expect(after.legacy).toContain(lone.number);

      const before = await tx.taskTransition.count();
      await seedTaskReviewers(tx);
      expect(await tx.taskTransition.count()).toBe(before);
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
