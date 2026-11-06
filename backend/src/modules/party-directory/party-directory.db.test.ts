// Справочник «Ответственные лица» (релиз 1.6.7): app_settings, текст в документ, отключение, дубли, права, журнал.
// Имена только вымышленные. Каждый тест — в транзакции с откатом.
import type { User } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { actorFor, expectCode, inTx, makeUser, type Tx } from '../../test/db.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as parties from '../documents/parties.js';
import * as docs from '../documents/service.js';
import * as svc from './service.js';

const PASSWORD = 'Party-Dir-Test-2026';
const URL1 = 'https://office.example.local/products/files/doceditor.aspx?fileid=701';

async function fixture(tx: Tx) {
  const hash = await argon2Hasher.hash(PASSWORD);
  const type = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: `Положение ${Math.random().toString(36).slice(2)}` } });
  const admin = await makeUser(tx, ['super_admin'], { fullName: 'Администратор Тестов', passwordHash: hash });
  const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Автор Тестов', passwordHash: hash });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Сотрудник Тестов', passwordHash: hash });
  const createDoc = async () => {
    // Драфт (этап 21, 1.11.0): файлов нет — документ ссылка OnlyOffice; лиц автор ведёт уже здесь.
    return docs.createDocument(tx, await actorFor(tx, admin.id), { title: 'Положение о доступе', typeId: type.id, ownerId: owner.id, onlyofficeUrl: URL1, edition: '1.0' });
  };
  return { admin, owner, staff, createDoc };
}

async function cur(tx: Tx, id: string) {
  const d = await tx.document.findUniqueOrThrow({ where: { id }, include: { workingVersion: true } });
  return { version: d.version, stage: d.workingVersion?.stage ?? -1 };
}

/** Как форма карточки: выбор из справочника отправляет ФИО и должность текстом. */
async function pickIntoDocument(tx: Tx, u: User, docId: string, p: { fullName: string; position: string }) {
  await parties.addParty(tx, await actorFor(tx, u.id), docId, { ...(await cur(tx, docId)), fullName: p.fullName, department: p.position, dueDays: 10 });
}

const activeParties = (tx: Tx, documentId: string) =>
  tx.documentParty.findMany({ where: { documentId, removedAt: null }, orderBy: { addedAt: 'asc' }, select: { fullName: true, department: true } });

