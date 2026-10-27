import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { RECIPIENTS_CATALOG } from '../../lib/catalogs.js';
import { argon2Hasher } from '../../lib/passwords.js';
import type { Values } from '../../lib/register-values.js';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_SECRET } from '../../test/helpers.js';
import { vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as automations from '../automations/service.js';
import * as catalogs from '../catalogs/service.js';
import * as records from '../registers/records.service.js';
import * as structure from '../registers/structure.service.js';
import * as svc from './service.js';

const DEC_1 = new Date('2026-12-01T06:00:00Z');

async function label(tx: Tx, value: string) {
  return tx.catalogItem.findFirstOrThrow({ where: { catalogCode: RECIPIENTS_CATALOG, value, deletedAt: null } });
}

async function setLabel(tx: Tx, x: VulnFixture, value: string, input: { memberIds?: string[]; emails?: string[] }) {
  const item = await label(tx, value);
  return catalogs.updateItem(tx, x.actor, item.id, { version: item.version, ...input });
}

async function vuln(tx: Tx, x: VulnFixture, cve: string, extra: Values = {}) {
  // Уведомлено 01.10 + 14 дней (критическая) = срок 15.10: к 01.12 просрочено больше 10 рабочих дней.
  return records.createRecord(tx, x.actor, x.reg.id, {
    values: { [x.vf.cve.id]: cve, [x.vf.notified.id]: '2026-10-01', [x.vf.crit.id]: x.opt('crit', 'critical'), ...extra },
  });
}

async function tasksOf(tx: Tx, recordId: string) {
  const rows = await tx.task.findMany({
    where: { recordId, deletedAt: null },
    include: { automation: { select: { systemKey: true } }, assignee: { select: { fullName: true } }, priority: true },
    orderBy: { number: 'asc' },
  });
  return rows.map((t) => ({ ...t, rule: t.automation?.systemKey ?? null, who: t.assignee?.fullName ?? null }));
}

const whoByRule = (list: Awaited<ReturnType<typeof tasksOf>>, rule: string) =>
  list.filter((t) => t.rule === rule).map((t) => t.who ?? `не назначен: ${t.recipientLabel}`).sort();

describe('события автоматизаций → задачи', () => {
  it('метка → её пользователи; пустая или только e-mail — задача без ответственного; владелец системы — по полю «Система»', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const dikt1 = await makeUser(tx, ['ib_staff'], { fullName: 'ДИКТ Первый' });
      const dikt2 = await makeUser(tx, ['ib_staff'], { fullName: 'ДИКТ Второй' });
      const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Владелец АБС' });
      const outsider = await makeUser(tx, ['legal'], { fullName: 'Без доступа к ИБ' });

      // Участники — только с ib.work; остальных — e-mail.
      await expectCode(setLabel(tx, x, 'Руководитель ДИКТ', { memberIds: [dikt1.id, outsider.id] }), 'NOT_IB_USER');
      const err = await setLabel(tx, x, 'Руководитель ДИКТ', { memberIds: [outsider.id] }).catch((e: Error) => e.message);
      expect(err).toMatch(/Без доступа к ИБ: нет доступа к разделам ИБ.*Укажите его e-mail/);
      const dikt = await setLabel(tx, x, 'Руководитель ДИКТ', { memberIds: [dikt1.id, dikt2.id], emails: [' DIKT@example.tj ', 'dikt@example.tj'] });
      expect([dikt.members.map((m) => m.fullName).sort(), dikt.emails]).toEqual([['ДИКТ Второй', 'ДИКТ Первый'], ['dikt@example.tj']]);
      await expectCode(setLabel(tx, x, 'Руководство Банка', { emails: ['не адрес'] }), 'BAD_EMAIL');
      await setLabel(tx, x, 'Руководство Банка', { emails: ['board@example.tj'] }); // только e-mail
      await expectCode(setLabel(tx, x, 'Владелец системы', { memberIds: [dikt1.id] }), 'SYSTEM_OWNER_LABEL');

      // Системы и их владельцы: с ib.work, без ib.work, без владельца.
      const abs = await catalogs.createItem(tx, x.actor, 'systems', { value: 'АБС тест', ownerUserId: owner.id });
      const mail = await catalogs.createItem(tx, x.actor, 'systems', { value: 'Почта тест', ownerUserId: outsider.id });
      const none = await catalogs.createItem(tx, x.actor, 'systems', { value: 'Сайт тест' });
      expect(abs.owner?.fullName).toBe('Владелец АБС');
      await x.reload();

      const a = await vuln(tx, x, 'A', { [x.vf.system.id]: abs.id });
      const b = await vuln(tx, x, 'B', { [x.vf.system.id]: mail.id });
      const c = await vuln(tx, x, 'C', { [x.vf.system.id]: none.id });
      const d = await vuln(tx, x, 'D'); // система не указана

      const run = await automations.runAutomations(tx, { now: DEC_1, registerId: x.reg.id });
      expect(run).toMatchObject({ ran: true, created: 8 }); // по 2 события (уведомление и эскалация) на запись
      expect(await tx.automationEvent.count({ where: { registerId: x.reg.id, status: 'new' } })).toBe(0);

      const ta = await tasksOf(tx, a.id);
      expect(whoByRule(ta, 'vuln.overdue_notify')).toEqual(['Владелец АБС', 'ДИКТ Второй', 'ДИКТ Первый']);
      // Эскалация: «Руководство Банка» — только e-mail, «Начальник ИБ» — пустая → одна задача без ответственного.
      expect(whoByRule(ta, 'vuln.overdue_escalate')).toEqual(['не назначен: Руководство Банка, Начальник ИБ']);
      const esc = must(ta.find((t) => t.rule === 'vuln.overdue_escalate'));
      expect([esc.priority.systemKey, esc.dueDate?.toISOString().slice(0, 10), esc.source]).toEqual(['high', '2026-12-02', 'automation']);
      const card = await svc.getTask(tx, esc.id);
      expect(card.recipients).toEqual([{ label: 'Руководство Банка', emails: ['board@example.tj'] }, { label: 'Начальник ИБ', emails: [] }]);
      expect(card.record).toMatchObject({ id: a.id, number: a.number, title: 'A', registerName: x.reg.name });
      expect(card.assignee).toBeNull();
      const notifyDikt = must(ta.find((t) => t.who === 'ДИКТ Первый'));
      expect(notifyDikt.title).toBe(`Уведомление: «Срок устранения» просрочен — #${a.number} A`);
      expect(notifyDikt.dueDate?.toISOString().slice(0, 10)).toBe('2026-12-04'); // 3 рабочих дня

      // Владелец без ib.work, система без владельца, система не указана — «Владелец системы» без ответственного.
      for (const r of [b, c, d]) {
        expect(whoByRule(await tasksOf(tx, r.id), 'vuln.overdue_notify')).toEqual(['ДИКТ Второй', 'ДИКТ Первый', 'не назначен: Владелец системы']);
      }

      // Событие показывает свои задачи.
      const ev = (await automations.listEvents(tx, x.reg.id, { recordId: a.id, limit: 10 })).items.find((e) => e.eventType === 'notify');
      expect(ev?.tasks.map((t) => t.action)).toEqual(['created', 'created', 'created']);
      // Журнал задачи: создана автоматизацией, без автора.
      const history = await svc.taskHistory(tx, esc.id);
      expect([history[0]?.actor, history[0]?.summary]).toEqual([null, expect.stringMatching(/создана автоматизацией.*не назначен/)]);
    }));

  it('повторная обработка дублей не создаёт; открытая задача по тому же правилу — комментарий; после «Готово» — новая задача', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const dikt1 = await makeUser(tx, ['ib_staff'], { fullName: 'ДИКТ Первый' });
      const dikt2 = await makeUser(tx, ['ib_staff'], { fullName: 'ДИКТ Второй' });
      await setLabel(tx, x, 'Руководитель ДИКТ', { memberIds: [dikt1.id, dikt2.id] });
      const a = await vuln(tx, x, 'A');

      await automations.runAutomations(tx, { now: DEC_1, registerId: x.reg.id });
      const count = await tx.task.count({ where: { recordId: a.id } });
      expect(count).toBe(4); // уведомление: ДИКТ ×2 + владелец системы (не назначен); эскалация (не назначен)
      // Повторный прогон и повторная обработка — ничего нового.
      expect(await automations.runAutomations(tx, { now: DEC_1, registerId: x.reg.id })).toMatchObject({ created: 0, tasksCreated: 0, tasksCommented: 0 });
      // Общий прогон 1 декабря запускает и стартовое «Продление разрешений» (seed этапа 8б) — здесь оно не нужно.
      await tx.registerAutomation.updateMany({ where: { condition: { path: ['kind'], equals: 'yearly' } }, data: { enabled: false } });
      expect(await automations.runAutomations(tx, { now: DEC_1 })).toMatchObject({ tasksCreated: 0 });
      expect(await tx.task.count({ where: { recordId: a.id } })).toBe(4);

      // Срок пересмотрен ИБ (меры есть): новое событие «просрочен» с другой датой — в открытые задачи комментарием.
      let rec = await records.updateRecord(tx, x.actor, a.id, {
        version: a.version, values: { [x.vf.measures.id]: 'Правило WAF', [x.vf.newDue.id]: '2026-11-20' },
      });
      const second = await automations.runAutomations(tx, { now: DEC_1, registerId: x.reg.id });
      expect(second).toMatchObject({ created: 1, tasksCreated: 0, tasksCommented: 3 });
      expect(await tx.task.count({ where: { recordId: a.id } })).toBe(4);
      const first = must((await tasksOf(tx, a.id)).find((t) => t.who === 'ДИКТ Первый'));
      const comments = await svc.listComments(tx, first.id);
      expect(comments).toEqual([expect.objectContaining({ automatic: true, author: null, body: expect.stringMatching(/^Повторное срабатывание 2026-12-01/) })]);

      // ДИКТ Первый закрыл задачу — следующее срабатывание создаёт ему новую, остальным — комментарий.
      const actor1 = await actorFor(tx, dikt1.id);
      const doneId = await svc.systemItemId(tx, 'task_statuses', 'done');
      const closed = await svc.updateTask(tx, actor1, first.id, { version: first.version, statusId: doneId });
      expect(closed.completedAt).not.toBeNull();
      rec = await records.updateRecord(tx, x.actor, a.id, { version: rec.version, values: { [x.vf.newDue.id]: '2026-11-25' } });
      expect(await automations.runAutomations(tx, { now: DEC_1, registerId: x.reg.id })).toMatchObject({ created: 1, tasksCreated: 1, tasksCommented: 2 });
      expect((await tasksOf(tx, a.id)).filter((t) => t.who === 'ДИКТ Первый')).toHaveLength(2);
      // Закрытая запись событий больше не даёт.
      await records.updateRecord(tx, x.actor, a.id, { version: rec.version, values: { [x.vf.status.id]: x.opt('status', 'fixed'), [x.vf.newDue.id]: '2026-11-26' } });
      expect(await automations.runAutomations(tx, { now: DEC_1, registerId: x.reg.id })).toMatchObject({ created: 0, tasksCreated: 0 });
    }));

  it('правило ссылается на метку по id: переименование не отвязывает; системная метка не удаляется; используемая система не удаляется', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const duty = await makeUser(tx, ['ib_staff'], { fullName: 'Дежурный Первый' });
      const custom = await catalogs.createItem(tx, x.actor, RECIPIENTS_CATALOG, { value: 'Дежурный ДИКТ', memberIds: [duty.id], emails: ['duty@example.tj'] });
      // Старый клиент присылает название — сохраняется id метки.
      const rule = await automations.createRule(tx, x.actor, x.reg.id, {
        condition: { kind: 'overdue', fieldId: x.vf.due.id },
        action: { eventType: 'notify', recipients: [{ kind: 'label', label: 'дежурный дикт' }] },
      });
      expect(rule.action.recipients).toEqual([{ kind: 'label', itemId: custom.id, label: 'Дежурный ДИКТ', missing: false }]);
      const stored = await tx.registerAutomation.findUniqueOrThrow({ where: { id: rule.id } });
      expect((stored.action as { recipients: unknown[] }).recipients).toEqual([{ kind: 'label', itemId: custom.id, label: 'Дежурный ДИКТ' }]);

      // Переименование метки, которая используется в правиле, — можно; правило показывает новое название и ставит задачи её участникам.
      const renamed = await catalogs.updateItem(tx, x.actor, custom.id, { version: custom.version, value: 'Дежурная смена ДИКТ' });
      expect(renamed.usage).toBe(1);
      const [after] = (await automations.listRules(tx, x.reg.id, { includeArchived: false })).filter((r) => r.id === rule.id);
      expect([after?.then, after?.recipientMissing]).toEqual(['Уведомить: Дежурная смена ДИКТ', false]);
      const a = await vuln(tx, x, 'R');
      await automations.runAutomations(tx, { now: DEC_1, registerId: x.reg.id });
      const ta = (await tasksOf(tx, a.id)).filter((t) => t.automationId === rule.id);
      expect(ta.map((t) => [t.who, t.recipientLabel])).toEqual([['Дежурный Первый', 'Дежурная смена ДИКТ']]);
      // Используемую метку не удалить — только архив; системную — ни то, ни другое.
      await expectCode(catalogs.deleteItem(tx, x.actor, custom.id, renamed.version), 'IN_USE');
      const sysLabel = await label(tx, 'Руководитель ДИКТ');
      await expectCode(catalogs.deleteItem(tx, x.actor, sysLabel.id, sysLabel.version), 'SYSTEM_VALUE');
      await expectCode(catalogs.archiveItem(tx, x.actor, sysLabel.id, sysLabel.version), 'SYSTEM_VALUE');

      await expectCode(automations.createRule(tx, x.actor, x.reg.id, {
        condition: { kind: 'before', fieldId: x.vf.due.id, days: 1 }, action: { eventType: 'remind', recipients: [{ kind: 'label', label: 'Нет такой' }] },
      }), 'BAD_RULE');
      const outsider = await makeUser(tx, ['legal']);
      await expectCode(automations.createRule(tx, x.actor, x.reg.id, {
        condition: { kind: 'before', fieldId: x.vf.due.id, days: 1 }, action: { eventType: 'remind', recipients: [{ kind: 'user', userId: outsider.id }] },
      }), 'BAD_RULE');

      const sys = await catalogs.createItem(tx, x.actor, 'systems', { value: 'Процессинг тест' });
      await x.reload();
      await vuln(tx, x, 'S', { [x.vf.system.id]: sys.id });
      await expectCode(catalogs.deleteItem(tx, x.actor, sys.id, sys.version), 'IN_USE');
      // Поле «Значение справочника»: справочник обязателен и не любой; в него не превратить другое поле.
      await expectCode(structure.addField(tx, x.actor, x.reg.id, { label: 'Ещё система', type: 'catalog' }), 'NO_CATALOG');
      await expectCode(structure.addField(tx, x.actor, x.reg.id, { label: 'Метка', type: 'catalog', catalogCode: RECIPIENTS_CATALOG }), 'NO_CATALOG');
      const reg = await structure.addField(tx, x.actor, x.reg.id, { label: 'Тип документа', type: 'catalog', catalogCode: 'document_types' });
      const docField = must(reg.fields.find((f) => f.label === 'Тип документа'));
      expect(docField.options.map((o) => o.label)).toContain('Политика');
      await expectCode(structure.addOption(tx, x.actor, docField.id, { label: 'Своё' }), 'NO_OPTIONS');
      const own = must((await structure.addField(tx, x.actor, x.reg.id, { label: 'Заметка', type: 'text' })).fields.find((f) => f.label === 'Заметка'));
      await expectCode(structure.previewTypeChange(tx, own.id, 'catalog'), 'TYPE_CHANGE_FORBIDDEN');
      // «Значение справочника» → текст можно (подпись значения).
      expect((await structure.previewTypeChange(tx, docField.id, 'text')).kind).toBe('empty');
    }));
});

