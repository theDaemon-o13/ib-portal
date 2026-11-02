// Раздел «Уязвимости», шаг 1 (ADR-0029): справочник «Типы систем», «Без группы», группы и узлы, права, журнал.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, must, type Tx } from '../../test/db.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as catalogs from '../catalogs/service.js';
import * as groups from './groups.service.js';

const PASSWORD = 'Vulns-Test-Pass-2026';
const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Запись реестра уязвимостей в «Без группы / Из прежнего реестра». */
async function legacyRecord(tx: Tx) {
  const reg = await tx.register.findUniqueOrThrow({ where: { systemKey: 'vulns' } });
  const node = await groups.legacyNode(tx);
  const max = await tx.registerRecord.aggregate({ where: { registerId: reg.id }, _max: { number: true } });
  const rec = await tx.registerRecord.create({ data: { registerId: reg.id, number: (max._max.number ?? 0) + 1, values: {} } });
  await tx.vulnRecord.create({ data: { recordId: rec.id, nodeId: node.id, legacy: true } });
  return rec;
}

async function types(tx: Tx) {
  const items = await tx.catalogItem.findMany({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, deletedAt: null, archivedAt: null }, orderBy: { sortOrder: 'asc' } });
  const by = (value: string) => must(items.find((i) => i.value === value)).id;
  return { items, by };
}