describe('справочник «Ответственные лица» (1.6.7)', () => {
  it('выбор из справочника записывает в документ текст; правка и отключение записи документ не меняют', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const actor = await actorFor(tx, x.admin.id);
      const { item } = await svc.createPerson(tx, actor, { fullName: 'Иванов И.И.', position: 'Технический директор' });
      const docId = await x.createDoc();
      await pickIntoDocument(tx, x.owner, docId, item);
      expect(await activeParties(tx, docId)).toEqual([{ fullName: 'Иванов И.И.', department: 'Технический директор' }]);

      const { item: renamed } = await svc.updatePerson(tx, actor, item.id, { version: item.version, fullName: 'Иванов И.И. (с 2027)', position: 'Директор по ИТ' });
      await svc.updatePerson(tx, actor, item.id, { version: renamed.version, active: false });
      expect(await activeParties(tx, docId)).toEqual([{ fullName: 'Иванов И.И.', department: 'Технический директор' }]);
      // Ссылки на справочник в документе нет: колонок под неё нет, значения — текст.
      const row = await tx.documentParty.findFirstOrThrow({ where: { documentId: docId } });
      expect(JSON.stringify(row)).not.toContain(item.id);
    }));

  it('отключённые не попадают в выбор для документа, но остаются в настройках; включить можно обратно', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const actor = await actorFor(tx, x.admin.id);
      const { item: a } = await svc.createPerson(tx, actor, { fullName: 'Петров П.П.', position: 'Главный бухгалтер' });
      const { item: b } = await svc.createPerson(tx, actor, { fullName: 'Сидорова С.С.', position: 'Начальник отдела кадров' });
      const off = (await svc.updatePerson(tx, actor, a.id, { version: a.version, active: false })).item;
      const docId = await x.createDoc();

      const pick = await svc.directoryForDocument(tx, x.owner.id, docId);
      expect(pick.map((i) => i.id)).toContain(b.id);
      expect(pick.map((i) => i.id)).not.toContain(a.id);
      const all = await svc.listDirectory(tx);
      expect(all.find((i) => i.id === a.id)?.active).toBe(false);

      await svc.updatePerson(tx, actor, a.id, { version: off.version, active: true });
      expect((await svc.directoryForDocument(tx, x.owner.id, docId)).map((i) => i.id)).toContain(a.id);
    }));

  it('дубль в одном документе — 409 (ФИО и должность без учёта регистра и пробелов); однофамилец с другой должностью — можно', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const docId = await x.createDoc();
      await pickIntoDocument(tx, x.owner, docId, { fullName: 'Иванов И.И.', position: 'Технический директор' });
      await expectCode(pickIntoDocument(tx, x.owner, docId, { fullName: '  иванов  И.И.', position: 'ТЕХНИЧЕСКИЙ директор ' }), 'PARTY_DUPLICATE');
      await pickIntoDocument(tx, x.owner, docId, { fullName: 'Иванов И.И.', position: 'Главный бухгалтер' });
      expect(await activeParties(tx, docId)).toHaveLength(2);

      // Правка лица в уже добавленного — тоже дубль; снятое лицо дублем не считается.
      const second = await tx.documentParty.findFirstOrThrow({ where: { documentId: docId, department: 'Главный бухгалтер' } });
      await expectCode(parties.updateParty(tx, await actorFor(tx, x.owner.id), docId, second.id, { ...(await cur(tx, docId)), department: 'Технический директор' }), 'PARTY_DUPLICATE');
      await parties.removeParty(tx, await actorFor(tx, x.owner.id), docId, second.id, await cur(tx, docId));
      await pickIntoDocument(tx, x.owner, docId, { fullName: 'Иванов И.И.', position: 'Главный бухгалтер' });
    }));

  it('такое же ФИО в справочнике сохраняется с предупреждением sameName; журнал — на каждое изменение', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const actor = await actorFor(tx, x.admin.id);
      const first = await svc.createPerson(tx, actor, { fullName: 'Иванов И.И.', position: 'Технический директор' });
      expect(first.sameName).toEqual([]);
      const second = await svc.createPerson(tx, actor, { fullName: ' иванов и.и. ', position: 'Главный бухгалтер' });
      expect(second.sameName.map((i) => i.id)).toEqual([first.item.id]);
      expect(second.item.fullName).toBe('иванов и.и.');

      const upd = await svc.updatePerson(tx, actor, first.item.id, { version: 1, position: 'Директор по ИТ' });
      const dis = await svc.updatePerson(tx, actor, first.item.id, { version: upd.item.version, active: false });
      await svc.updatePerson(tx, actor, first.item.id, { version: dis.item.version, active: true });
      const log = await tx.auditLog.findMany({ where: { entity: 'party_directory', entityId: first.item.id }, orderBy: { id: 'asc' }, select: { action: true, userId: true } });
      expect(log.map((l) => l.action)).toEqual(['party_directory.created', 'party_directory.updated', 'party_directory.disabled', 'party_directory.enabled']);
      expect(log.every((l) => l.userId === x.admin.id)).toBe(true);
    }));

  it('правка устаревшей версии — 409; пустое ФИО — 400; без изменений — версия не растёт', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const actor = await actorFor(tx, x.admin.id);
      const { item } = await svc.createPerson(tx, actor, { fullName: 'Иванов И.И.' });
      expect(item.position).toBe('');
      await svc.updatePerson(tx, actor, item.id, { version: 1, position: 'Технический директор' });
      await expectCode(svc.updatePerson(tx, actor, item.id, { version: 1, position: 'Главный бухгалтер' }), 'VERSION_CONFLICT');
      await expectCode(svc.createPerson(tx, actor, { fullName: '   ' }), 'EMPTY');
      const same = await svc.updatePerson(tx, actor, item.id, { version: 2, fullName: 'Иванов И.И.' });
      expect(same.item.version).toBe(2);
    }));

  it('выбор для документа — только тем, кто ведёт его лиц (автор в драфте и на согласовании, 1.11.0)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const docId = await x.createDoc();
      await svc.createPerson(tx, await actorFor(tx, x.admin.id), { fullName: 'Иванов И.И.', position: 'Технический директор' });
      expect((await svc.directoryForDocument(tx, x.owner.id, docId)).length).toBeGreaterThan(0);
      await expectCode(svc.directoryForDocument(tx, x.staff.id, docId), 'FORBIDDEN');
    }));

  it('по HTTP: справочник — только settings.manage (403 без права); выбор для документа — автору', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const docId = await x.createDoc();
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: false,
      });
      const login = async (u: User) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u.login, password: PASSWORD } });
        expect(res.statusCode).toBe(200);
        return { cookie: `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`, origin: TEST_PORTAL_URL };
      };
      const A = await login(x.admin);
      const O = await login(x.owner);
      const url = '/api/v1/settings/party-directory';
      expect((await app.inject({ url, headers: O })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: O, payload: { fullName: 'Иванов И.И.' } })).statusCode).toBe(403);
      const created = await app.inject({ method: 'POST', url, headers: A, payload: { fullName: 'Иванов И.И.', position: 'Технический директор' } });
      expect(created.statusCode).toBe(200);
      const id = (created.json() as { item: { id: string } }).item.id;
      expect((await app.inject({ method: 'PATCH', url: `${url}/${id}`, headers: O, payload: { version: 1, active: false } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: `${url}/${id}`, headers: A })).statusCode).toBe(404);
      const pick = await app.inject({ url: `/api/v1/documents/${docId}/party-directory`, headers: O });
      expect(pick.statusCode).toBe(200);
      expect((pick.json() as { items: { fullName: string }[] }).items.map((i) => i.fullName)).toContain('Иванов И.И.');
      await app.close();
    }));
});
