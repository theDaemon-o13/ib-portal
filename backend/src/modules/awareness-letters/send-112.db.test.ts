// Регистрация отправки и «Оформление писем» (1.12.0, ADR-0046; docs/specs/awareness.md, разделы 22, 25) с настоящей БД:
// запись «Рассылок» с шаблоном, языками, получателями и файлом; снимок названия шаблона; даты; выдача .eml; права.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, makeUser, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { uploadFile } from '../files/service.js';
import { loadRegister } from '../registers/definition.js';
import * as excel from '../registers/excel.service.js';
import { AWARENESS_MAILINGS_KEY } from './definition.js';
import * as exporter from './export.service.js';
import * as layout from './layout.service.js';
import * as letters from './letters.service.js';
import * as templates from './templates.service.js';

const store = diskFileStore(mkdtempSync(join(tmpdir(), 'ibportal-send-')));
const today = new Date();
const todayIso = today.toISOString().slice(0, 10);
const yesterday = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
const tomorrow = new Date(today.getTime() + 86_400_000).toISOString().slice(0, 10);
const plain = { subjectRu: 'Памятка о паролях', subjectTj: 'Ёддошт дар бораи рамзҳо', htmlRu: '<p>Не сообщайте пароль.</p>', htmlTj: '<p>Рамзро нагӯед.</p>' };

async function approvedFromTemplate(tx: Tx, title = 'Плановая памятка') {
  const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
  const { template } = await templates.createTemplate(tx, head, { title, ...plain });
  const { letter } = await templates.letterFromTemplate(tx, head, template.id, { title: 'Ноябрь: пароли', kind: 'planned', values: {} });
  const s = await letters.submitLetter(tx, head, letter.id, { version: letter.version });
  const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
  return { head, template, letter: a };
}

async function mailingRecord(tx: Tx, recordId: string) {
  const reg = await tx.register.findUniqueOrThrow({ where: { systemKey: AWARENESS_MAILINGS_KEY } });
  const def = await loadRegister(tx, reg.id);
  const rec = await tx.registerRecord.findUniqueOrThrow({ where: { id: recordId } });
  const f = (key: string) => def.fields.find((x) => x.systemKey === key);
  const values = rec.values as Record<string, unknown>;
  const files = await tx.registerRecordFile.findMany({ where: { recordId, fieldId: f('file')?.id }, include: { file: true } });
  return {
    template: values[f('template')?.id ?? ''],
    langs: f('langs')?.options.find((o) => o.id === values[f('langs')?.id ?? ''])?.label,
    recipients: values[f('recipients')?.id ?? ''],
    subject: values[f('subject')?.id ?? ''],
    files: files.map((x) => ({ mime: x.file.mime, id: x.fileId })),
  };
}

