// Мягкое удаление и корзина (релиз 1.6.1, ADR-0033) с настоящей БД: группа, узел, записи, реестр — удаление
// и восстановление целым событием, отказы, «Была удалена» в скане, сверка 5.3, права. Каждый тест — транзакция с откатом.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import type { Values } from '../../lib/register-values.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { SAMPLE, SAMPLE_NAME, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { assetFacts } from '../assets/service.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as bulk from '../registers/bulk.service.js';
import { loadRegister } from '../registers/definition.js';
import * as records from '../registers/records.service.js';
import * as structure from '../registers/structure.service.js';
import * as groups from '../vulns/groups.service.js';
import * as scan from '../vulns/scan-import.service.js';
import * as scans from '../vulns/scans.service.js';
import * as section from '../vulns/section.service.js';
import * as trash from './service.js';

const root = mkdtempSync(join(tmpdir(), 'ibportal-trash-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DUP = { reasonCode: 'duplicate' as const };

async function setup(tx: Tx) {
  const x = await vulnRegister(tx);
  const types = await tx.catalogItem.findMany({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, deletedAt: null, archivedAt: null }, orderBy: { sortOrder: 'asc' } });
  const t = (v: string) => must(types.find((i) => i.value === v)).id;
  const name = unique('Процессинг');
  const g = await groups.createGroup(tx, x.actor, { name, kind: 'service', systemTypeIds: [t('Windows'), t('Linux')] });
  const node = must(g.nodes.find((n) => n.label === 'Windows'));
  const other = must(g.nodes.find((n) => n.label === 'Linux'));
  // Скан образца: 90 открытых записей «Не передано ИКТ».
  const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
  const applied = await scan.applyNodeScan(tx, x.actor, p.id, {});
  await x.reload();
  return { x, group: g, name, node, other, t, scanId: applied.scanId };
}

/** Записи узла — «Устранена»: группу и узел можно удалять. */
async function closeAll(tx: Tx, x: VulnFixture, nodeId: string) {
  const fixed = x.opt('status', 'fixed');
  await tx.$executeRaw`
    UPDATE register_records SET "values" = jsonb_set("values", ARRAY[${x.vf.status.id}], to_jsonb(${fixed}::text))
    WHERE id IN (SELECT record_id FROM vuln_records WHERE node_id = ${nodeId}::uuid)`;
}

const nodeRecordIds = async (tx: Tx, nodeId: string) => (await tx.vulnRecord.findMany({ where: { nodeId }, select: { recordId: true } })).map((r) => r.recordId);
const liveCount = async (tx: Tx, nodeId: string) => tx.vulnRecord.count({ where: { nodeId, record: { deletedAt: null } } });

describe('группы и узлы уязвимостей', () => {
  it('открытые записи — отказ со списком узлов; закрытые — удаление группы скрывает узлы, записи, сканы; восстановление возвращает всё', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const p = await groups.previewGroupDelete(tx, s.group.id);
      expect(p).toMatchObject({ blocked: true, open: 90, counts: { nodes: 2, records: 90, scans: 1 } });
      const input = { reason: 'Сервис выведен', confirmName: s.name };
      const err = await groups.deleteGroup(tx, s.x.actor, s.group.id, input).catch((e: unknown) => e as { code: string; details?: { nodes: { label: string; open: number }[] } });
      expect(err).toMatchObject({ code: 'OPEN_RECORDS', details: { nodes: [{ label: 'Windows', open: 90 }] } });

      await closeAll(tx, s.x, s.node.id);
      await expectCode(groups.deleteGroup(tx, s.x.actor, s.group.id, { ...input, confirmName: 'другое' }), 'CONFIRM_NAME');
      await expectCode(groups.deleteGroup(tx, s.x.actor, s.group.id, { ...input, reason: '  ' }), 'REASON_REQUIRED');
      const done = await groups.deleteGroup(tx, s.x.actor, s.group.id, { ...input, confirmName: ` ${s.name.toUpperCase()} ` });
      expect(done.counts).toEqual({ nodes: 2, records: 90, scans: 1 });
      const audit = await lastAudit(tx);
      expect(audit).toMatchObject({ action: 'vuln.group.deleted', entityId: s.group.id });
      expect((audit.diff as { summary: string }).summary).toContain('Причина: Сервис выведен');

      expect((await groups.listGroups(tx)).some((g) => g.id === s.group.id)).toBe(false);
      await expectCode(groups.loadNode(tx, s.node.id), 'NOT_FOUND');
      await expectCode(scans.getScan(tx, s.scanId), 'NOT_FOUND');
      expect((await section.overview(tx)).nodes.some((n) => n.nodeId === s.node.id)).toBe(false);
      expect(await liveCount(tx, s.node.id)).toBe(0);
      expect(await tx.registerRecord.count({ where: { deletionId: done.deletionId } })).toBe(90);

      // Название свободно: новая группа с тем же именем.
      const twin = await groups.createGroup(tx, s.x.actor, { name: s.name, kind: 'service', systemTypeIds: [s.t('БД')] });
      const [ev] = (await trash.listDeletions(tx, { scope: 'vulns' })).items;
      expect(ev).toMatchObject({ id: done.deletionId, entity: 'vuln_group', title: s.name, reason: 'Сервис выведен', counts: { nodes: 2, records: 90, scans: 1 } });
      await expectCode(trash.restoreDeletion(tx, s.x.actor, done.deletionId), 'NAME_TAKEN');
      const restored = await trash.restoreDeletion(tx, s.x.actor, done.deletionId, { newName: `${s.name} (прежняя)` });
      expect(restored.counts).toEqual({ nodes: 2, records: 90 });
      expect((await groups.listGroups(tx)).find((g) => g.id === s.group.id)?.name).toBe(`${s.name} (прежняя)`);
      expect(await liveCount(tx, s.node.id)).toBe(90);
      expect((await scans.getScan(tx, s.scanId)).id).toBe(s.scanId);
      expect(twin.name).toBe(s.name);
      await expectCode(trash.restoreDeletion(tx, s.x.actor, done.deletionId), 'ALREADY_RESTORED');
    }));

  it('узел: удаление и восстановление; тип добавлен заново — отказ; группа удалена — сначала группа; «Без группы» не удаляется', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      expect(await groups.previewNodeDelete(tx, s.other.id)).toMatchObject({ blocked: false, counts: { nodes: 0, records: 0, scans: 0 } });
      await expectCode(groups.deleteNode(tx, s.x.actor, s.node.id, { reason: 'Ошибка' }), 'OPEN_RECORDS');
      const d = await groups.deleteNode(tx, s.x.actor, s.other.id, { reason: 'Linux не сканируем' });
      expect((await groups.listGroups(tx)).find((g) => g.id === s.group.id)?.nodes.map((n) => n.label)).toEqual(['Windows']);
      // Тип можно добавить снова — восстановить прежний узел тогда нельзя.
      const again = await groups.addNodes(tx, s.x.actor, s.group.id, [s.t('Linux')]);
      await expectCode(trash.restoreDeletion(tx, s.x.actor, d.deletionId), 'NODE_EXISTS');
      const newLinux = must(again.nodes.find((n) => n.label === 'Linux'));
      const d2 = await groups.deleteNode(tx, s.x.actor, newLinux.id, { reason: 'Повтор' });
      await trash.restoreDeletion(tx, s.x.actor, d.deletionId);
      expect((await groups.loadNode(tx, s.other.id)).id).toBe(s.other.id);

      // Узел, удалённый до группы, не восстанавливается вместе с группой и ждёт её.
      await closeAll(tx, s.x, s.node.id);
      const gd = await groups.deleteGroup(tx, s.x.actor, s.group.id, { reason: 'Выведен', confirmName: s.name });
      await expectCode(trash.restoreDeletion(tx, s.x.actor, d2.deletionId), 'PARENT_DELETED');
      await trash.restoreDeletion(tx, s.x.actor, gd.deletionId);
      await expectCode(groups.loadNode(tx, newLinux.id), 'NOT_FOUND');

      const ungrouped = await tx.vulnGroup.findUniqueOrThrow({ where: { systemKey: groups.UNGROUPED_KEY } });
      await expectCode(groups.deleteGroup(tx, s.x.actor, ungrouped.id, { reason: 'x', confirmName: ungrouped.name }), 'SYSTEM_GROUP');
    }));
});

