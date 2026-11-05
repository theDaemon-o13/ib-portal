import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { makeRegister, type Fixture } from '../../test/registers-fixture.js';
import * as tasks from '../tasks/service.js';
import * as bulk from './bulk.service.js';
import * as records from './records.service.js';
import * as structure from './structure.service.js';

// Массовые действия с записями (релиз 1.1.0, задача 1).

async function seed(tx: Tx, x: Fixture, n: number, prefix = 'Запись') {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: `${prefix} ${i}` } }));
  return out;
}

async function openTaskFor(tx: Tx, x: Fixture, recordId: string) {
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  const t = await tasks.createTask(tx, x.actor, { title: 'Проверить запись', categoryId: project.id });
  await tx.task.update({ where: { id: t.id }, data: { recordId } });
  return t;
}

/** Реестр, записи которого ссылаются на записи x полем «Связь с записью». */
async function linkingRegister(tx: Tx, x: Fixture) {
  const y = await makeRegister(tx, `Ссылки ${Date.now().toString(36)}`);
  const reg = await structure.addField(tx, y.actor, y.reg.id, { label: 'Связано с', type: 'link', linkRegisterId: x.reg.id });
  const link = must(reg.fields.find((f) => f.label === 'Связано с')).id;
  return { y, link };
}

const counts = (p: bulk.BulkCounts) => ({ total: p.total, willDelete: p.willDelete, willArchive: p.willArchive, willRestore: p.willRestore });