describe('перенос текстовых меток в правилах на id (миграция rule_recipient_ids)', () => {
  it('найденная метка получает id; ненайденная — «получатель не найден», правило работает; повторный перенос ничего не ломает', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const dikt = await makeUser(tx, ['ib_staff'], { fullName: 'ДИКТ Старый' });
      await setLabel(tx, x, 'Руководитель ДИКТ', { memberIds: [dikt.id] });
      // Правило в формате этапов 4–5: метки — только по названию.
      const legacy = await tx.registerAutomation.create({
        data: {
          registerId: x.reg.id, createdBy: x.actor.id,
          condition: { kind: 'overdue', fieldId: x.vf.due.id },
          action: { eventType: 'notify', recipients: [{ kind: 'label', label: ' руководитель  дикт ' }, { kind: 'label', label: 'Удалённая метка' }, { kind: 'field', fieldId: x.vf.owner.id }] },
        },
      });
      const [first] = await tx.$queryRaw<{ n: number }[]>`SELECT link_recipient_labels() AS n`;
      expect(first?.n).toBeGreaterThanOrEqual(1);
      const diktItem = await label(tx, 'Руководитель ДИКТ');
      const moved = await tx.registerAutomation.findUniqueOrThrow({ where: { id: legacy.id } });
      expect((moved.action as { recipients: unknown[] }).recipients).toEqual([
        { kind: 'label', label: ' руководитель  дикт ', itemId: diktItem.id },
        { kind: 'label', label: 'Удалённая метка', itemId: null },
        { kind: 'field', fieldId: x.vf.owner.id },
      ]);
      expect(moved.version).toBe(legacy.version);
      // Повторный вызов (seed) не трогает привязанные метки.
      await tx.$queryRaw`SELECT link_recipient_labels()`;
      expect((await tx.registerAutomation.findUniqueOrThrow({ where: { id: legacy.id } })).action).toEqual(moved.action);

      // В «Автоматизации» видно «получатель не найден»; правило срабатывает: по найденной метке — задача участнику,
      // по ненайденной — задача без ответственного.
      const dto = must((await automations.listRules(tx, x.reg.id, { includeArchived: false })).find((r) => r.id === legacy.id));
      expect(dto.recipientMissing).toBe(true);
      expect(dto.then).toBe('Уведомить: Руководитель ДИКТ, Удалённая метка (получатель не найден), Ответственный');
      const a = await vuln(tx, x, 'L');
      await automations.runAutomations(tx, { now: DEC_1, registerId: x.reg.id });
      const ta = (await tasksOf(tx, a.id)).filter((t) => t.automationId === legacy.id);
      expect(ta.map((t) => t.who ?? `не назначен: ${t.recipientLabel}`).sort()).toEqual([
        'ДИКТ Старый', 'не назначен: «Удалённая метка»: получатель не найден, «Ответственный» не назначен',
      ]);
    }));
});

