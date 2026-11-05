// Схема учебных писем (1.9.0, миграция awareness_letters) с настоящей БД под ролью приложения: последовательность
// номеров, заморозка отправленного письма (условие владельца 05.11.2026), неизменяемость версий и событий,
// ограничения, а также защита задач и записей, связанных с письмами, от удаления (замечание владельца, п. 3).
// Каждый тест — транзакция с откатом; ожидаемые ошибки SQL — внутри точки сохранения.
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testDbConfig } from '../../../scripts/test-db.js';
import { actorFor, expectCode, inTx, makeUser, must, roleId, type Tx } from '../../test/db.js';
import { makeRegister } from '../../test/registers-fixture.js';
import * as bulkRecords from '../registers/bulk.service.js';
import * as records from '../registers/records.service.js';
import * as taskBulk from '../tasks/bulk.js';
import * as tasks from '../tasks/service.js';

/** Ожидаемая ошибка SQL: транзакция теста после неё жива. */
async function rejects(tx: Tx, sql: string, re: RegExp): Promise<void> {
  await tx.$executeRawUnsafe('SAVEPOINT expect_fail');
  await expect(tx.$executeRawUnsafe(sql)).rejects.toThrow(re);
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT expect_fail');
}

async function draft(tx: Tx, userId: string, o: { kind?: 'planned' | 'urgent'; reason?: string; taskId?: string } = {}) {
  const letter = await tx.awarenessLetter.create({
    data: { title: 'Осторожно: поддельные письма о выигрыше', kind: o.kind ?? 'planned', reason: o.reason ?? '', createdBy: userId, taskId: o.taskId ?? null },
  });
  const v = await tx.awarenessLetterVersion.create({
    data: { letterId: letter.id, no: 1, reason: 'created', subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: '<p>Текст</p>', htmlTj: '<p>Матн</p>', createdBy: userId },
  });
  return tx.awarenessLetter.update({ where: { id: letter.id }, data: { currentVersionId: v.id, version: { increment: 1 } } });
}

/** Отметка «Отправлено» так, как её делает сервис: сначала версия sent, затем заморозка одним UPDATE. */
async function freeze(tx: Tx, letterId: string, userId: string) {
  const sent = await tx.awarenessLetterVersion.create({
    data: { letterId, no: 2, reason: 'sent', subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: '<p>Текст</p><div><p>Отдел ИБ</p></div>', htmlTj: '<p>Матн</p>', createdBy: userId },
  });
  await tx.awarenessLetter.update({
    where: { id: letterId }, data: { status: 'sent', frozen: true, sentVersionId: sent.id, currentVersionId: sent.id, version: { increment: 1 } },
  });
  return sent;
}

async function setup(tx: Tx) {
  const user = await makeUser(tx, ['ib_staff']);
  const actor = await actorFor(tx, user.id);
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  const task = (title: string) => tasks.createTask(tx, actor, { title, categoryId: project.id });
  return { user, actor, task };
}

