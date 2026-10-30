// Файлы целиком по HTTP: загрузка с проверкой типа по содержимому, лимит, права на выдачу, заголовки,
// ссылки и мягкое удаление. Хранилище — временный каталог; БД — транзакция с откатом.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { MAX_FILE_BYTES } from '../../lib/file-type.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { tinyPdf, tinyPng } from '../../test/files-fixture.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { actorFor, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as docs from '../documents/service.js';
import * as evidence from '../evidence/service.js';
import { sweepOrphanFiles } from './links.js';

const PASSWORD = 'Files-Test-Pass-2026';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

async function setup(tx: Tx) {
  const root = mkdtempSync(join(tmpdir(), 'ibportal-files-'));
  roots.push(root);
  const app = await buildApp({
    db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
    sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: diskFileStore(root),
  });
  const hash = await argon2Hasher.hash(PASSWORD);
  const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash, fullName: 'Сотрудник ИБ' });
  const other = await makeUser(tx, ['ib_staff'], { passwordHash: hash, fullName: 'Другой сотрудник' });
  const lawyer = await makeUser(tx, ['legal'], { passwordHash: hash, fullName: 'Юрист' });
  const nobody = await makeUser(tx, [], { passwordHash: hash, fullName: 'Без ролей' });
  const login = async (login: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
  };
  const upload = (cookie: string, name: string, body: Buffer) => app.inject({
    method: 'POST', url: '/api/v1/files', payload: body,
    headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
  });
  const get = (cookie: string, id: string) => app.inject({ url: `/api/v1/files/${id}/content`, headers: { cookie } });
  return { root, app, staff, other, lawyer, nobody, login, upload, get };
}

