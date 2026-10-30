import type { User } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { todayIso } from '../../lib/today.js';
import { actorFor, expectCode, inTx, makeFileRow, makeUser, must, type Tx } from '../../test/db.js';
import { addMonthsIso } from '../documents/status.js';
import * as forms from '../form-templates/service.js';
import { runEvidenceExpiry } from './expiry.js';
import * as svc from './service.js';

async function fixture(tx: Tx) {
  const admin = await makeUser(tx, ['super_admin'], { fullName: 'Администратор' });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Сотрудник ИБ' });
  const reviewer = await makeUser(tx, ['ib_staff'], { fullName: 'Проверяющий ИБ' });
  const lawyer = await makeUser(tx, ['doc_reader'], { fullName: 'Юрист' });
  const system = await tx.catalogItem.create({ data: { catalogCode: 'systems', value: `АБС ${Math.random().toString(36).slice(2, 7)}` } });
  const tplId = await forms.createTemplate(tx, await actorFor(tx, admin.id), { name: `Парольная защита ${Math.random().toString(36).slice(2, 7)}`, basis: 'Инструкция по парольной защите', validMonths: 12 })
    .then((t) => (t as { id: string }).id);
  const len = await tx.formTemplateField.create({ data: { templateId: tplId, label: 'Минимальная длина пароля', checkKind: 'min', threshold: 12, sortOrder: 1 } });
  const age = await tx.formTemplateField.create({ data: { templateId: tplId, label: 'Максимальный срок действия, дней', checkKind: 'max', threshold: 90, sortOrder: 2 } });
  const mfa = await tx.formTemplateField.create({ data: { templateId: tplId, label: 'MFA для привилегированных УЗ', checkKind: 'yes', sortOrder: 3 } });
  const file = async (u: User, name = 'GPO.png', mime = 'image/png') => (await makeFileRow(tx, u.id, { name, mime })).id;
  const form = async (u: User, values: Record<string, unknown> = { [len.id]: 14, [age.id]: '120', [mfa.id]: 'да' }) =>
    svc.createEvidence(tx, await actorFor(tx, u.id), {
      kind: 'form', object: { type: 'system', id: system.id }, templateId: tplId, values, confirmedBy: 'Т. Абрамцев, ДИКТ', fileIds: [await file(u)],
    });
  const card = async (u: User, id: string) => {
    const perms = new Set((await tx.rolePermission.findMany({ where: { role: { users: { some: { userId: u.id } } } } })).map((p) => p.permissionCode));
    return svc.getEvidence(tx, { id: u.id, perms }, id);
  };
  const review = async (u: User, id: string, decision: 'accept' | 'reject', comment?: string) =>
    svc.reviewEvidence(tx, await actorFor(tx, u.id), id, { version: (await tx.evidence.findUniqueOrThrow({ where: { id } })).version, decision, comment });
  return { admin, staff, reviewer, lawyer, system, tplId, len, age, mfa, file, form, card, review };
}