describe('массовые действия с записями', () => {
  it('архив и возврат: по id и по фильтру списка с исключениями; уже в нужном состоянии не считаются', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const [a, b, c] = await seed(tx, x, 3);
      await seed(tx, x, 2, 'Другое');
      const sel = { query: { q: 'запись' }, excludeIds: [must(c).id] };
      const p = await bulk.previewBulk(tx, x.reg.id, 'archive', sel);
      expect(p).toMatchObject({ total: 2, willArchive: 2, willDelete: 0, alreadyInState: 0 });
      const r = await bulk.applyBulk(tx, x.actor, x.reg.id, 'archive', sel, counts(p));
      expect(r).toMatchObject({ archived: 2, deleted: 0, skipped: 0 });
      expect((await records.getRecord(tx, must(a).id)).archived).toBe(true);

      // Список «Архив» — только архивные.
      const archived = await records.listRecords(tx, x.reg.id, { limit: 50, archivedOnly: true });
      expect(archived.items.map((i) => i.id).sort()).toEqual([must(a).id, must(b).id].sort());

      const ids = { ids: [must(a).id, must(b).id, must(c).id] };
      const back = await bulk.previewBulk(tx, x.reg.id, 'restore', ids);
      expect(back).toMatchObject({ total: 3, willRestore: 2, alreadyInState: 1 });
      expect(await bulk.applyBulk(tx, x.actor, x.reg.id, 'restore', ids, counts(back))).toMatchObject({ restored: 2, skipped: 1 });
    }));

  it('удаление: без зависимостей — мягко; с открытой задачей или ссылкой — в архив, разбивка по причинам; журнал', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const [free, withTask, linked, oldArchived] = await seed(tx, x, 4);
      await openTaskFor(tx, x, must(withTask).id);
      const { y, link } = await linkingRegister(tx, x);
      await records.createRecord(tx, y.actor, y.reg.id, { values: { [y.f.title]: 'Ссылка', [link]: [must(linked).id] } });
      // С зависимостью и уже в архиве — остаётся в архиве.
      await openTaskFor(tx, x, must(oldArchived).id);
      await records.setRecordArchived(tx, x.actor, must(oldArchived).id, must(oldArchived).version, true);

      const sel = { ids: [free, withTask, linked, oldArchived].map((r) => must(r).id) };
      const p = await bulk.previewBulk(tx, x.reg.id, 'delete', sel);
      expect(p).toMatchObject({ total: 4, willDelete: 1, willArchive: 2, alreadyInState: 1, byReason: { tasks: 2, links: 1, decisions: 0, evidence: 0, locked: 0 } });

      const r = await bulk.applyBulk(tx, x.actor, x.reg.id, 'delete', sel, counts(p), 'массовое удаление', { reasonCode: 'duplicate' as const });
      expect(r).toEqual({ deleted: 1, archived: 2, restored: 0, skipped: 1, byReason: { tasks: 2, links: 1, decisions: 0, evidence: 0, locked: 0, letters: 0 } });
      expect(await tx.registerRecord.findUnique({ where: { id: must(free).id } })).toMatchObject({ deletedAt: expect.any(Date) });
      expect(await tx.registerRecord.findUnique({ where: { id: must(withTask).id } })).toMatchObject({ deletedAt: null, archivedAt: expect.any(Date) });

      // По записи — та же запись журнала, что у одиночного действия (история карточки), и одна сводная.
      expect(await tx.auditLog.count({ where: { entityId: must(free).id, action: 'register_record.deleted' } })).toBe(1);
      const archivedEntry = must(await tx.auditLog.findFirst({ where: { entityId: must(linked).id, action: 'register_record.archived' } }));
      expect((archivedEntry.diff as { summary: string }).summary).toContain('ссылки из других записей');
      const summary = must(await tx.auditLog.findFirst({ where: { entityId: x.reg.id, action: 'register_records.bulk_delete' } }));
      expect(summary.diff).toMatchObject({ after: { count: 4, deletedIds: [must(free).id], reasons: { tasks: 2, links: 1 }, selection: { kind: 'ids', count: 4 } } });
    }));

  it('одиночное удаление — те же зависимости: открытая задача и ссылка из другой записи', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const [withTask, linked] = await seed(tx, x, 2);
      await openTaskFor(tx, x, must(withTask).id);
      await expectCode(records.deleteRecord(tx, x.actor, must(withTask).id, must(withTask).version, { reasonCode: 'duplicate' }), 'HAS_TASKS');
      const { y, link } = await linkingRegister(tx, x);
      const ref = await records.createRecord(tx, y.actor, y.reg.id, { values: { [y.f.title]: 'Ссылка', [link]: [must(linked).id] } });
      await expectCode(records.deleteRecord(tx, x.actor, must(linked).id, must(linked).version, { reasonCode: 'duplicate' }), 'HAS_LINKS');
      // Ссылающаяся запись удалена — ссылки больше нет.
      await records.deleteRecord(tx, y.actor, ref.id, ref.version, { reasonCode: 'duplicate' });
      await records.deleteRecord(tx, x.actor, must(linked).id, must(linked).version, { reasonCode: 'duplicate' });
    }));

  it('если после предпросмотра выборка изменилась — 409 BULK_CHANGED, ничего не меняется', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const [a] = await seed(tx, x, 3);
      const sel = { query: {} };
      const p = await bulk.previewBulk(tx, x.reg.id, 'delete', sel);
      expect(p).toMatchObject({ total: 3, willDelete: 3 });
      await seed(tx, x, 1, 'Новая');
      await expectCode(bulk.applyBulk(tx, x.actor, x.reg.id, 'delete', sel, counts(p), undefined, { reasonCode: 'duplicate' as const }), 'BULK_CHANGED');
      expect(await tx.registerRecord.count({ where: { registerId: x.reg.id, deletedAt: null } })).toBe(4);
      // Появилась задача — запись уже не удалить, числа разошлись.
      const p2 = await bulk.previewBulk(tx, x.reg.id, 'delete', { ids: [must(a).id] });
      await openTaskFor(tx, x, must(a).id);
      await expectCode(bulk.applyBulk(tx, x.actor, x.reg.id, 'delete', { ids: [must(a).id] }, counts(p2), undefined, { reasonCode: 'duplicate' as const }), 'BULK_CHANGED');
    }));

  it('«Удалить все»: включая архивные, подтверждение названием реестра; пакеты больше 200', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx, 'Реестр для очистки');
      const many = await seed(tx, x, 205);
      await records.setRecordArchived(tx, x.actor, must(many[0]).id, must(many[0]).version, true);
      const p = await bulk.previewBulk(tx, x.reg.id, 'delete', { all: true });
      expect(p).toMatchObject({ total: 205, willDelete: 205 });
      await expectCode(bulk.deleteAllRecords(tx, x.actor, x.reg.id, 'Реестр', counts(p), { reasonCode: 'duplicate' as const }), 'CONFIRM_NAME');
      const r = await bulk.deleteAllRecords(tx, x.actor, x.reg.id, ' Реестр для очистки ', counts(p), { reasonCode: 'duplicate' as const });
      expect(r).toMatchObject({ deleted: 205, archived: 0 });
      expect(await tx.registerRecord.count({ where: { registerId: x.reg.id, deletedAt: null } })).toBe(0);
    }));

  it('реестр в архиве и чужие id: изменения недоступны, чужие записи не считаются', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const other = await makeRegister(tx, `Чужой ${Date.now().toString(36)}`);
      const [mine] = await seed(tx, x, 1);
      const [foreign] = await seed(tx, other, 1);
      expect(await bulk.previewBulk(tx, x.reg.id, 'delete', { ids: [must(mine).id, must(foreign).id] })).toMatchObject({ total: 1 });
      const reg = await x.reload();
      await structure.setRegisterArchived(tx, x.actor, x.reg.id, reg.version, true);
      await expectCode(bulk.previewBulk(tx, x.reg.id, 'archive', { ids: [must(mine).id] }), 'REGISTER_ARCHIVED');
    }));
});

