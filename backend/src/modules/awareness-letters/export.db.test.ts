// Экспорт учебного письма с настоящей БД (1.9.0, шаг 6; docs/specs/awareness.md, раздел 16): версия, язык, подпись,
// журнал; .eml по HTTP. Письма и люди вымышленные (раздел 11).
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as exporter from './export.service.js';
import * as letters from './letters.service.js';
import { SIGNATURE_BLOCK } from './variables.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const content = {
  subjectRu: 'Осторожно: поддельные письма', subjectTj: 'Эҳтиёт: мактубҳои қалбакӣ',
  htmlRu: `<p>Не открывайте <a href="https://example.org/x">ссылки</a>.</p><p><img src="data:image/png;base64,${PNG}" alt="пример"></p>${SIGNATURE_BLOCK}`,
  htmlTj: `<p>Пайвандҳоро накушоед.</p><p><img src="data:image/png;base64,${PNG}" alt="намуна"></p>${SIGNATURE_BLOCK}`,
};
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
  it('черновик: .eml, буфер и печать с текущей подписью; RU+TJ — тема «RU / TJ»; каждый экспорт — в журнале', () =>
    inTx(async (tx) => {
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      await setSignature(tx, '<p>Подпись RU</p>', '<p>Имзо TJ</p>');
      const { letter } = await letters.createLetter(tx, staff, { title: 'Март: фишинг', kind: 'planned', ...content });
      expect(letter.exportLangs).toEqual(['ru', 'tj', 'both']);

      const { eml, title } = await exporter.exportEml(tx, staff, letter.id, { lang: 'both' });
      expect(title).toBe('Март: фишинг');
      expect(eml).toMatch(/^MIME-Version: 1\.0\r\nX-Unsent: 1\r\nSubject: =\?UTF-8\?B\?/);
      expect(eml).not.toMatch(/^(From|To|Date):/m);
      expect(eml.match(/Content-ID: </g)?.length).toBe(1); // одно изображение в обоих языках — одна часть
      const html = emlHtml(eml);
      expect(html).toContain('src="cid:img-');
      expect(html).toContain('<p style="margin:0 0 10px">Подпись RU</p>');
      expect(html.indexOf('Подпись RU')).toBeLessThan(html.indexOf('Имзо TJ'));
      expect((await lastAudit(tx)).diff).toMatchObject({ format: 'eml', lang: 'both', versionNo: 1 });

      const clip = await exporter.exportHtml(tx, staff, letter.id, { lang: 'ru' });
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

  it('срочное на одном языке — выгружается только он; пустой язык — 400 LANG_NOT_AVAILABLE', () =>
    inTx(async (tx) => {
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const { letter } = await letters.createLetter(tx, staff, {
        title: 'Инцидент', kind: 'urgent', reason: 'Новая схема', subjectRu: 'Внимание', htmlRu: '<p>Текст</p>', subjectTj: '', htmlTj: '',
      });
      expect(letter.exportLangs).toEqual(['ru']);
      await expectCode(exporter.exportEml(tx, staff, letter.id, { lang: 'tj' }), 'LANG_NOT_AVAILABLE');
      await expectCode(exporter.exportHtml(tx, staff, letter.id, { lang: 'both' }), 'LANG_NOT_AVAILABLE');
      expect((await exporter.exportHtml(tx, staff, letter.id, { lang: 'ru' })).subject).toBe('Внимание');
      await expectCode(exporter.exportPrint(tx, staff, letter.id, { lang: 'ru', version: 7 }), 'NOT_FOUND');
    }));

  it('отправленное: по умолчанию версия sent с подписью на дату отправки; ранняя версия — с текущей подписью', () =>
    inTx(async (tx) => {
      const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
      await setSignature(tx, '<p>Старая подпись</p>', '<p>Имзои кӯҳна</p>');
      const { letter } = await letters.createLetter(tx, head, { title: 'Отправлено', kind: 'planned', ...content });
      const s = await letters.submitLetter(tx, head, letter.id, { version: letter.version });
      const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      const sent = await letters.sendLetter(tx, head, letter.id, { version: a.version, sentOn: todayIso, audience: 'Все сотрудники' }, { now: () => today });
      await setSignature(tx, '<p>Новая подпись</p>', '<p>Имзои нав</p>');

      const frozen = await exporter.exportHtml(tx, head, letter.id, { lang: 'ru' });
      expect([frozen.versionNo, frozen.html.includes('Старая подпись'), frozen.html.includes('Новая подпись')]).toEqual([sent.sentVersionNo, true, false]);
      const early = await exporter.exportHtml(tx, head, letter.id, { lang: 'ru', version: 1 });
      expect([early.versionNo, early.html.includes('Новая подпись')]).toEqual([1, true]);
    }));

  it('по HTTP: .eml — message/rfc822, имя файла из названия; служебная учётная запись — 403', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Export-Test-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const svc = await makeUser(tx, ['portal_admin'], { passwordHash: hash });
      const { letter } = await letters.createLetter(tx, await actorFor(tx, staff.id), { title: 'Март: фишинг', kind: 'planned', ...content });
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
      });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((x) => x.name === 'ib_session')?.value}`;
      };
      const res = await app.inject({ url: `/api/v1/awareness/letters/${letter.id}/export.eml?lang=ru`, headers: { cookie: await login(staff.login) } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('message/rfc822');
      expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('Март фишинг.eml')}`);
      expect(res.body).toContain('X-Unsent: 1');
      const bad = await app.inject({ url: `/api/v1/awareness/letters/${letter.id}/export/print?lang=xx`, headers: { cookie: await login(staff.login) } });
      expect(bad.statusCode).toBe(400);
      const denied = await app.inject({ url: `/api/v1/awareness/letters/${letter.id}/export/html?lang=ru`, headers: { cookie: await login(svc.login) } });
      expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'SERVICE_ACCOUNT']);
    }));
});