describe('учебные письма 1.12.0: отметка «Отправлено»', () => {
  it('запись «Рассылок»: шаблон, языки, получатели, файл письма — последняя выгрузка; письмо заморожено', () =>
    inTx(async (tx) => {
      const { head, letter } = await approvedFromTemplate(tx);
      await exporter.exportEml(tx, store, head, letter.id, { lang: 'ru' });
      await exporter.exportEml(tx, store, head, letter.id, { lang: 'both' });
      const sent = await letters.sendLetter(tx, head, letter.id, {
        version: letter.version, sentOn: todayIso, audience: 'Все сотрудники', recipients: 'all@example.org',
      }, { now: () => today, store });
      expect(sent.frozen).toBe(true);
      const ev = await tx.awarenessLetterEvent.findFirstOrThrow({ where: { letterId: letter.id, action: 'sent' }, include: { export: true } });
      expect([ev.langs, ev.recipients, ev.export?.langs]).toEqual(['both', 'all@example.org', 'both']);
      const lastBoth = await tx.awarenessLetterExport.findFirstOrThrow({ where: { letterId: letter.id, langs: 'both' }, orderBy: { createdAt: 'desc' } });
      expect(ev.exportId).toBe(lastBoth.id);
      const rec = await mailingRecord(tx, ev.recordId ?? '');
      expect(rec).toMatchObject({ template: 'Плановая памятка', langs: 'RU+TJ', recipients: 'all@example.org', subject: 'Памятка о паролях | Ёддошт дар бораи рамзҳо' });
      expect(rec.files).toEqual([{ mime: 'message/rfc822', id: lastBoth.fileId }]);
      expect(await letters.lastRecipients(tx)).toBe('all@example.org');
      // Excel «Рассылок»: новые колонки; файл — имя и sha256, содержимого нет.
      const reg = await tx.register.findUniqueOrThrow({ where: { systemKey: AWARENESS_MAILINGS_KEY } });
      const { ws } = await excel.openRegisterSheet((await excel.exportRegister(tx, reg.id)).buffer);
      const header = (ws.getRow(1).values as unknown[]).map(String);
      const col = header.indexOf('Файл письма');
      expect(header).toEqual(expect.arrayContaining(['Шаблон', 'Языки', 'Получатели', 'Файл письма']));
      expect(String(ws.getRow(2).getCell(col).value)).toBe(`${lastBoth.fileId ? (await tx.file.findUniqueOrThrow({ where: { id: lastBoth.fileId } })).originalName : ''}; sha256: ${lastBoth.sha256}`);
    }));

  it('без выгрузки файл собирается при отметке; один язык; переименование шаблона не меняет прежние записи', () =>
    inTx(async (tx) => {
      const { head, letter, template } = await approvedFromTemplate(tx, 'Шаблон до');
      await letters.sendLetter(tx, head, letter.id, { version: letter.version, sentOn: todayIso, audience: 'Бухгалтерия', langs: 'ru' }, { now: () => today, store });
      const ev = await tx.awarenessLetterEvent.findFirstOrThrow({ where: { letterId: letter.id, action: 'sent' } });
      expect(await tx.awarenessLetterExport.count({ where: { letterId: letter.id } })).toBe(1);
      const t = await templates.getTemplate(tx, template.id);
      await templates.updateTemplate(tx, head, template.id, { title: 'Шаблон после', ...plain, version: t.version });
      expect((await mailingRecord(tx, ev.recordId ?? '')).template).toBe('Шаблон до');
      expect((await mailingRecord(tx, ev.recordId ?? '')).langs).toBe('RU');
    }));

  it('письмо не из шаблона — «Без шаблона»; повторная отметка — новая запись со своим файлом', () =>
    inTx(async (tx) => {
      const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
      const { letter } = await letters.createLetter(tx, head, { title: 'Без шаблона', kind: 'planned', ...plain });
      const s = await letters.submitLetter(tx, head, letter.id, { version: letter.version });
      const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      const first = await letters.sendLetter(tx, head, letter.id, { version: a.version, sentOn: todayIso, audience: 'Все сотрудники' }, { now: () => today, store });
      await letters.sendLetter(tx, head, letter.id, { version: first.version, sentOn: todayIso, audience: 'Филиалы', langs: 'tj' }, { now: () => today, store });
      const evs = await tx.awarenessLetterEvent.findMany({ where: { letterId: letter.id, action: 'sent' }, orderBy: { at: 'asc' } });
      expect(evs.map((e) => e.langs)).toEqual(['both', 'tj']);
      const second = await mailingRecord(tx, evs[1]?.recordId ?? '');
      expect([second.template, second.langs, second.files.length]).toEqual(['Без шаблона', 'TJ', 1]);
    }));

  it('дата: будущая — 400; раньше утверждения — 400; язык, которого нет, — 400', () =>
    inTx(async (tx) => {
      const { head, letter } = await approvedFromTemplate(tx);
      await expectCode(letters.sendLetter(tx, head, letter.id, { version: letter.version, sentOn: tomorrow, audience: 'Все' }, { now: () => today, store }), 'BAD_DATE');
      await expectCode(letters.sendLetter(tx, head, letter.id, { version: letter.version, sentOn: yesterday, audience: 'Все' }, { now: () => today, store }), 'BAD_DATE');
      const urgent = await letters.createLetter(tx, head, { title: 'Срочно', kind: 'urgent', reason: 'Инцидент', subjectRu: 'Внимание', htmlRu: '<p>Текст</p>', subjectTj: '', htmlTj: '' });
      await expectCode(letters.sendLetter(tx, head, urgent.letter.id, { version: urgent.letter.version, sentOn: todayIso, audience: 'Все', comment: 'Без согласования: инцидент', langs: 'both' }, { now: () => today, store }), 'LANG_NOT_AVAILABLE');
    }));
});