describe('учебные письма: схема под ролью приложения', () => {
  it('номер письма из последовательности (USAGE у ibportal_app), по возрастанию', () =>
    inTx(async (tx) => {
      const { user } = await setup(tx);
      const a = await draft(tx, user.id);
      const b = await draft(tx, user.id);
      expect(a.number).toBeGreaterThan(0);
      expect(b.number).toBe(a.number + 1);
    }));

  it('заморозка: у отправленного письма не меняются статус, ссылки на версии, название, тип и повод; новых версий нет', () =>
    inTx(async (tx) => {
      const { user } = await setup(tx);
      const l = await draft(tx, user.id);
      const v1 = must(l.currentVersionId);
      await freeze(tx, l.id, user.id);
      const id = `'${l.id}'`;
      await rejects(tx, `UPDATE awareness_letters SET status = 'draft', frozen = false WHERE id = ${id}`, /только архив/);
      await rejects(tx, `UPDATE awareness_letters SET status = 'approved' WHERE id = ${id}`, /только архив/);
      await rejects(tx, `UPDATE awareness_letters SET current_version_id = '${v1}' WHERE id = ${id}`, /только архив/);
      await rejects(tx, `UPDATE awareness_letters SET title = 'Другое', kind = 'urgent', reason = 'x' WHERE id = ${id}`, /только архив/);
      // Тема и текст живут в версиях: новая версия замороженному письму не добавляется, старые не меняются.
      await rejects(tx, `INSERT INTO awareness_letter_versions (letter_id, no, reason, subject_ru, subject_tj, html_ru, html_tj, created_by)
        VALUES (${id}, 3, 'edit', 'Новая тема', '', '<p>новый текст</p>', '', '${user.id}')`, /новых версий нет/);
      await rejects(tx, `UPDATE awareness_letter_versions SET subject_ru = 'Новая тема' WHERE letter_id = ${id}`, /permission denied/);
    }));

  it('заморозка не мешает архиву: замороженное письмо архивируется и возвращается из архива', () =>
    inTx(async (tx) => {
      const { user } = await setup(tx);
      const l = await draft(tx, user.id);
      await freeze(tx, l.id, user.id);
      await tx.$executeRawUnsafe(`UPDATE awareness_letters SET archived_at = now(), version = version + 1, updated_at = now() WHERE id = '${l.id}'`);
      expect((await tx.awarenessLetter.findUniqueOrThrow({ where: { id: l.id } })).archivedAt).not.toBeNull();
      const back = await tx.awarenessLetter.update({ where: { id: l.id }, data: { archivedAt: null, version: { increment: 1 } } });
      expect(back).toMatchObject({ archivedAt: null, frozen: true, status: 'sent' });
      await tx.awarenessLetterEvent.create({ data: { letterId: l.id, action: 'archived', actorId: user.id } });
    }));

  it('версии и события только пополняются; письма, шаблоны, правила и запуски физически не удаляются', () =>
    inTx(async (tx) => {
      const { user } = await setup(tx);
      const l = await draft(tx, user.id);
      await tx.awarenessLetterEvent.create({ data: { letterId: l.id, action: 'submitted', actorId: user.id } });
      await rejects(tx, `UPDATE awareness_letter_versions SET html_ru = '<p>x</p>' WHERE letter_id = '${l.id}'`, /permission denied/);
      await rejects(tx, `DELETE FROM awareness_letter_versions WHERE letter_id = '${l.id}'`, /permission denied/);
      await rejects(tx, `UPDATE awareness_letter_events SET comment = 'x' WHERE letter_id = '${l.id}'`, /permission denied/);
      await rejects(tx, `DELETE FROM awareness_letter_events WHERE letter_id = '${l.id}'`, /permission denied/);
      for (const t of ['awareness_letters', 'awareness_templates', 'awareness_fragments', 'awareness_schedule_rules', 'awareness_schedule_runs']) {
        await rejects(tx, `DELETE FROM ${t}`, /permission denied/);
      }
    }));

  it('ссылки на версии — только своего письма; версия отправки — только reason = sent; отправленное — с версией отправки', () =>
    inTx(async (tx) => {
      const { user } = await setup(tx);
      const a = await draft(tx, user.id);
      const b = await draft(tx, user.id);
      await rejects(tx, `UPDATE awareness_letters SET current_version_id = '${must(b.currentVersionId)}' WHERE id = '${a.id}'`, /версию другого письма/);
      await rejects(tx, `UPDATE awareness_letters SET status = 'sent', frozen = true, sent_version_id = '${must(a.currentVersionId)}' WHERE id = '${a.id}'`, /версией sent/);
      await rejects(tx, `UPDATE awareness_letters SET status = 'sent', frozen = true WHERE id = '${a.id}'`, /awareness_letters_frozen_check/);
      await rejects(tx, `UPDATE awareness_letters SET status = 'approved' WHERE id = '${a.id}'`, /awareness_letters_approved_check/);
    }));

  it('ограничения: повод срочного, события, опережение 7–90, порядок дат запуска, «правило + номинальная дата» уникальны', () =>
    inTx(async (tx) => {
      const { user, task } = await setup(tx);
      await rejects(tx, `INSERT INTO awareness_letters (title, kind, created_by, updated_at) VALUES ('Срочное', 'urgent', '${user.id}', now())`, /awareness_letters_reason_check/);
      const l = await draft(tx, user.id, { kind: 'urgent', reason: 'Новая схема мошенничества' });
      await rejects(tx, `INSERT INTO awareness_letter_events (letter_id, action, actor_id) VALUES ('${l.id}', 'returned', '${user.id}')`, /returned_check/);
      await rejects(tx, `INSERT INTO awareness_letter_events (letter_id, action, actor_id) VALUES ('${l.id}', 'sent', '${user.id}')`, /sent_check/);
      await rejects(tx, `INSERT INTO awareness_letter_events (letter_id, action, sent_on, audience, without_approval, actor_id)
        VALUES ('${l.id}', 'sent', '2026-11-05', 'Все сотрудники', true, '${user.id}')`, /without_approval_check/);

      const role = await roleId(tx, 'ib_staff');
      const rule = (lead: number) => `INSERT INTO awareness_schedule_rules (title, cadence, starts_on, lead_days, role_id, created_by, updated_at)
        VALUES ('Ежемесячная рассылка', '{"kind":"monthly","day":15}', '2026-01-01', ${lead}, '${role}', '${user.id}', now())`;
      await rejects(tx, rule(6), /awareness_schedule_rules_lead_check/);
      await rejects(tx, rule(91), /awareness_schedule_rules_lead_check/);
      await rejects(tx, rule(10).replace('"monthly"', '"daily"'), /awareness_schedule_rules_cadence_check/);
      const r = await tx.awarenessScheduleRule.create({
        data: { title: 'Ежемесячная рассылка', cadence: { kind: 'monthly', day: 15 }, startsOn: new Date('2026-01-01'), leadDays: 7, roleId: role, createdBy: user.id },
      });
      const t1 = await task('Рассылка: тест — 13.11.2026');
      const t2 = await task('Рассылка: тест — 13.11.2026 (дубль)');
      await tx.awarenessScheduleRun.create({
        data: { ruleId: r.id, nominalDate: new Date('2026-11-15'), plannedDate: new Date('2026-11-13'), draftDue: new Date('2026-11-06'), reviewDue: new Date('2026-11-12'), taskId: t1.id },
      });
      await rejects(tx, `INSERT INTO awareness_schedule_runs (rule_id, nominal_date, planned_date, draft_due, review_due, task_id)
        VALUES ('${r.id}', '2026-11-15', '2026-11-13', '2026-11-06', '2026-11-12', '${t2.id}')`, /awareness_schedule_runs_rule_id_nominal_date_key/);
      await rejects(tx, `INSERT INTO awareness_schedule_runs (rule_id, nominal_date, planned_date, draft_due, review_due, task_id)
        VALUES ('${r.id}', '2026-12-15', '2026-12-16', '2026-12-08', '2026-12-12', '${t2.id}')`, /awareness_schedule_runs_dates_check/);
    }));
});

