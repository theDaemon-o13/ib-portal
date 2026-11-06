// Шаблоны, «Письмо из шаблона» и «Подпись ИБ» с настоящей БД (1.9.0, шаг 5; docs/specs/awareness.md, раздел 17).
// Шаблоны, письма и люди вымышленные (раздел 11).
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { SERVICE_ROLE_CODE } from '../../lib/work-users.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as letters from './letters.service.js';
import * as templates from './templates.service.js';
import { SIGNATURE_BLOCK } from './variables.js';

const tpl = {
  title: 'Поддельный звонок',
  subjectRu: 'Осторожно: {{схема}}', subjectTj: 'Эҳтиёт: {{схема TJ}}',
  htmlRu: '<p>Вам звонят от имени {{организация}}.</p><p>{{подпись}}</p>',
  htmlTj: '<p>Аз номи {{Организация}} занг мезананд.</p><p>{{подпись}}</p>',
};
const values = { схема: 'звонок «из банка»', 'схема tj': 'занги «аз бонк»', организация: '<b>Банка</b> & Co' };
const today = new Date();
const todayIso = today.toISOString().slice(0, 10);

async function setSignature(tx: Tx, ru: string, tj: string) {
  await tx.awarenessFragment.upsert({ where: { code: 'signature' }, create: { code: 'signature', htmlRu: ru, htmlTj: tj }, update: { htmlRu: ru, htmlTj: tj } });
}

describe('шаблоны писем', () => {
  it('переменные из тем и текстов без {{подпись}}; правка с version и журналом без HTML; архив закрывает правку', () =>
    inTx(async (tx) => {
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const { template: t } = await templates.createTemplate(tx, staff, tpl);
      expect(t.variables.map((v) => v.label)).toEqual(['схема', 'схема TJ', 'организация']);
      expect(t.content.htmlRu).toBe(tpl.htmlRu);
      await expectCode(templates.createTemplate(tx, staff, { ...tpl, subjectRu: 'Тема {{подпись}}' }), 'BAD_TEMPLATE');
      await expectCode(templates.createTemplate(tx, staff, { ...tpl, title: ' ' }), 'TITLE_REQUIRED');

      const { template: t2 } = await templates.updateTemplate(tx, staff, t.id, { ...tpl, htmlRu: '<p>Новый текст {{дата}}</p>', version: t.version });
      expect([t2.version, t2.variables.map((v) => v.label)]).toEqual([t.version + 1, ['схема', 'схема TJ', 'дата', 'Организация']]);
      const a = await lastAudit(tx);
      expect([a.action, a.entity]).toEqual(['awareness_template.updated', 'awareness_template']);
      expect(JSON.stringify(a.diff)).not.toContain('<p>');
      await expectCode(templates.updateTemplate(tx, staff, t.id, { ...tpl, version: t.version }), 'VERSION_CONFLICT');

      const archived = await templates.archiveTemplate(tx, staff, t.id, { version: t2.version, archived: true });
      expect(archived.archived).toBe(true);
      await expectCode(templates.updateTemplate(tx, staff, t.id, { ...tpl, version: archived.version }), 'TEMPLATE_ARCHIVED');
      await expectCode(templates.letterFromTemplate(tx, staff, t.id, { title: 'x', kind: 'planned', values }), 'TEMPLATE_ARCHIVED');
      expect((await templates.listTemplates(tx, { scope: 'active', limit: 50 })).items.map((i) => i.id)).not.toContain(t.id);
      expect((await templates.listTemplates(tx, { scope: 'archived', limit: 50 })).items.map((i) => i.id)).toContain(t.id);
      const back = await templates.archiveTemplate(tx, staff, t.id, { version: archived.version, archived: false });
      expect(back.archived).toBe(false);
    }));
});

describe('«Письмо из шаблона»', () => {
  it('пустая переменная — 400 со списком, письма нет; значения экранируются, {{подпись}} — блок; правка шаблона письмо не меняет', () =>
    inTx(async (tx) => {
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const { template: t } = await templates.createTemplate(tx, staff, tpl);
      const before = await tx.awarenessLetter.count();
      await expectCode(templates.letterFromTemplate(tx, staff, t.id, { title: 'Март', kind: 'planned', values: { ...values, организация: '  ' } }), 'UNFILLED_VARIABLES');
      expect(await tx.awarenessLetter.count()).toBe(before);

      const { letter } = await templates.letterFromTemplate(tx, staff, t.id, { title: 'Март', kind: 'planned', values });
      expect([letter.status, letter.template, letter.versions.map((v) => v.reason)]).toEqual(['draft', { id: t.id, title: tpl.title }, ['template']]);
      expect(letter.content).toMatchObject({
        subjectRu: 'Осторожно: звонок «из банка»', subjectTj: 'Эҳтиёт: занги «аз бонк»',
        htmlRu: `<p>Вам звонят от имени &lt;b&gt;Банка&lt;/b&gt; &amp; Co.</p>${SIGNATURE_BLOCK}`,
        htmlTj: `<p>Аз номи &lt;b&gt;Банка&lt;/b&gt; &amp; Co занг мезананд.</p>${SIGNATURE_BLOCK}`,
      });
      expect((await lastAudit(tx)).diff).toMatchObject({ templateId: t.id });
      // Письмо без переменных сразу уходит на согласование.
      expect((await letters.submitLetter(tx, staff, letter.id, { version: letter.version })).status).toBe('review');

      await templates.updateTemplate(tx, staff, t.id, { ...tpl, subjectRu: 'Другая тема', version: t.version });
      expect((await letters.getLetter(tx, staff.id, letter.id)).content.subjectRu).toBe('Осторожно: звонок «из банка»');
      await expectCode(templates.letterFromTemplate(tx, staff, t.id, { title: 'Срочно', kind: 'urgent', values }), 'REASON_REQUIRED');
    }));
});