describe('записи уязвимостей', () => {
  it('удаление с причиной: снимок статуса и срока, нет в узле, статистика, сверка 5.3; восстановление возвращает ключ', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const [id] = await nodeRecordIds(tx, s.node.id);
      const row = await tx.registerRecord.findUniqueOrThrow({ where: { id: must(id) } });
      await expectCode(records.deleteRecord(tx, s.x.actor, row.id, row.version, { reasonCode: 'other' }), 'REASON_REQUIRED');
      await records.deleteRecord(tx, s.x.actor, row.id, row.version, { reasonCode: 'false_positive' });
      const ev = await tx.deletion.findFirstOrThrow({ where: { entity: 'register_records', entityId: s.x.reg.id }, orderBy: { deletedAt: 'desc' } });
      expect(ev).toMatchObject({ reasonCode: 'false_positive', counts: { records: 1 } });
      expect(ev.snapshot).toEqual([expect.objectContaining({ recordId: row.id, number: row.number, nodeId: s.node.id, open: true, due: null, status: expect.any(String) })]);
      expect((await lastAudit(tx)).action).toBe('register_record.deleted');

      expect((await section.nodeRecords(tx, s.node.id, { state: 'all' })).total).toBe(89);
      const today = new Date();
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const stats = await trash.vulnDeletionStats(tx, { nodeId: s.node.id }, new Date(`${day(today)}T00:00:00Z`), new Date(`${day(today)}T23:59:59Z`));
      expect(stats).toEqual({ total: 1, open: 1, byReason: [{ code: 'false_positive', label: 'Ложное срабатывание', count: 1 }] });
      expect((await trash.vulnDeletionStats(tx, { nodeId: s.other.id }, new Date(0), today)).total).toBe(0);
      expect((await trash.vulnDeletionStats(tx, { groupId: s.group.id }, new Date(0), new Date(Date.now() + 1000))).total).toBe(1);
      const fact = must((await assetFacts(tx)).find((f) => f.code === 'vulns.deleted_open'));
      expect(fact).toMatchObject({ section: '5.3', status: 'violations' });
      expect(fact.records.some((r) => r.href === `/settings/trash?id=${ev.id}`)).toBe(true);

      await trash.restoreDeletion(tx, s.x.actor, ev.id);
      const back = await tx.vulnRecord.findUniqueOrThrow({ where: { recordId: row.id }, include: { record: true } });
      expect(back.record.deletedAt).toBeNull();
      expect(back.keyNorm).not.toBeNull();
      expect((await section.nodeRecords(tx, s.node.id, { state: 'all' })).total).toBe(90);
      expect((await trash.vulnDeletionStats(tx, { nodeId: s.node.id }, new Date(0), new Date(Date.now() + 1000))).total).toBe(0);
    }));

  it('повторное обнаружение: выбранная «Была удалена» заводится заново — прежнюю восстановить нельзя (ключ занят)', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const [id] = await nodeRecordIds(tx, s.node.id);
      const row = await tx.registerRecord.findUniqueOrThrow({ where: { id: must(id) } });
      await records.deleteRecord(tx, s.x.actor, row.id, row.version, { reasonCode: 'wrong_import' });
      const ev = await tx.deletion.findFirstOrThrow({ where: { entity: 'register_records' }, orderBy: { deletedAt: 'desc' } });
      const p = await scan.previewNodeScan(tx, store, s.x.actor, s.node.id, SAMPLE, 'vuln-windows-2026-10-20.xlsx');
      const item = must(p.summary.groups.deleted?.[0]);
      expect(item.deleted).toMatchObject({ number: row.number, reason: 'Ошибочный импорт' });
      await scan.applyNodeScan(tx, s.x.actor, p.id, { selected: { deleted: [item.key] } });
      await expectCode(trash.restoreDeletion(tx, s.x.actor, ev.id), 'KEY_TAKEN');
    }));

  it('массовое удаление в узле — одно событие с одной причиной; восстановление целиком', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const ids = (await nodeRecordIds(tx, s.node.id)).slice(0, 5);
      const sel = { ids };
      const p = await bulk.previewBulk(tx, s.x.reg.id, 'delete', sel);
      await expectCode(bulk.applyBulk(tx, s.x.actor, s.x.reg.id, 'delete', sel, p, 'массовое удаление'), 'BAD_REASON');
      const r = await bulk.applyBulk(tx, s.x.actor, s.x.reg.id, 'delete', sel, p, 'массовое удаление', DUP);
      expect(r.deleted).toBe(5);
      const evs = await tx.deletion.findMany({ where: { entity: 'register_records', entityId: s.x.reg.id } });
      expect(evs).toHaveLength(1);
      expect(must(evs[0]).counts).toEqual({ records: 5 });
      expect((must(evs[0]).snapshot as unknown[]).length).toBe(5);
      expect(await liveCount(tx, s.node.id)).toBe(85);
      await trash.restoreDeletion(tx, s.x.actor, must(evs[0]).id);
      expect(await liveCount(tx, s.node.id)).toBe(90);
    }));
});

