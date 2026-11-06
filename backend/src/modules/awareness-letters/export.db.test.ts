// Экспорт учебного письма с настоящей БД (1.9.0; 1.12.0 — макет и выгрузка файлом, docs/specs/awareness.md, разделы 16,
// 22–24): версия, язык, подпись, журнал, файл выгрузки; .eml по HTTP. Письма и люди вымышленные (раздел 11).
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as exporter from './export.service.js';
import * as letters from './letters.service.js';
import { SIGNATURE_BLOCK } from './variables.js';

const store = diskFileStore(mkdtempSync(join(tmpdir(), 'ibportal-eml-')));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const content = {
  subjectRu: 'Осторожно: поддельные письма', subjectTj: 'Эҳтиёт: мактубҳои қалбакӣ',
  htmlRu: `<p>Не открывайте <a href="https://example.org/x">ссылки</a>.</p><p><img src="data:image/png;base64,${PNG}" alt="пример"></p>${SIGNATURE_BLOCK}`,
  htmlTj: `<p>Пайвандҳоро накушоед.</p><p><img src="data:image/png;base64,${PNG}" alt="намуна"></p>${SIGNATURE_BLOCK}`,
};
const plain = { subjectRu: 'Памятка', subjectTj: 'Ёддошт', htmlRu: '<p>Текст памятки.</p>', htmlTj: '<p>Матни ёддошт.</p>' };
const today = new Date();
const todayIso = today.toISOString().slice(0, 10);

async function setSignature(tx: Tx, ru: string, tj: string) {
  await tx.awarenessFragment.upsert({ where: { code: 'signature' }, create: { code: 'signature', htmlRu: ru, htmlTj: tj }, update: { htmlRu: ru, htmlTj: tj } });
}