describe('учебные письма 1.12.0: «Оформление писем» и выдача .eml', () => {
  it('настройки: settings.manage — правка с журналом; логотип PNG до 100 КБ; прежний логотип помечается удалённым', () =>
    inTx(async (tx) => {
      const admin = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'super_admin'])).id);
      const cur = await layout.getLayout(tx, new Set(['settings.manage', 'ib.work']));
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 4, 0, 0, 0, 1, 8, 6, 0, 0, 0]), Buffer.alloc(16)]);
      const f1 = await uploadFile(tx, store, admin, 'logo.png', png);
      await layout.updateLayout(tx, admin, { ...cur, deptRu: 'Отдел ИБ', logoFileId: f1.id, version: cur.version });
      const after = await layout.getLayout(tx, new Set());
      expect([after.deptRu, after.logo?.id, after.canEdit]).toEqual(['Отдел ИБ', f1.id, false]);
      expect(await layout.readLogo(tx, store)).toMatchObject({ width: 238, height: 60 });
      await expectCode(layout.updateLayout(tx, admin, { ...after, email: 'не адрес', logoFileId: f1.id, version: after.version }), 'BAD_EMAIL');
      await expectCode(layout.updateLayout(tx, admin, { ...after, logoFileId: f1.id, version: cur.version }), 'VERSION_CONFLICT');
      const big = await uploadFile(tx, store, admin, 'big.png', Buffer.concat([png, Buffer.alloc(101 * 1024)]));
      await expectCode(layout.updateLayout(tx, admin, { ...after, logoFileId: big.id, version: after.version }), 'LOGO_TOO_LARGE');
      const f2 = await uploadFile(tx, store, admin, 'logo2.png', png);
      await layout.updateLayout(tx, admin, { ...after, logoFileId: f2.id, version: after.version });
      expect((await tx.file.findUniqueOrThrow({ where: { id: f1.id } })).deletedAt).not.toBeNull();
    }));

  it('.eml из «Рассылок» — только вложением и только с ib.work; читатель документов — 404, служебный — 403', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Send-Test-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const { head, letter } = await approvedFromTemplate(tx);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash: hash });
      const svc = await makeUser(tx, ['portal_admin'], { passwordHash: hash });
      await letters.sendLetter(tx, head, letter.id, { version: letter.version, sentOn: todayIso, audience: 'Все' }, { now: () => today, store });
      const ev = await tx.awarenessLetterEvent.findFirstOrThrow({ where: { letterId: letter.id, action: 'sent' }, include: { export: true } });
      const fileId = ev.export?.fileId ?? '';
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, files: store,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
      });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((x) => x.name === 'ib_session')?.value}`;
      };
      const ok = await app.inject({ url: `/api/v1/files/${fileId}/content`, headers: { cookie: await login(staff.login) } });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-disposition']).toMatch(/^attachment; /);
      expect(ok.headers['x-content-type-options']).toBe('nosniff');
      expect(ok.body).toContain('X-Unsent: 1');
      const no = await app.inject({ url: `/api/v1/files/${fileId}/content`, headers: { cookie: await login(reader.login) } });
      expect(no.statusCode).toBe(404);
      const svcRes = await app.inject({ url: `/api/v1/files/${fileId}/content`, headers: { cookie: await login(svc.login) } });
      expect(svcRes.statusCode).toBe(403);
      // .eml через загрузку не принимается: тип создаёт только сервер.
      const up = await app.inject({
        method: 'POST', url: '/api/v1/files', payload: 'X-Unsent: 1\r\n\r\nx',
        headers: { cookie: await login(staff.login), 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('письмо.eml'), origin: TEST_PORTAL_URL },
      });
      expect([up.statusCode, up.json().error.code]).toEqual([400, 'BAD_FILE_TYPE']);
    }));
});