describe('реестры конструктора', () => {
  it('системный — отказ; со ссылками из поля-связи — отказ со списком; пользовательский — удаление записей и автоматизаций, восстановление', () =>
    inTx(async (tx) => {
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      const vulns = await tx.register.findUniqueOrThrow({ where: { systemKey: 'vulns' } });
      expect(await structure.previewRegisterDelete(tx, vulns.id)).toMatchObject({ system: true, blocked: true });
      await expectCode(structure.deleteRegister(tx, admin, vulns.id, { reason: 'x', confirmName: vulns.name }), 'SYSTEM_REGISTER');

      const name = unique('Реестр к удалению');
      const reg = await structure.createRegister(tx, admin, { name });
      const title = must(reg.fields.find((f) => f.isTitle));
      const rec = await records.createRecord(tx, admin, reg.id, { values: { [title.id]: 'Первая' } });
      await records.createRecord(tx, admin, reg.id, { values: { [title.id]: 'Вторая' } });
      await records.deleteRecord(tx, admin, rec.id, (await tx.registerRecord.findUniqueOrThrow({ where: { id: rec.id } })).version, DUP);
      const recEvent = await tx.deletion.findFirstOrThrow({ where: { entity: 'register_records', entityId: reg.id } });
      await tx.registerAutomation.create({ data: { registerId: reg.id, condition: { kind: 'overdue', fieldId: title.id }, action: { eventType: 'notify', recipients: [] } } });

      const linking = await structure.createRegister(tx, admin, { name: unique('Ссылается') });
      const link = await structure.addField(tx, admin, linking.id, { label: 'Связь', type: 'link', linkRegisterId: reg.id });
      const blocked = await structure.previewRegisterDelete(tx, reg.id);
      expect(blocked).toMatchObject({ blocked: true, linkedBy: [{ register: linking.name, field: 'Связь' }], counts: { records: 1, automations: 1 } });
      await expectCode(structure.deleteRegister(tx, admin, reg.id, { reason: 'Не нужен', confirmName: name }), 'REGISTER_LINKED');
      const linkField = must(link.fields.find((f) => f.label === 'Связь'));
      await tx.registerField.update({ where: { id: linkField.id }, data: { deletedAt: new Date() } });

      const d = await structure.deleteRegister(tx, admin, reg.id, { reason: 'Не нужен', confirmName: name });
      expect(d.counts).toEqual({ records: 1, automations: 1 });
      await expectCode(loadRegister(tx, reg.id), 'NOT_FOUND');
      expect((await structure.listRegisters(tx, { includeArchived: true })).some((r) => r.id === reg.id)).toBe(false);
      expect(await tx.registerAutomation.count({ where: { registerId: reg.id, deletedAt: null } })).toBe(0);
      // Запись, удалённая раньше, ждёт реестр.
      await expectCode(trash.restoreDeletion(tx, admin, recEvent.id), 'PARENT_DELETED');
      // Название свободно, пока реестр в корзине.
      const twin = await structure.createRegister(tx, admin, { name });
      await expectCode(trash.restoreDeletion(tx, admin, d.deletionId), 'NAME_TAKEN');
      await structure.setRegisterArchived(tx, admin, twin.id, twin.version, true);
      expect((await trash.restoreDeletion(tx, admin, d.deletionId)).counts).toEqual({ records: 1, automations: 1 });
      expect((await loadRegister(tx, reg.id)).name).toBe(name);
      expect(await tx.registerRecord.count({ where: { registerId: reg.id, deletedAt: null } })).toBe(1);
      await trash.restoreDeletion(tx, admin, recEvent.id);
      expect(await tx.registerRecord.count({ where: { registerId: reg.id, deletedAt: null } })).toBe(2);
      const values = (await tx.registerRecord.findUniqueOrThrow({ where: { id: rec.id } })).values as Values;
      expect(values[title.id]).toBe('Первая');
    }));

  it('«Ложное срабатывание» — только у уязвимостей', () =>
    inTx(async (tx) => {
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      const reg = await structure.createRegister(tx, admin, { name: unique('Реестр') });
      const title = must(reg.fields.find((f) => f.isTitle));
      const rec = await records.createRecord(tx, admin, reg.id, { values: { [title.id]: 'x' } });
      await expectCode(records.deleteRecord(tx, admin, rec.id, rec.version, { reasonCode: 'false_positive' }), 'BAD_REASON');
    }));
});