const diskCount = (root: string) => readdirSync(root, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;

describe('файлы по HTTP', () => {
  it('подмена расширения и запрещённые типы отклоняются до записи на диск; превышение 25 МБ — 413', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const S = await s.login(s.staff.login);
      const fake = await s.upload(S, 'скриншот.png', Buffer.from('<html><script>alert(1)</script></html>'));
      expect(fake.statusCode).toBe(400);
      expect(fake.json().error.code).toBe('FILE_TYPE_MISMATCH');
      const pdfAsPng = await s.upload(S, 'настройки.png', tinyPdf());
      expect(pdfAsPng.json().error.code).toBe('FILE_TYPE_MISMATCH');
      const svg = await s.upload(S, 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
      expect(svg.json().error.code).toBe('BAD_FILE_TYPE');
      const big = await s.upload(S, 'выгрузка.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 0x41));
      expect(big.statusCode).toBe(413);
      expect(big.json().error).toEqual({ code: 'FILE_TOO_LARGE', message: 'Файл больше 25 МБ' });
      expect(await tx.file.count({ where: { uploadedBy: s.staff.id } })).toBe(0);
      expect(diskCount(s.root)).toBe(0);

      const ok = await s.upload(S, 'Протокол №7.pdf', tinyPdf());
      expect(ok.statusCode).toBe(201);
      const f = ok.json();
      expect(f).toMatchObject({ name: 'Протокол №7.pdf', mime: 'application/pdf', size: tinyPdf().length });
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      const row = await tx.file.findUniqueOrThrow({ where: { id: f.id } });
      expect(row.storageKey).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
      expect(row.storageKey).not.toContain('Протокол');
      expect(diskCount(s.root)).toBe(1);
    }));

  it('загружать может ib.work или право документов; без прав — 403', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      expect((await s.upload(await s.login(s.nobody.login), 'a.png', tinyPng())).statusCode).toBe(403);
      expect((await s.upload(await s.login(s.lawyer.login), 'a.png', tinyPng())).statusCode).toBe(201);
    }));

  it('выдача: без права на объект — 404; заголовки attachment, nosniff, sandbox', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const S = await s.login(s.staff.login);
      const O = await s.login(s.other.login);
      const L = await s.login(s.lawyer.login);
      const id = (await s.upload(S, 'скрин настроек.png', tinyPng())).json().id as string;

      // Непривязанный файл видит только загрузивший.
      expect((await s.get(O, id)).statusCode).toBe(404);
      const own = await s.get(S, id);
      expect(own.statusCode).toBe(200);
      expect(own.rawPayload.equals(tinyPng())).toBe(true);
      expect(own.headers['content-type']).toBe('image/png');
      expect(own.headers['x-content-type-options']).toBe('nosniff');
      expect(own.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
      expect(own.headers['content-disposition']).toBe(`attachment; filename="_____ ________.png"; filename*=UTF-8''${encodeURIComponent('скрин настроек.png')}`);
      expect(own.headers['cache-control']).toBe('private, no-store');

      // Приложен к доказательству: видят сотрудники ИБ, юрист (без ib.work) — нет.
      const sys = await tx.catalogItem.create({ data: { catalogCode: 'systems', value: `AD ${Date.now().toString(36)}` } });
      await evidence.createEvidence(tx, await actorFor(tx, s.staff.id), { kind: 'file', object: { type: 'system', id: sys.id }, title: 'Политика паролей GPO', fileIds: [id] });
      expect((await s.get(O, id)).statusCode).toBe(200);
      expect((await s.get(L, id)).statusCode).toBe(404);
      expect((await s.app.inject({ url: `/api/v1/files/${id}`, headers: { cookie: L } })).statusCode).toBe(404);
      const meta = await s.app.inject({ url: `/api/v1/files/${id}`, headers: { cookie: O } });
      expect(meta.json().refs[0]).toMatchObject({ kind: 'evidence' });
      // Выдача пишется в журнал.
      expect(await tx.auditLog.count({ where: { action: 'file.downloaded', entityId: id } })).toBeGreaterThan(0);
    }));

  it('файлы документа: юрист видит файлы подписанной версии, но не драфта', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const S = await s.login(s.staff.login);
      const L = await s.login(s.lawyer.login);
      const admin = await makeUser(tx, ['super_admin']);
      const type = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: `Политика ${Date.now().toString(36)}` } });
      const docId = await docs.createDocument(tx, await actorFor(tx, admin.id), { title: 'Политика ИБ', typeId: type.id, ownerId: s.staff.id, onlyofficeUrl: 'https://office.local/1' });
      const draft = (await s.upload(S, 'Политика.pdf', tinyPdf())).json().id as string;
      const d = await tx.document.findUniqueOrThrow({ where: { id: docId } });
      await docs.addDraftFiles(tx, await actorFor(tx, s.staff.id), docId, { version: d.version, stage: 11, fileIds: [draft] });
      expect((await s.get(L, draft)).statusCode).toBe(404);
      const meta = await s.app.inject({ url: `/api/v1/files/${draft}`, headers: { cookie: S } });
      expect(meta.json().refs[0]).toMatchObject({ kind: 'document_file', id: docId });
      const signed = (await s.upload(S, 'Подписан.pdf', tinyPdf())).json().id as string;
      const vid = must(d.workingVersionId);
      await tx.documentVersion.update({ where: { id: vid }, data: { stage: 16, pdfFileId: signed, approvedAt: new Date(), signedOn: new Date('2026-10-27T00:00:00Z') } });
      await tx.document.update({ where: { id: docId }, data: { approvedVersionId: vid, workingVersionId: null, reviewDue: new Date('2027-10-27T00:00:00Z') } });
      expect((await s.get(L, signed)).statusCode).toBe(200);
      expect((await s.get(L, draft)).statusCode).toBe(200);
    }));

  it('файл с несколькими ссылками не удаляется; без ссылок — только мягко; DELETE запрещён', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const S = await s.login(s.staff.login);
      const id = (await s.upload(S, 'протокол.pdf', tinyPdf())).json().id as string;
      const keep = (await s.upload(S, 'второй.png', tinyPng())).json().id as string;
      const sys = await tx.catalogItem.create({ data: { catalogCode: 'systems', value: `Почта ${Date.now().toString(36)}` } });
      const a = await actorFor(tx, s.staff.id);
      const e1 = await evidence.createEvidence(tx, a, { kind: 'file', object: { type: 'system', id: sys.id }, title: 'Первое', fileIds: [id, keep] });
      const keep2 = (await s.upload(S, 'третий.png', tinyPng())).json().id as string;
      const e2 = await evidence.createEvidence(tx, a, { kind: 'file', object: { type: 'system', id: sys.id }, title: 'Второе', fileIds: [id, keep2] });
      const staff = { ...a, perms: new Set(['ib.work']) };
      const ver = async (eid: string) => (await tx.evidence.findUniqueOrThrow({ where: { id: eid } })).version;

      // Убран из первого — остаётся: на него ссылается второе доказательство.
      await evidence.removeEvidenceFile(tx, staff, e1, id, await ver(e1));
      expect((await tx.file.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
      expect((await s.get(S, id)).statusCode).toBe(200);
      // Прямая отметка «удалён» при живой ссылке отклоняется триггером.
      await tx.$executeRawUnsafe('SAVEPOINT s1');
      await expect(tx.$executeRawUnsafe(`UPDATE files SET deleted_at = now() WHERE id = '${id}'`)).rejects.toThrow(/есть ссылки/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s1');
      // Убран и из второго — помечен удалённым, но содержимое на диске осталось.
      await evidence.removeEvidenceFile(tx, staff, e2, id, await ver(e2));
      const row = await tx.file.findUniqueOrThrow({ where: { id } });
      expect(row.deletedAt).not.toBeNull();
      expect((await s.get(S, id)).statusCode).toBe(404);
      expect(await diskFileStore(s.root).size(row.storageKey)).toBe(tinyPdf().length);
      // Физическое удаление строки запрещено (права и триггер).
      await tx.$executeRawUnsafe('SAVEPOINT s2');
      await expect(tx.$executeRawUnsafe(`DELETE FROM files WHERE id = '${id}'`)).rejects.toThrow();
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s2');
      // К удалённому файлу новую ссылку не создать.
      await tx.$executeRawUnsafe('SAVEPOINT s3');
      await expect(tx.$executeRawUnsafe(`INSERT INTO evidence_files (evidence_id, file_id, added_by) VALUES ('${e1}', '${id}', '${s.staff.id}')`)).rejects.toThrow(/файл удалён/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s3');
    }));

  it('непривязанные файлы старше суток — мягкое удаление в часовом прогоне с записью в журнал', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const S = await s.login(s.staff.login);
      const forgotten = (await s.upload(S, 'забыли.png', tinyPng())).json().id as string;
      const used = (await s.upload(S, 'приложен.png', tinyPng())).json().id as string;
      const sys = await tx.catalogItem.create({ data: { catalogCode: 'systems', value: `IB ${Date.now().toString(36)}` } });
      await evidence.createEvidence(tx, await actorFor(tx, s.staff.id), { kind: 'file', object: { type: 'system', id: sys.id }, title: 'Скрин', fileIds: [used] });
      const deleted = async (id: string) => (await tx.file.findUniqueOrThrow({ where: { id } })).deletedAt !== null;

      // Через минуту после загрузки ничего не трогается.
      expect(await sweepOrphanFiles(tx, new Date(Date.now() + 60_000))).toBe(0);
      expect(await deleted(forgotten)).toBe(false);

      // Через 25 часов: непривязанный помечен удалённым, приложенный — нет; содержимое на диске осталось.
      expect(await sweepOrphanFiles(tx, new Date(Date.now() + 25 * 3_600_000))).toBe(1);
      expect(await deleted(forgotten)).toBe(true);
      expect(await deleted(used)).toBe(false);
      const log = must(await tx.auditLog.findFirst({ where: { action: 'file.orphan_deleted', entityId: forgotten } }));
      expect(log.userId).toBeNull();
      expect((log.diff as { summary: string }).summary).toMatch(/никуда не приложен/);
      expect(diskCount(s.root)).toBe(2);
      // Помеченный удалённым к доказательству уже не приложить.
      await expect(evidence.createEvidence(tx, await actorFor(tx, s.staff.id), { kind: 'file', object: { type: 'system', id: sys.id }, title: 'Поздно', fileIds: [forgotten] }))
        .rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    }));
});