/** HTML-часть .eml: base64 после заголовка text/html до следующего разделителя. */
function emlHtml(eml: string): string {
  const after = eml.split('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1] ?? '';
  return Buffer.from(after.split('\r\n--')[0]?.replace(/\r\n/g, '') ?? '', 'base64').toString('utf8');
}

describe('экспорт учебного письма', () => {
  it('черновик: .eml по макету с текущей подписью, выгрузка сохраняется файлом; буфер и печать; всё — в журнале', () =>
    inTx(async (tx) => {
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      await setSignature(tx, '<p>Подпись RU</p>', '<p>Имзо TJ</p>');
      const { letter } = await letters.createLetter(tx, staff, { title: 'Март: фишинг', kind: 'planned', ...content });
      expect(letter.exportLangs).toEqual(['ru', 'tj', 'both']);
      expect([letter.content.labelRu, letter.content.labelTj]).toEqual(['ПАМЯТКА', 'ЁДДОШТ']);

      const { eml, fileName } = await exporter.exportEml(tx, store, staff, letter.id, { lang: 'both' }, { now: () => today });
      const text = eml.toString('utf8');
      expect(fileName).toBe(`Осторожно_ поддельные письма_RU-TJ_${todayIso}.eml`);
      expect(text).toMatch(/^MIME-Version: 1\.0\r\nX-Unsent: 1\r\nSubject: =\?UTF-8\?B\?/);
      expect(text).toContain('Content-Language: ru, tg');
      expect(text).not.toMatch(/^(From|To|Cc|Date):/m);
      expect(text.match(/Content-ID: </g)?.length).toBe(1); // одно изображение в обоих языках — одна часть
      const html = emlHtml(text);
      expect(html).toContain('src="cid:img-');
      expect(html).toContain('Подпись RU');
      expect(html).not.toContain('С уважением,'); // в тексте блок «Подпись ИБ» — подпись макета не выводится
      expect(html.indexOf('Подпись RU')).toBeLessThan(html.indexOf('Имзо TJ'));
      expect(html).toContain('background:#1E3A8A');
      const audit = await lastAudit(tx);
      expect(audit.diff).toMatchObject({ format: 'eml', lang: 'both', versionNo: 1 });
      const exp = await tx.awarenessLetterExport.findFirstOrThrow({ where: { letterId: letter.id }, include: { file: true } });
      expect(exp).toMatchObject({ langs: 'both', file: { mime: 'message/rfc822', originalName: fileName } });
      expect((audit.diff as { sha256: string }).sha256).toBe(exp.sha256);
      expect(await tx.registerRecord.count({ where: { register: { systemKey: 'awareness_mailings' } } })).toBe(0); // выгрузка — не отправка

      const clip = await exporter.exportHtml(tx, store, staff, letter.id, { lang: 'ru' });
      expect(clip.subject).toBe(content.subjectRu);
      expect(clip.html).toContain('data:image/png;base64,');
      expect(clip.html).not.toContain('Имзо TJ');
      expect(clip.text).toContain('ссылки (https://example.org/x)');
      expect((await lastAudit(tx)).action).toBe('awareness_letter.exported');

      const print = await exporter.exportPrint(tx, staff, letter.id, { lang: 'both' });
      expect(print.parts.map((p) => [p.lang, p.subject])).toEqual([['ru', content.subjectRu], ['tj', content.subjectTj]]);
      expect(print.parts[0]?.html).toContain('<div><p>Подпись RU</p></div>');
      expect(print.parts[0]?.html).not.toContain('style=');
    }));

  it('без блока подписи — подпись макета; лимит письма — по готовому .eml (413)', () =>
    inTx(async (tx) => {
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const { letter } = await letters.createLetter(tx, staff, { title: 'Памятка', kind: 'planned', ...plain });
      const html = emlHtml((await exporter.exportEml(tx, store, staff, letter.id, { lang: 'ru' })).eml.toString('utf8'));
      expect(html).toContain('С уважением,<br><b>Отдел информационной безопасности</b>');
      const big = await letters.createLetter(tx, staff, { title: 'Большое', kind: 'planned', ...plain, htmlRu: `<p>${'Длинный текст письма. '.repeat(2400)}</p>` });
      await tx.appSetting.update({ where: { key: 'awareness.letters' }, data: { value: { maxImageKb: 16, maxLetterKb: 64, warnLetterKb: 16 } } });
      await expectCode(exporter.exportEml(tx, store, staff, big.letter.id, { lang: 'ru' }), 'LETTER_TOO_LARGE');
    }));

  it('срочное на одном языке — выгружается только он; пустой язык — 400 LANG_NOT_AVAILABLE', () =>
    inTx(async (tx) => {
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const { letter } = await letters.createLetter(tx, staff, {
        title: 'Инцидент', kind: 'urgent', reason: 'Новая схема', subjectRu: 'Внимание', htmlRu: '<p>Текст</p>', subjectTj: '', htmlTj: '',
      });
      expect(letter.exportLangs).toEqual(['ru']);
      await expectCode(exporter.exportEml(tx, store, staff, letter.id, { lang: 'tj' }), 'LANG_NOT_AVAILABLE');
      await expectCode(exporter.exportHtml(tx, store, staff, letter.id, { lang: 'both' }), 'LANG_NOT_AVAILABLE');
      expect((await exporter.exportHtml(tx, store, staff, letter.id, { lang: 'ru' })).subject).toBe('Внимание');
      await expectCode(exporter.exportPrint(tx, staff, letter.id, { lang: 'ru', version: 7 }), 'NOT_FOUND');
    }));

  it('отправленное: версия sent с подписью на дату отправки; на языке отправки — отправленный файл; ранняя версия — текущая подпись', () =>
    inTx(async (tx) => {
      const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
      await setSignature(tx, '<p>Старая подпись</p>', '<p>Имзои кӯҳна</p>');
      const { letter } = await letters.createLetter(tx, head, { title: 'Отправлено', kind: 'planned', ...content });
      const s = await letters.submitLetter(tx, head, letter.id, { version: letter.version });
      const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      const sent = await letters.sendLetter(tx, head, letter.id, { version: a.version, sentOn: todayIso, audience: 'Все сотрудники' }, { now: () => today, store });
      await setSignature(tx, '<p>Новая подпись</p>', '<p>Имзои нав</p>');

      const frozen = await exporter.exportHtml(tx, store, head, letter.id, { lang: 'ru' });
      expect([frozen.versionNo, frozen.html.includes('Старая подпись'), frozen.html.includes('Новая подпись'), frozen.html.includes('С уважением,')])
        .toEqual([sent.sentVersionNo, true, false, false]);
      const event = await tx.awarenessLetterEvent.findFirstOrThrow({ where: { letterId: letter.id, action: 'sent' }, include: { export: true } });
      const again = await exporter.exportEml(tx, store, head, letter.id, { lang: 'both' });
      expect(createHash('sha256').update(again.eml).digest('hex')).toBe(event.export?.sha256);
      expect((await lastAudit(tx)).diff).toMatchObject({ sentFile: true });
      const early = await exporter.exportHtml(tx, store, head, letter.id, { lang: 'ru', version: 1 });
      expect([early.versionNo, early.html.includes('Новая подпись')]).toEqual([1, true]);
    }));

  it('предпросмотр из несохранённого содержимого: тот же макет, санитайзер, ссылка на портал — 400', () =>
    inTx(async (tx) => {
      const p = await exporter.previewMail(tx, store, { ...plain, headerRu: 'Свой заголовок', kind: 'urgent', lang: 'both' }, { portalUrl: 'https://portal.example.local' });
      expect(p.subject).toBe('Памятка | Ёддошт');
      expect(p.html).toContain('>Свой заголовок</p>');
      expect(p.html).toContain('>ВАЖНАЯ ИНФОРМАЦИЯ</p>');
      expect(p.html).toContain('href="#tj"');
      await expectCode(
        exporter.previewMail(tx, store, { ...plain, htmlRu: '<p><a href="https://portal.example.local/x">x</a></p>', kind: 'planned', lang: 'ru' }, { portalUrl: 'https://portal.example.local' }),
        'PORTAL_LINK',
      );
    }));

  it('по HTTP: .eml — message/rfc822, вложением, nosniff, имя «Тема_RU_дата»; служебная учётная запись — 403', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Export-Test-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const svc = await makeUser(tx, ['portal_admin'], { passwordHash: hash });
      const { letter } = await letters.createLetter(tx, await actorFor(tx, staff.id), { title: 'Март: фишинг', kind: 'planned', ...content });
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, files: store,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
      });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((x) => x.name === 'ib_session')?.value}`;
      };
      const res = await app.inject({ url: `/api/v1/awareness/letters/${letter.id}/export.eml?lang=ru`, headers: { cookie: await login(staff.login) } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('message/rfc822');
      expect(res.headers['content-disposition']).toMatch(/^attachment; /);
      expect(res.headers['content-disposition']).toContain(encodeURIComponent('Осторожно_ поддельные письма_RU_'));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toContain('X-Unsent: 1');
      const bad = await app.inject({ url: `/api/v1/awareness/letters/${letter.id}/export/print?lang=xx`, headers: { cookie: await login(staff.login) } });
      expect(bad.statusCode).toBe(400);
      const denied = await app.inject({ url: `/api/v1/awareness/letters/${letter.id}/export/html?lang=ru`, headers: { cookie: await login(svc.login) } });
      expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'SERVICE_ACCOUNT']);
      const layoutDenied = await app.inject({ url: '/api/v1/awareness/layout', headers: { cookie: await login(svc.login) } });
      expect(layoutDenied.statusCode).toBe(403);
    }));
});