describe('учебные письма: триггеры под владельцем схемы (вторая линия, если права роли изменят)', () => {
  it('версии и события не меняются и не удаляются, письмо не удаляется — даже у владельца', async () => {
    const c = new pg.Client({ connectionString: testDbConfig().ownerUrl });
    await c.connect();
    const fail = async (sql: string, re: RegExp) => {
      await c.query('SAVEPOINT s');
      await expect(c.query(sql)).rejects.toThrow(re);
      await c.query('ROLLBACK TO SAVEPOINT s');
    };
    try {
      await c.query('BEGIN');
      const u = (await c.query<{ id: string }>(`INSERT INTO users (login, full_name, password_hash, updated_at)
        VALUES ('owner.trigger.test', 'Тест Триггеров', 'not-a-real-hash', now()) RETURNING id`)).rows[0]?.id;
      const l = (await c.query<{ id: string }>(`INSERT INTO awareness_letters (title, kind, created_by, updated_at)
        VALUES ('Письмо', 'planned', '${u}', now()) RETURNING id`)).rows[0]?.id;
      await c.query(`INSERT INTO awareness_letter_versions (letter_id, no, reason, subject_ru, subject_tj, html_ru, html_tj, created_by)
        VALUES ('${l}', 1, 'created', 'Тема', '', '<p>т</p>', '', '${u}')`);
      await c.query(`INSERT INTO awareness_letter_events (letter_id, action, actor_id) VALUES ('${l}', 'submitted', '${u}')`);
      await fail(`UPDATE awareness_letter_versions SET subject_ru = 'x' WHERE letter_id = '${l}'`, /только пополняется/);
      await fail(`DELETE FROM awareness_letter_versions WHERE letter_id = '${l}'`, /только пополняется/);
      await fail(`UPDATE awareness_letter_events SET comment = 'x' WHERE letter_id = '${l}'`, /только пополняется/);
      await fail(`DELETE FROM awareness_letter_events WHERE letter_id = '${l}'`, /только пополняется/);
      await fail(`DELETE FROM awareness_letters WHERE id = '${l}'`, /не удаляется/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });
});

describe('удаление задач и записей, связанных с письмами (замечание владельца, п. 3)', () => {
  it('задача письма, задача доработки и задача запуска правила не удаляются — 409 с номером письма или правилом', () =>
    inTx(async (tx) => {
      const { user, actor, task } = await setup(tx);
      const ofLetter = await task('Срочная рассылка: тест');
      const l = await draft(tx, user.id, { taskId: ofLetter.id });
      const rework = await task('Доработать письмо: тест');
      await tx.awarenessLetterEvent.create({ data: { letterId: l.id, action: 'returned', comment: 'Уточнить повод', taskId: rework.id, actorId: user.id } });
      const role = await roleId(tx, 'ib_staff');
      const rule = await tx.awarenessScheduleRule.create({
        data: { title: 'Ежемесячная рассылка', cadence: { kind: 'monthly', day: 15 }, startsOn: new Date('2026-01-01'), leadDays: 10, roleId: role, createdBy: user.id },
      });
      const ofRun = await task('Рассылка: Ежемесячная рассылка — 13.11.2026');
      await tx.awarenessScheduleRun.create({
        data: { ruleId: rule.id, nominalDate: new Date('2026-11-15'), plannedDate: new Date('2026-11-13'), draftDue: new Date('2026-11-06'), reviewDue: new Date('2026-11-10'), taskId: ofRun.id },
      });

      for (const t of [ofLetter, rework]) {
        await expectCode(tasks.deleteTask(tx, actor, t.id, t.version), 'TASK_LINKED_TO_LETTER');
      }
      await expect(tasks.deleteTask(tx, actor, ofLetter.id, ofLetter.version)).rejects.toThrow(`связана с учебным письмом № ${l.number}`);
      await expect(tasks.deleteTask(tx, actor, ofRun.id, ofRun.version)).rejects.toThrow('создана правилом расписания «Ежемесячная рассылка»');
      // Архив разрешён; обычная задача удаляется как раньше.
      await tasks.setTaskArchived(tx, actor, ofLetter.id, ofLetter.version, true);
      const free = await task('Обычная задача');
      await tasks.deleteTask(tx, actor, free.id, free.version);
      expect((await tx.task.findUniqueOrThrow({ where: { id: free.id } })).deletedAt).not.toBeNull();
    }));

  it('массовое удаление задач пропускает связанные с письмами и продолжает с остальными', () =>
    inTx(async (tx) => {
      const { user, actor, task } = await setup(tx);
      const linked = await task('Срочная рассылка: тест');
      await draft(tx, user.id, { taskId: linked.id });
      const a = await task('Обычная 1');
      const b = await task('Обычная 2');
      const sel = { ids: [linked.id, a.id, b.id] };
      const p = await taskBulk.previewTaskBulk(tx, 'delete', sel);
      expect(p).toMatchObject({ total: 3, affected: 2, linkedToLetters: 1, alreadyInState: 0 });
      const r = await taskBulk.applyTaskBulk(tx, actor, 'delete', sel, { total: p.total, affected: p.affected }, { label: 'тест', entity: 'task', entityId: 'board' });
      expect(r).toEqual({ archived: 0, deleted: 2, skipped: 1 });
      expect((await tx.task.findUniqueOrThrow({ where: { id: linked.id } })).deletedAt).toBeNull();
      // Архивация не ограничена.
      expect((await taskBulk.previewTaskBulk(tx, 'archive', { ids: [linked.id] })).affected).toBe(1);
    }));

  it('запись реестра, созданная отметкой «Отправлено», не удаляется — 409 с номером письма; массовое — в архив', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const linked = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Рассылка 05.11.2026' } });
      const free = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Другая запись' } });
      const l = await draft(tx, x.adminId);
      await freeze(tx, l.id, x.adminId);
      await tx.awarenessLetterEvent.create({
        data: { letterId: l.id, action: 'sent', sentOn: new Date('2026-11-05'), audience: 'Все сотрудники', recordId: linked.id, actorId: x.adminId },
      });
      await expectCode(records.deleteRecord(tx, x.actor, linked.id, linked.version, { reasonCode: 'duplicate' }), 'RECORD_LINKED_TO_LETTER');
      await expect(records.deleteRecord(tx, x.actor, linked.id, linked.version, { reasonCode: 'duplicate' }))
        .rejects.toThrow(`Запись #${linked.number} связана с учебным письмом № ${l.number}`);
      const sel = { ids: [linked.id, free.id] };
      const p = await bulkRecords.previewBulk(tx, x.reg.id, 'delete', sel);
      expect(p).toMatchObject({ total: 2, willDelete: 1, willArchive: 1, byReason: { letters: 1 } });
      const r = await bulkRecords.applyBulk(tx, x.actor, x.reg.id, 'delete', sel,
        { total: p.total, willDelete: p.willDelete, willArchive: p.willArchive, willRestore: p.willRestore }, 'тест', { reasonCode: 'duplicate' });
      expect(r).toMatchObject({ deleted: 1, archived: 1 });
      expect(await tx.registerRecord.findUniqueOrThrow({ where: { id: linked.id } })).toMatchObject({ deletedAt: null });
    }));

  it('физический DELETE связанной задачи отклоняет внешний ключ (RESTRICT) — вторая линия', () =>
    inTx(async (tx) => {
      const { user, task } = await setup(tx);
      // Строка задачи без переходов и комментариев: иначе DELETE остановит раньше внешний ключ task_transitions.
      const tpl = await task('Образец');
      const t = await tx.task.create({
        data: { title: 'Срочная рассылка: тест', statusId: tpl.status.id, priorityId: tpl.priority.id, categoryId: tpl.category.id, source: 'manual' },
      });
      await draft(tx, user.id, { taskId: t.id });
      await rejects(tx, `DELETE FROM tasks WHERE id = '${t.id}'`, /awareness_letters_task_id_fkey/);
    }));
});