describe('доказательства: форма подтверждения', () => {
  it('снимок полей и значений не меняется после правки шаблона', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.form(x.staff);
      const before = await x.card(x.staff, id);
      expect(before.checks?.map((c) => [c.label, c.requirement, c.value, c.ok])).toEqual([
        ['Минимальная длина пароля', 'не менее 12', '14', true],
        ['Максимальный срок действия, дней', 'не более 90', '120', false],
        ['MFA для привилегированных УЗ', 'да', 'да', true],
      ]);
      expect(before.result).toEqual({ passed: 2, total: 3, fails: ['Максимальный срок действия, дней'] });
      expect(before.validUntil).toBe(addMonthsIso(todayIso(), 12));

      // Администратор меняет шаблон: порог, название поля, удаляет поле, добавляет новое.
      const admin = await actorFor(tx, x.admin.id);
      await forms.updateField(tx, admin, x.len.id, { version: x.len.version, label: 'Длина пароля', threshold: 16 });
      await forms.deleteField(tx, admin, x.mfa.id, x.mfa.version);
      await forms.addField(tx, admin, x.tplId, { label: 'Блокировка после попыток', checkKind: 'max', threshold: 5 });

      const after = await x.card(x.staff, id);
      expect(after.checks).toEqual(before.checks);
      expect(after.result).toEqual(before.result);
      // В БД снимок защищён триггером и от прямой правки.
      await tx.$executeRawUnsafe('SAVEPOINT s');
      await expect(tx.$executeRawUnsafe(`UPDATE evidence SET checks = '[]'::jsonb WHERE id = '${id}'`)).rejects.toThrow(/снимок формы/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s');
      // Новая форма — уже по новому шаблону.
      const fresh = await x.card(x.staff, await x.form(x.staff, { [x.len.id]: 16, [x.age.id]: 90, [(await tx.formTemplateField.findFirstOrThrow({ where: { templateId: x.tplId, label: 'Блокировка после попыток' } })).id]: 5 }));
      expect(fresh.checks?.map((c) => c.label)).toEqual(['Длина пароля', 'Максимальный срок действия, дней', 'Блокировка после попыток']);
    }));

  it('история в карточке — только с правом «История в карточках» (ADR-0021)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.form(x.staff);
      expect((await x.card(x.staff, id)).history).toEqual([]);
      expect((await x.card(x.admin, id)).history.length).toBeGreaterThan(0);
    }));

  it('форма заполняется целиком; без файла и без «подтвердил» не загружается', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await expectCode(x.form(x.staff, { [x.len.id]: 14 }), 'FORM_INCOMPLETE');
      await expectCode(x.form(x.staff, { [x.len.id]: 'двенадцать', [x.age.id]: 90, [x.mfa.id]: 'да' }), 'FORM_INCOMPLETE');
      const a = await actorFor(tx, x.staff.id);
      const base = { kind: 'form' as const, object: { type: 'system' as const, id: x.system.id }, templateId: x.tplId, values: { [x.len.id]: 12, [x.age.id]: 90, [x.mfa.id]: 'да' } };
      await expectCode(svc.createEvidence(tx, a, { ...base, confirmedBy: 'ДИКТ', fileIds: [] }), 'NO_FILES');
      await expectCode(svc.createEvidence(tx, a, { ...base, fileIds: [await x.file(x.staff)] }), 'NO_CONFIRMED_BY');
      // Чужой файл к своему доказательству не приложить.
      await expectCode(svc.createEvidence(tx, a, { ...base, confirmedBy: 'ДИКТ', fileIds: [await x.file(x.reviewer)] }), 'FILE_NOT_YOURS');
    }));

  it('файлы в карточке — в том порядке, в каком их приложили (первый показывается в предпросмотре)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const ids = [await x.file(x.staff, 'выгрузка.csv', 'text/csv'), await x.file(x.staff, 'GPO.png'), await x.file(x.staff, 'Политика.pdf', 'application/pdf')];
      // Приложены в обратном порядке загрузки — порядок карточки следует выбору, а не времени загрузки.
      const order = [ids[1], ids[2], ids[0]] as string[];
      const id = await svc.createEvidence(tx, await actorFor(tx, x.staff.id), {
        kind: 'form', object: { type: 'system', id: x.system.id }, templateId: x.tplId,
        values: { [x.len.id]: 14, [x.age.id]: 90, [x.mfa.id]: 'да' }, confirmedBy: 'ДИКТ', fileIds: order,
      });
      expect((await x.card(x.staff, id)).fileList.map((f) => f.name)).toEqual(['GPO.png', 'Политика.pdf', 'выгрузка.csv']);
    }));
});