describe('задачи', () => {
  it('доска: создать, правка с версией, «Готово», архив; ответственный — только сотрудник ИБ; комментарии и история', () =>
    inTx(async (tx) => {
      const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Сотрудник ИБ' });
      const outsider = await makeUser(tx, ['legal']);
      const actor = await actorFor(tx, staff.id);
      const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
      await expectCode(svc.createTask(tx, actor, { title: 'Х', categoryId: project.id, assigneeId: outsider.id }), 'BAD_ASSIGNEE');
      await expectCode(svc.createTask(tx, actor, { title: '  ', categoryId: project.id }), 'EMPTY_TITLE');
      const t = await svc.createTask(tx, actor, { title: 'Проверить права в АБС', categoryId: project.id, assigneeId: staff.id, dueDate: '2020-01-10' });
      expect([t.status.systemKey, t.priority.systemKey, t.source, t.overdue]).toEqual(['new', 'normal', 'manual', true]);
      expect((await svc.taskSummary(tx, staff.id)).overdueMine).toBeGreaterThanOrEqual(1);

      const work = await svc.systemItemId(tx, 'task_statuses', 'work');
      const moved = await svc.updateTask(tx, actor, t.id, { version: t.version, statusId: work, dueDate: '2099-01-01' });
      expect([moved.status.value, moved.overdue, moved.version]).toEqual(['В работе', false, t.version + 1]);
      await expectCode(svc.updateTask(tx, actor, t.id, { version: t.version, title: 'старая версия' }), 'VERSION_CONFLICT');
      const done = await svc.updateTask(tx, actor, t.id, { version: moved.version, statusId: await svc.systemItemId(tx, 'task_statuses', 'done') });
      expect(done.completedAt).not.toBeNull();
      const reopened = await svc.updateTask(tx, actor, t.id, { version: done.version, statusId: work });
      expect(reopened.completedAt).toBeNull();

      await svc.addComment(tx, actor, t.id, 'Права проверены, жду ответа ДИКТ');
      await expectCode(svc.addComment(tx, actor, t.id, '   '), 'EMPTY_COMMENT');
      const history = await svc.taskHistory(tx, t.id);
      expect(history.map((h) => h.action)).toEqual(['task.commented', 'task.updated', 'task.updated', 'task.updated', 'task.created']);
      expect(history[3]?.changes).toEqual([{ label: 'Статус', from: 'Новые', to: 'В работе' }, { label: 'Срок', from: '10.01.2020', to: '01.01.2099' }]);

      const archived = await svc.setTaskArchived(tx, actor, t.id, reopened.version, true);
      await expectCode(svc.updateTask(tx, actor, t.id, { version: archived.version, title: 'нельзя' }), 'TASK_ARCHIVED');
      expect((await svc.listTasks(tx, { archived: true, limit: 50 })).items.map((x) => x.id)).toContain(t.id);
      expect((await svc.listTasks(tx, { archived: false, limit: 500 })).items.map((x) => x.id)).not.toContain(t.id);
      await svc.setTaskArchived(tx, actor, t.id, archived.version, false);
    }));

  it('«Почта → задача»: черновик по правилу, создание из письма с исходным письмом', () =>
    inTx(async (tx) => {
      const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Дилшод Доступ' });
      const actor = await actorFor(tx, staff.id);
      const rule = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'mail_rules', value: 'Доступ' } });
      await tx.catalogItem.update({ where: { id: rule.id }, data: { ownerUserId: staff.id } });
      const raw = 'От: Отдел кадров <hr@example.tj>\nОтправлено: 01.12.2026 09:00\nТема: RE: Увольнение — блокировка учётной записи\n\nСрочно заблокируйте доступ.';
      const draft = await svc.mailDraft(tx, raw);
      expect(draft).toMatchObject({
        title: 'Увольнение — блокировка учётной записи', from: 'Отдел кадров <hr@example.tj>', urgent: true,
        rule: { label: 'Доступ' }, assignee: { id: staff.id, fullName: 'Дилшод Доступ' },
      });
      expect(draft.assigneeReason).toMatch(/^по правилу «Доступ»/);
      await expectCode(svc.mailDraft(tx, '  '), 'EMPTY_MAIL');

      const t = await svc.createTask(tx, actor, {
        title: draft.title, description: draft.body, assigneeId: staff.id, dueDate: draft.dueDate, priorityId: draft.priorityId, mail: { raw },
      });
      expect([t.source, t.category.systemKey, t.priority.systemKey]).toEqual(['mail', 'mail', 'high']);
      const card = await svc.getTask(tx, t.id);
      expect(card.mail).toMatchObject({ from: 'Отдел кадров <hr@example.tj>', sent: '01.12.2026 09:00', rule: { label: 'Доступ' }, dueReason: draft.dueReason });
      expect(card.mail?.ruleHits).toEqual(expect.arrayContaining(['доступ', 'увольн']));
      // Используемое правило почты и категория не удаляются.
      await expectCode(catalogs.deleteItem(tx, actor, rule.id, rule.version), 'IN_USE');
    }));

  it('права: задачи — ib.work; удаление — только «Задачи: удаление»', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Http-Task-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const lawyer = await makeUser(tx, ['legal'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const [A, S, L] = [await login(admin.login), await login(staff.login), await login(lawyer.login)];
      const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });

      const created = await app.inject({ method: 'POST', url: '/api/v1/tasks', headers: { cookie: S }, payload: { title: 'HTTP задача', categoryId: project.id, assigneeId: staff.id } });
      expect(created.statusCode).toBe(201);
      const t = created.json() as { id: string; version: number };
      expect((await app.inject({ url: '/api/v1/tasks', headers: { cookie: S } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/v1/tasks/summary', headers: { cookie: S } })).statusCode).toBe(200);
      const archived = await app.inject({ method: 'POST', url: `/api/v1/tasks/${t.id}/archive`, headers: { cookie: S }, payload: { version: t.version } });
      expect(archived.statusCode).toBe(200);
      const v = (archived.json() as { version: number }).version;
      expect((await app.inject({ method: 'POST', url: `/api/v1/tasks/${t.id}/delete`, headers: { cookie: S }, payload: { version: v } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/v1/tasks', headers: { cookie: L } })).statusCode).toBe(403);
      // Владелец системы — любой активный пользователь: список с отметкой доступа к разделам ИБ.
      const all = (await app.inject({ url: '/api/v1/users/options?scope=all', headers: { cookie: S } })).json() as { items: { id: string; ibWork: boolean }[] };
      expect([all.items.find((u) => u.id === lawyer.id)?.ibWork, all.items.find((u) => u.id === staff.id)?.ibWork]).toEqual([false, true]);
      const ib = (await app.inject({ url: '/api/v1/users/options', headers: { cookie: S } })).json() as { items: { id: string }[] };
      expect(ib.items.some((u) => u.id === lawyer.id)).toBe(false);
      expect((await app.inject({ method: 'POST', url: '/api/v1/tasks/mail-draft', headers: { cookie: L }, payload: { raw: 'x' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/v1/tasks/${t.id}/delete`, headers: { cookie: A }, payload: { version: v } })).statusCode).toBe(204);
      expect((await app.inject({ url: `/api/v1/tasks/${t.id}`, headers: { cookie: A } })).statusCode).toBe(404);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { entity: 'task', entityId: t.id, action: 'task.deleted' } });
      expect(audit.userId).toBe(admin.id);
    }));
});