describe('права по HTTP', () => {
  it('записи уязвимостей и группы — только data.delete; корзина — ib.work на чтение, восстановление — супер-администратор', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Trash-Http-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const s = await setup(tx);
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const holder = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const role = await tx.role.create({ data: { name: unique('Удаление'), description: '', isSystem: false, permissions: { create: [{ permission: { connect: { code: 'data.delete' } } }] } } });
      await tx.userRole.create({ data: { userId: holder.id, roleId: role.id } });
      // records.delete у супер-администратора есть, data.delete — нет.
      await tx.rolePermission.deleteMany({ where: { role: { code: 'ib_staff' }, permission: { code: 'records.delete' } } });
      await tx.rolePermission.create({ data: { role: { connect: { code: 'ib_staff' } }, permission: { connect: { code: 'records.delete' } } } });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return { cookie: `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`, origin: TEST_PORTAL_URL };
      };
      const [A, S, H] = [await login(admin.login), await login(staff.login), await login(holder.login)];
      const [id] = await nodeRecordIds(tx, s.node.id);
      const version = async () => (await tx.registerRecord.findUniqueOrThrow({ where: { id: must(id) } })).version;
      const del = async (h: typeof A) => app.inject({ method: 'POST', url: `/api/v1/register-records/${id}/delete`, headers: h, payload: { version: await version(), reasonCode: 'duplicate' } });
      expect((await del(A)).statusCode).toBe(403);
      expect((await del(S)).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/v1/vulns/groups/${s.group.id}/delete/preview`, headers: S })).statusCode).toBe(403);
      const ok = await del(H);
      expect(ok.statusCode, ok.body).toBe(204);

      const list = await app.inject({ url: '/api/v1/trash?scope=vulns', headers: S });
      expect(list.statusCode).toBe(200);
      const evId = (list.json() as { items: { id: string }[] }).items[0]?.id;
      expect((await app.inject({ method: 'POST', url: `/api/v1/trash/${evId}/restore`, headers: H, payload: {} })).statusCode).toBe(403);
      const restored = await app.inject({ method: 'POST', url: `/api/v1/trash/${evId}/restore`, headers: A, payload: {} });
      expect(restored.statusCode, restored.body).toBe(200);
      const stats = await app.inject({ url: `/api/v1/vulns/deletions/stats?nodeId=${s.node.id}&from=2026-01-01&to=2099-12-31`, headers: S });
      expect(stats.json()).toMatchObject({ total: 0 });
    }));
});