describe('уязвимости: группы и узлы', () => {
  it('seed: «Типы систем» с пятью стартовыми значениями, «Без группы» с узлом «Из прежнего реестра» — последней в списке', () =>
    inTx(async (tx) => {
      const t = await types(tx);
      expect(t.items.map((i) => i.value)).toEqual(expect.arrayContaining(['БД', 'Серверы', 'Рабочие станции', 'Сетевое оборудование', 'Веб-приложения']));
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      await groups.createGroup(tx, admin, { name: unique('Ааа'), kind: 'service', systemTypeIds: [t.by('БД')] });
      await legacyRecord(tx);
      const list = await groups.listGroups(tx);
      const last = must(list.at(-1));
      expect(last).toMatchObject({ kind: 'temporary', system: true, kindLabel: 'Временная' });
      expect(last.nodes).toEqual([expect.objectContaining({ legacy: true, label: 'Из прежнего реестра', systemType: null })]);
    }));

  it('«Без группы» (1.6.1): без неархивных записей скрыта; запись появилась (перенос seed) — видна снова; не удаляется', () =>
    inTx(async (tx) => {
      const visible = async () => !must((await groups.listGroups(tx)).find((g) => g.system)).hidden;
      expect(await visible()).toBe(false);
      const rec = await legacyRecord(tx);
      expect(await visible()).toBe(true);
      await tx.registerRecord.update({ where: { id: rec.id }, data: { archivedAt: new Date() } });
      expect(await visible()).toBe(false);
      await tx.registerRecord.update({ where: { id: rec.id }, data: { archivedAt: null } });
      expect(await visible()).toBe(true);
      const ungrouped = await tx.vulnGroup.findUniqueOrThrow({ where: { systemKey: groups.UNGROUPED_KEY } });
      await expectCode(groups.previewGroupDelete(tx, ungrouped.id), 'SYSTEM_GROUP');
      await expectCode(groups.previewNodeDelete(tx, (await groups.legacyNode(tx)).id), 'LEGACY_NODE');
      // Узел «Без группы» открывается и скрытой: архив сканов прежнего реестра.
      await tx.registerRecord.update({ where: { id: rec.id }, data: { archivedAt: new Date() } });
      expect((await groups.loadNode(tx, (await groups.legacyNode(tx)).id)).systemKey).toBe(groups.LEGACY_NODE_KEY);
    }));

  it('создание: название уникально без регистра и пробелов, вид, хотя бы один тип; узлы — по порядку справочника; журнал', () =>
    inTx(async (tx) => {
      const t = await types(tx);
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      const name = unique('Хумо Онлайн');
      const g = await groups.createGroup(tx, admin, { name: `  ${name}  `, kind: 'service', systemTypeIds: [t.by('Серверы'), t.by('БД')] });
      expect(g).toMatchObject({ name, kind: 'service', kindLabel: 'Сервис', system: false });
      expect(g.nodes.map((n) => n.label)).toEqual(['БД', 'Серверы']);
      const audit = await lastAudit(tx);
      expect(audit).toMatchObject({ action: 'vuln.group.created', entityId: g.id, userId: admin.id });
      expect((audit.diff as { summary: string }).summary).toContain('«БД», «Серверы»');

      await expectCode(groups.createGroup(tx, admin, { name: name.toUpperCase(), kind: 'department', systemTypeIds: [t.by('БД')] }), 'GROUP_EXISTS');
      await expectCode(groups.createGroup(tx, admin, { name: unique('Без типов'), kind: 'service', systemTypeIds: [] }), 'TYPES_REQUIRED');
      await expectCode(groups.createGroup(tx, admin, { name: '   ', kind: 'service', systemTypeIds: [t.by('БД')] }), 'BAD_NAME');
      await expectCode(groups.createGroup(tx, admin, { name: unique('Вид'), kind: 'temporary', systemTypeIds: [t.by('БД')] }), 'BAD_KIND');
      // Значение другого справочника — не тип систем.
      const other = must(await tx.catalogItem.findFirst({ where: { catalogCode: 'systems' } }));
      await expectCode(groups.createGroup(tx, admin, { name: unique('Чужой'), kind: 'service', systemTypeIds: [other.id] }), 'BAD_TYPE');
    }));

  it('«Добавить тип»: новый узел; тип, который уже есть, — отказ; в «Без группы» — нельзя', () =>
    inTx(async (tx) => {
      const t = await types(tx);
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      const g = await groups.createGroup(tx, admin, { name: unique('Отдел карт'), kind: 'department', systemTypeIds: [t.by('Рабочие станции')] });
      const after = await groups.addNodes(tx, admin, g.id, [t.by('Сетевое оборудование')]);
      expect(after.nodes.map((n) => n.label)).toEqual(['Рабочие станции', 'Сетевое оборудование']);
      expect(await lastAudit(tx)).toMatchObject({ action: 'vuln.node.created', entityId: g.id });
      await expectCode(groups.addNodes(tx, admin, g.id, [t.by('Рабочие станции')]), 'NODE_EXISTS');
      const ungrouped = await tx.vulnGroup.findUniqueOrThrow({ where: { systemKey: groups.UNGROUPED_KEY } });
      await expectCode(groups.addNodes(tx, admin, ungrouped.id, [t.by('БД')]), 'SYSTEM_GROUP');
    }));

  it('переименование: уникальность, версия, журнал «было → стало»; «Без группы» не переименовывается', () =>
    inTx(async (tx) => {
      const t = await types(tx);
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      const a = await groups.createGroup(tx, admin, { name: unique('Альфа'), kind: 'service', systemTypeIds: [t.by('БД')] });
      const b = await groups.createGroup(tx, admin, { name: unique('Бета'), kind: 'service', systemTypeIds: [t.by('БД')] });
      const newName = unique('Гамма');
      const renamed = await groups.renameGroup(tx, admin, a.id, { name: newName, version: a.version });
      expect(renamed).toMatchObject({ name: newName, version: a.version + 1 });
      expect(await lastAudit(tx)).toMatchObject({ action: 'vuln.group.renamed', diff: expect.objectContaining({ before: { name: a.name }, after: { name: newName } }) });
      await expectCode(groups.renameGroup(tx, admin, b.id, { name: newName.toLowerCase(), version: b.version }), 'GROUP_EXISTS');
      await expectCode(groups.renameGroup(tx, admin, a.id, { name: unique('Дельта'), version: a.version }), 'VERSION_CONFLICT');
      const ungrouped = await tx.vulnGroup.findUniqueOrThrow({ where: { systemKey: groups.UNGROUPED_KEY } });
      await expectCode(groups.renameGroup(tx, admin, ungrouped.id, { name: unique('Другое'), version: ungrouped.version }), 'SYSTEM_GROUP');
    }));

  it('тип систем, у которого есть узел, не удаляется — только в архив', () =>
    inTx(async (tx) => {
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      const item = await tx.catalogItem.create({ data: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: unique('СХД'), sortOrder: 99 } });
      await groups.createGroup(tx, admin, { name: unique('Хранилища'), kind: 'service', systemTypeIds: [item.id] });
      await expectCode(catalogs.deleteItem(tx, admin, item.id, item.version), 'IN_USE');
    }));

  it('права: просмотр — ib.work; создать, переименовать, добавить тип — registers.manage', () =>
    inTx(async (tx) => {
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL,
      });
      const hash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash: hash });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        expect(res.statusCode).toBe(200);
        return { cookie: `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`, origin: TEST_PORTAL_URL };
      };
      const S = await login(staff.login);
      const A = await login(admin.login);
      const R = await login(reader.login);
      const t = await types(tx);
      const body = { name: unique('HTTP'), kind: 'service', systemTypeIds: [t.by('БД')] };
      expect((await app.inject({ url: '/api/v1/vulns/groups', headers: R })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/v1/vulns/groups', headers: S })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/v1/vulns/groups', headers: S, payload: body })).statusCode).toBe(403);
      const created = await app.inject({ method: 'POST', url: '/api/v1/vulns/groups', headers: A, payload: body });
      expect(created.statusCode).toBe(201);
      const g = created.json() as groups.GroupDto;
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/vulns/groups/${g.id}`, headers: S, payload: { name: unique('X'), version: g.version } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/v1/vulns/groups/${g.id}/nodes`, headers: S, payload: { systemTypeIds: [t.by('Серверы')] } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/v1/vulns/groups/${g.id}/nodes`, headers: A, payload: { systemTypeIds: [t.by('Серверы')] } })).statusCode).toBe(200);
      const list = (await app.inject({ url: '/api/v1/vulns/groups', headers: S })).json() as { items: groups.GroupDto[] };
      expect(must(list.items.find((x) => x.id === g.id)).nodes.map((n) => n.label)).toEqual(['БД', 'Серверы']);
    }));
});