describe('массовые действия по HTTP: права и два шага', () => {
  it('сотрудник ИБ архивирует (records.edit), но не удаляет (records.delete); expected и название проверяет сервер', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Http-Bulk-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const x = await makeRegister(tx, `HTTP массово ${Date.now().toString(36)}`);
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const A = await login(admin.login);
      const S = await login(staff.login);
      const recs = await seed(tx, x, 3);
      const base = `/api/v1/registers/${x.reg.id}/records`;
      const post = (cookie: string, url: string, payload: object) => app.inject({ method: 'POST', url: `${base}/${url}`, headers: { cookie }, payload });
      const selection = { filter: { q: 'запись', includeArchived: true } };

      const pa = await post(S, 'bulk-archive/preview', { action: 'archive', selection: { ids: [must(recs[0]).id] } });
      expect(pa.statusCode).toBe(200);
      const applied = await post(S, 'bulk-archive/apply', { action: 'archive', selection: { ids: [must(recs[0]).id] }, expected: counts(pa.json()) });
      expect(applied.json()).toMatchObject({ archived: 1 });

      expect((await post(S, 'bulk-delete/preview', { selection })).statusCode).toBe(403);
      expect((await post(S, 'delete-all/preview', {})).statusCode).toBe(403);

      const pd = await post(A, 'bulk-delete/preview', { selection });
      expect(pd.json()).toMatchObject({ total: 3, willDelete: 3 });
      const stale = await post(A, 'bulk-delete/apply', { selection, expected: { ...counts(pd.json()), total: 2 }, reasonCode: 'duplicate' });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toMatchObject({ code: 'BULK_CHANGED', details: { preview: { total: 3 } } });

      const all = await post(A, 'delete-all/preview', {});
      expect((await post(A, 'delete-all/apply', { confirmName: 'не то', expected: counts(all.json()), reasonCode: 'duplicate' })).json().error.code).toBe('CONFIRM_NAME');
      const done = await post(A, 'delete-all/apply', { confirmName: x.reg.name, expected: counts(all.json()), reasonCode: 'other', reason: 'Очистка тестового реестра' });
      expect(done.json()).toMatchObject({ deleted: 3, archived: 0 });
      // В списке «Архив» после удаления пусто.
      const list = await app.inject({ url: `${base}?archived=only&limit=50`, headers: { cookie: S } });
      expect(list.json()).toMatchObject({ total: 0 });
    }));
});