describe('«Подпись ИБ»', () => {
  it('правка: санитизация, без переменных и вложенного блока, version, журнал; отправленное письмо хранит прежнюю подпись', () =>
    inTx(async (tx) => {
      const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      await setSignature(tx, '<p>Старая подпись</p>', '<p>Имзои кӯҳна</p>');
      const sig0 = await templates.getSignature(tx, admin.perms);
      expect([sig0.htmlRu, sig0.canEdit]).toEqual(['<p>Старая подпись</p>', true]);
      expect((await templates.getSignature(tx, head.perms)).canEdit).toBe(false);

      // Письмо отправлено со старой подписью.
      const body = { subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: `<p>Текст</p>${SIGNATURE_BLOCK}`, htmlTj: `<p>Матн</p>${SIGNATURE_BLOCK}` };
      const { letter } = await letters.createLetter(tx, head, { title: 'Со старой подписью', kind: 'planned', ...body });
      const s = await letters.submitLetter(tx, head, letter.id, { version: letter.version });
      const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      await letters.sendLetter(tx, head, letter.id, { version: a.version, sentOn: todayIso, audience: 'Все сотрудники' }, { now: () => today });

      await expectCode(templates.updateSignature(tx, admin, { htmlRu: '<p>{{телефон}}</p>', htmlTj: '<p>x</p>', version: sig0.version }), 'SIGNATURE_VARIABLES');
      const { signature } = await templates.updateSignature(tx, admin, {
        htmlRu: `<p onclick="x()">Новая подпись</p>${SIGNATURE_BLOCK}<script>1</script>`, htmlTj: '<p>Имзои нав</p>', version: sig0.version,
      });
      expect([signature.htmlRu, signature.version, signature.updatedBy?.id]).toEqual(['<p>Новая подпись</p>', sig0.version + 1, admin.id]);
      const au = await lastAudit(tx);
      expect([au.action, au.entity, au.entityId]).toEqual(['awareness_fragment.updated', 'awareness_fragment', 'signature']);
      await expectCode(templates.updateSignature(tx, admin, { htmlRu: '<p>x</p>', htmlTj: '<p>y</p>', version: sig0.version }), 'VERSION_CONFLICT');

      expect((await letters.getLetter(tx, head.id, letter.id)).content.htmlRu).toBe('<p>Текст</p><div data-ib-fragment="signature-sent"><p>Старая подпись</p></div>');
    }));

  it('по HTTP: читает ib.work, правит settings.manage + ib.work; служебная учётная запись — 403 SERVICE_ACCOUNT', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Signature-Test-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const svc = await makeUser(tx, [SERVICE_ROLE_CODE], { passwordHash: hash });
      await setSignature(tx, '<p>Подпись</p>', '<p>Имзо</p>');
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
      });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((x) => x.name === 'ib_session')?.value}`;
      };
      const S = await login(staff.login);
      const A = await login(admin.login);
      const V = await login(svc.login);
      const sig = await app.inject({ url: '/api/v1/awareness/signature', headers: { cookie: S } });
      expect([sig.statusCode, sig.json().canEdit]).toEqual([200, false]);
      const payload = { htmlRu: '<p>Новая</p>', htmlTj: '<p>Нав</p>', version: sig.json().version };
      expect((await app.inject({ method: 'PUT', url: '/api/v1/awareness/signature', headers: { cookie: S }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url: '/api/v1/awareness/signature', headers: { cookie: A }, payload })).statusCode).toBe(200);
      for (const url of ['/api/v1/awareness/signature', '/api/v1/awareness/templates']) {
        const res = await app.inject({ url, headers: { cookie: V } });
        expect([res.statusCode, res.json().error.code], url).toEqual([403, 'SERVICE_ACCOUNT']);
      }
      const created = await app.inject({ method: 'POST', url: '/api/v1/awareness/templates', headers: { cookie: S }, payload: tpl });
      expect(created.statusCode).toBe(201);
      const fromTpl = await app.inject({
        method: 'POST', url: `/api/v1/awareness/templates/${created.json().template.id}/letter`, headers: { cookie: S },
        payload: { title: 'Из шаблона по HTTP', kind: 'planned', values },
      });
      expect([fromTpl.statusCode, fromTpl.json().letter.versions[0].reason]).toEqual([201, 'template']);
    }));
});

describe('шаблон больше текущего лимита', () => {
  it('лимиты уменьшили после сохранения — в списке и карточке отметка с размерами', () =>
    inTx(async (tx) => {
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const { template } = await templates.createTemplate(tx, staff, { ...tpl, htmlRu: `<p>${'а'.repeat(40_000)}</p>` });
      expect(template.tooLarge).toBeNull();
      await tx.appSetting.upsert({
        where: { key: 'awareness.letters' },
        create: { key: 'awareness.letters', value: { maxImageKb: 16, maxLetterKb: 64, warnLetterKb: 32 } },
        update: { value: { maxImageKb: 16, maxLetterKb: 64, warnLetterKb: 32 } },
      });
      const item = (await templates.listTemplates(tx, { scope: 'active', limit: 200 })).items.find((x) => x.id === template.id);
      expect(item?.tooLarge).toMatch(/^Письмо \d+ КБ — больше допустимых 64 КБ/);
      expect((await templates.getTemplate(tx, template.id)).tooLarge).toBe(item?.tooLarge);
    }));
});