describe('доказательства: проверка ИБ', () => {
  it('проверяющий не принимает своё доказательство; отклонение — с комментарием и задачей загрузившему', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.form(x.staff);
      // Сотрудник ИБ с правом evidence.review, но загрузил сам — нельзя.
      await expectCode(x.review(x.staff, id, 'accept'), 'SEPARATION_OF_DUTIES');
      expect((await x.card(x.staff, id)).reviewBlocked).toMatch(/проверяет другой сотрудник/);
      expect((await x.card(x.reviewer, id)).can.review).toBe(true);

      await expectCode(x.review(x.reviewer, id, 'reject'), 'EMPTY_COMMENT');
      await x.review(x.reviewer, id, 'reject', 'Срок действия пароля 120 дней — нужно не более 90');
      const task = must(await tx.task.findFirst({ where: { evidenceId: id, evidenceReason: 'rejected' }, include: { category: true } }));
      expect(task.assigneeId).toBe(x.staff.id);
      expect(task.category.systemKey).toBe('evidence');
      expect(task.dueDate?.toISOString().slice(0, 10)).toBe(addDays(todayIso(), 7));
      // Уже проверено — второй раз не проверить.
      await expectCode(x.review(x.reviewer, id, 'accept'), 'NOT_PENDING');

      // Загрузивший прикладывает исправленный файл: доказательство снова на проверке, задача закрыта.
      const e = await tx.evidence.findUniqueOrThrow({ where: { id } });
      await svc.addEvidenceFiles(tx, await actorFor(tx, x.staff.id), id, { version: e.version, fileIds: [await x.file(x.staff, 'GPO-90.png')] });
      expect((await tx.evidence.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
      expect((await tx.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).not.toBeNull();

      // Проверяющий, который сам приложил файл, тоже не принимает.
      const e2 = await tx.evidence.findUniqueOrThrow({ where: { id } });
      await svc.addEvidenceFiles(tx, await actorFor(tx, x.reviewer.id), id, { version: e2.version, fileIds: [await x.file(x.reviewer, 'мой.png')] });
      await expectCode(x.review(x.reviewer, id, 'accept'), 'SEPARATION_OF_DUTIES');
    }));

  it('новый файл возвращает принятое доказательство на проверку; убрать файл — только на проверке и не последний', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.form(x.staff);
      const first = must((await tx.evidenceFile.findFirst({ where: { evidenceId: id } }))?.fileId);
      const v = async () => (await tx.evidence.findUniqueOrThrow({ where: { id } })).version;
      const staff = { ...(await actorFor(tx, x.staff.id)), perms: new Set(['ib.work']) };
      await expectCode(svc.removeEvidenceFile(tx, staff, id, first, await v()), 'LAST_FILE');

      await x.review(x.reviewer, id, 'accept');
      await expectCode(svc.removeEvidenceFile(tx, staff, id, first, await v()), 'NOT_PENDING');
      await svc.addEvidenceFiles(tx, await actorFor(tx, x.staff.id), id, { version: await v(), fileIds: [await x.file(x.staff, 'ещё.pdf', 'application/pdf')] });
      const e = await tx.evidence.findUniqueOrThrow({ where: { id } });
      expect(e.status).toBe('pending');
      expect(e.reviewedAt).toBeNull();

      // Теперь на проверке: файл убирается, файл без других ссылок помечается удалённым.
      await svc.removeEvidenceFile(tx, staff, id, first, await v());
      expect((await tx.file.findUniqueOrThrow({ where: { id: first } })).deletedAt).not.toBeNull();
      expect((await x.card(x.staff, id)).fileList).toHaveLength(1);
    }));
});

describe('доказательства: срок действия', () => {
  it('за 30 дней до окончания — задача ответственному через automation_events; повторный прогон дублей не даёт', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.form(x.staff);
      await x.review(x.reviewer, id, 'accept');
      const today = todayIso();
      const soon = addDays(today, 20);
      await tx.evidence.update({ where: { id }, data: { validUntil: new Date(`${soon}T00:00:00Z`) } });
      expect((await x.card(x.staff, id)).state).toBe('expiring');

      const r1 = await runEvidenceExpiry(tx, { today });
      expect(r1.tasksCreated).toBe(1);
      const ev = must(await tx.automationEvent.findFirst({ where: { evidenceId: id } }));
      expect(ev.status).toBe('processed');
      expect(ev.triggerKey).toBe(soon);
      const task = must(await tx.task.findFirst({ where: { evidenceId: id, evidenceReason: 'expiring' } }));
      expect(task.assigneeId).toBe(x.staff.id);
      expect(task.dueDate?.toISOString().slice(0, 10)).toBe(soon);

      const r2 = await runEvidenceExpiry(tx, { today });
      expect(r2.events).toBe(0);
      expect(await tx.task.count({ where: { evidenceId: id } })).toBe(1);

      // Новая форма по той же системе принята — задача «обновить» по старой закрывается.
      const next = await x.form(x.staff, { [x.len.id]: 14, [x.age.id]: 90, [x.mfa.id]: 'да' });
      await x.review(x.reviewer, next, 'accept');
      expect((await tx.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).not.toBeNull();

      // Истекло — отдельное состояние.
      await tx.evidence.update({ where: { id }, data: { validUntil: new Date(`${addDays(today, -1)}T00:00:00Z`) } });
      expect((await x.card(x.staff, id)).state).toBe('expired');
      const cover = await svc.coverage(tx, x.tplId);
      expect(cover.items.find((i) => i.system.id === x.system.id)?.number).toBe((await tx.evidence.findUniqueOrThrow({ where: { id: next } })).number);
    }));
});

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
