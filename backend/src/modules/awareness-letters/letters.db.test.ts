// Учебные письма с настоящей БД (1.9.0, шаг 4; docs/specs/awareness.md, разделы 13–14): версии, переходы, заморозка,
// копия, архив, журнал. Письма и люди вымышленные (раздел 11).
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { SERVICE_ROLE_CODE } from '../../lib/work-users.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as letters from './letters.service.js';
import { SIGNATURE_BLOCK } from './variables.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const both = {
  subjectRu: 'Осторожно: поддельные письма', subjectTj: 'Эҳтиёт: мактубҳои қалбакӣ',
  htmlRu: `<p>Не открывайте вложения.</p>${SIGNATURE_BLOCK}`, htmlTj: `<p>Замимаҳоро накушоед.</p>${SIGNATURE_BLOCK}`,
};
const today = new Date();
const todayIso = today.toISOString().slice(0, 10);

async function people(tx: Tx) {
  const author = await actorFor(tx, (await makeUser(tx, ['ib_staff'], { fullName: 'Автор Писем' })).id);
  const other = await actorFor(tx, (await makeUser(tx, ['ib_staff'], { fullName: 'Коллега Писем' })).id);
  const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник Писем', isIbHead: true })).id);
  await tx.awarenessFragment.upsert({
    where: { code: 'signature' },
    create: { code: 'signature', htmlRu: '<p>Подпись RU</p>', htmlTj: '<p>Имзо TJ</p>' },
    update: { htmlRu: '<p>Подпись RU</p>', htmlTj: '<p>Имзо TJ</p>' },
  });
  return { author, other, head };
}

describe('учебные письма: версии и сохранение', () => {
  it('создание — версия 1; без изменений версии нет; правка — новая версия; чужая version — 409; санитизация и журнал', () =>
    inTx(async (tx) => {
      const { author } = await people(tx);
      const created = await letters.createLetter(tx, author, { title: '  Фишинг   в марте ', kind: 'planned', ...both });
      const l = created.letter;
      expect([l.title, l.status, l.versionNo, l.versions.map((v) => v.reason)]).toEqual(['Фишинг в марте', 'draft', 1, ['created']]);
      expect((await lastAudit(tx)).action).toBe('awareness_letter.created');

      const same = await letters.saveLetter(tx, author, l.id, { version: l.version, ...both });
      expect([same.versionCreated, same.letter.version]).toEqual([false, l.version]);

      const edited = await letters.saveLetter(tx, author, l.id, {
        version: l.version, ...both, htmlRu: `<p onclick="x()">Новый <script>alert(1)</script>текст</p><img src="https://evil.test/a.png">${SIGNATURE_BLOCK}`,
      });
      expect([edited.versionCreated, edited.letter.versionNo]).toEqual([true, 2]);
      expect(edited.letter.content.htmlRu).toBe(`<p>Новый текст</p>${SIGNATURE_BLOCK}`);
      expect(edited.removed.length).toBe(1);
      const a = await lastAudit(tx);
      expect([a.action, a.entity, (a.diff as { versionNo: number }).versionNo]).toEqual(['awareness_letter.updated', 'awareness_letter', 2]);

      await expectCode(letters.saveLetter(tx, author, l.id, { version: l.version, ...both, subjectRu: 'другая' }), 'VERSION_CONFLICT');
      await expectCode(letters.saveLetter(tx, author, l.id, { version: edited.letter.version, ...both, htmlRu: '<p><a href="https://portal.test/tasks">x</a></p>' }, { portalUrl: TEST_PORTAL_URL }), 'PORTAL_LINK');
      await expectCode(letters.createLetter(tx, author, { title: 'Срочно', kind: 'urgent' }), 'REASON_REQUIRED');

      // Изображение в пределах лимита сохраняется; версия 1 читается как была.
      const img = await letters.saveLetter(tx, author, l.id, { version: edited.letter.version, ...both, htmlTj: `<p><img src="data:image/png;base64,${PNG}" alt="x"></p>` });
      expect(img.letter.content.htmlTj).toContain('data:image/png;base64,');
      expect((await letters.getVersion(tx, l.id, 1)).content).toEqual(both);

      // Восстановить версию 1 — новая версия 4 (restore), старые не меняются.
      const restored = await letters.restoreVersion(tx, author, l.id, { version: img.letter.version, no: 1 });
      expect([restored.versionNo, restored.versions[0]?.reason, restored.versions[0]?.restoredFrom, restored.content]).toEqual([4, 'restore', 1, both]);
      await expectCode(letters.restoreVersion(tx, author, l.id, { version: restored.version, no: 4 }), 'VERSION_IS_CURRENT');

      const list = await letters.listLetters(tx, { scope: 'active', q: String(l.number), limit: 10 });
      expect(list.items.map((i) => [i.id, i.versionNo, i.langMark])).toEqual([[l.id, 4, null]]);
    }));
});

describe('учебные письма: согласование', () => {
  it('языки и переменные при отправке; отозвать — отправивший или автор; утвердить и вернуть — только начальник ИБ', () =>
    inTx(async (tx) => {
      const { author, other, head } = await people(tx);
      const { letter: l0 } = await letters.createLetter(tx, author, { title: 'Плановое', kind: 'planned', ...both, subjectTj: '' });
      await expectCode(letters.submitLetter(tx, author, l0.id, { version: l0.version }), 'LANG_REQUIRED');
      const { letter: l1 } = await letters.saveLetter(tx, author, l0.id, { version: l0.version, ...both, htmlRu: '<p>Здравствуйте, {{имя отдела}}</p>' });
      await expectCode(letters.submitLetter(tx, author, l1.id, { version: l1.version }), 'UNFILLED_VARIABLES');
      const { letter: l2 } = await letters.saveLetter(tx, author, l1.id, { version: l1.version, ...both });

      const inReview = await letters.submitLetter(tx, other, l2.id, { version: l2.version });
      expect([inReview.status, inReview.events[0]?.action]).toEqual(['review', 'submitted']);
      await expectCode(letters.saveLetter(tx, author, l2.id, { version: inReview.version, ...both, subjectRu: 'x' }), 'LETTER_STATE');
      await expectCode(letters.approveLetter(tx, other, l2.id, { version: inReview.version }), 'NOT_IB_HEAD');
      await expectCode(letters.returnLetter(tx, head, l2.id, { version: inReview.version, comment: '  ' }), 'COMMENT_REQUIRED');

      // Отозвал автор (отправлял коллега) — можно; начальник ИБ не автор и не отправлял — нельзя.
      await expectCode(letters.withdrawLetter(tx, head, l2.id, { version: inReview.version }), 'LETTER_FORBIDDEN');
      const back = await letters.withdrawLetter(tx, author, l2.id, { version: inReview.version });
      expect(back.status).toBe('draft');

      const again = await letters.submitLetter(tx, author, l2.id, { version: back.version });
      expect(again.actions).not.toContain('approve');
      const headView = await letters.getLetter(tx, head.id, l2.id);
      expect(headView.actions).toEqual(expect.arrayContaining(['approve', 'return']));
      const returned = await letters.returnLetter(tx, head, l2.id, { version: again.version, comment: 'Уточните тему' });
      expect([returned.status, returned.events[0]?.comment]).toEqual(['draft', 'Уточните тему']);

      const r2 = await letters.submitLetter(tx, author, l2.id, { version: returned.version });
      const approved = await letters.approveLetter(tx, head, l2.id, { version: r2.version });
      expect([approved.status, approved.approvedVersionNo, approved.latestIsApproved, approved.selfApproved]).toEqual(['approved', approved.versionNo, true, false]);
      expect((await lastAudit(tx)).action).toBe('awareness_letter.approved');

      // Название не входит в письмо — утверждение не снимается. Текст — только с подтверждением.
      const renamed = await letters.saveLetter(tx, author, l2.id, { version: approved.version, ...both, title: 'Плановое: март' });
      expect([renamed.letter.status, renamed.versionCreated]).toEqual(['approved', false]);
      await expectCode(letters.saveLetter(tx, author, l2.id, { version: renamed.letter.version, ...both, subjectRu: 'Новая тема' }), 'APPROVAL_DROP_CONFIRM');
      const dropped = await letters.saveLetter(tx, author, l2.id, { version: renamed.letter.version, ...both, subjectRu: 'Новая тема', confirmDropApproval: true });
      expect([dropped.letter.status, dropped.letter.approvedVersionNo, dropped.letter.events[0]?.action]).toEqual(['draft', null, 'approval_dropped']);
    }));

  it('своё письмо начальник ИБ утверждает с пометкой «без независимого согласования»', () =>
    inTx(async (tx) => {
      const { head } = await people(tx);
      const { letter } = await letters.createLetter(tx, head, { title: 'Своё', kind: 'planned', ...both });
      const s = await letters.submitLetter(tx, head, letter.id, { version: letter.version });
      const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      expect([a.selfApproved, a.events[0]?.selfApproved]).toEqual([true, true]);
    }));
});

describe('учебные письма: отправка и заморозка', () => {
  it('первая отметка — версия sent с подписью текстом и заморозка; дальше правка — 409; повтор, архив, копия — можно', () =>
    inTx(async (tx) => {
      const { author, head } = await people(tx);
      const { letter } = await letters.createLetter(tx, author, { title: 'К отправке', kind: 'planned', ...both });
      const s = await letters.submitLetter(tx, author, letter.id, { version: letter.version });
      const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      await expectCode(letters.sendLetter(tx, author, letter.id, { version: a.version, sentOn: '2999-01-01', audience: 'Все сотрудники' }), 'BAD_DATE');
      await expectCode(letters.sendLetter(tx, author, letter.id, { version: a.version, sentOn: todayIso, audience: ' ' }), 'AUDIENCE_REQUIRED');

      const sent = await letters.sendLetter(tx, author, letter.id, { version: a.version, sentOn: todayIso, audience: 'Все сотрудники' }, { now: () => today });
      expect([sent.status, sent.frozen, sent.sentVersionNo, sent.versionNo, sent.actions]).toEqual(['sent', true, must(a.versionNo) + 1, must(a.versionNo) + 1, ['resend', 'copy', 'archive']]);
      expect(sent.content.htmlRu).toBe('<p>Не открывайте вложения.</p><div><p>Подпись RU</p></div>');
      expect(sent.content.htmlTj).toContain('<p>Имзо TJ</p>');
      expect(sent.events[0]).toMatchObject({ action: 'sent', sentOn: todayIso, audience: 'Все сотрудники', withoutApproval: false });

      await expectCode(letters.saveLetter(tx, author, letter.id, { version: sent.version, ...both, subjectRu: 'x' }), 'LETTER_FROZEN');
      await expectCode(letters.restoreVersion(tx, author, letter.id, { version: sent.version, no: 1 }), 'LETTER_FROZEN');
      await expectCode(letters.submitLetter(tx, author, letter.id, { version: sent.version }), 'LETTER_FROZEN');
      // Триггер БД (вторая линия) — schema.db.test.ts.

      const resent = await letters.sendLetter(tx, author, letter.id, { version: sent.version, sentOn: todayIso, audience: 'Отдел кадров' }, { now: () => today });
      expect([resent.events.filter((e) => e.action === 'sent').length, resent.versions.length, resent.events[0]?.versionNo]).toEqual([2, sent.versions.length, sent.sentVersionNo]);

      const archived = await letters.archiveLetter(tx, author, letter.id, { version: resent.version, archived: true });
      expect([archived.archived, archived.frozen, archived.actions]).toEqual([true, true, ['copy', 'unarchive']]);
      await expectCode(letters.sendLetter(tx, author, letter.id, { version: archived.version, sentOn: todayIso, audience: 'x' }), 'LETTER_ARCHIVED');
      const unarchived = await letters.archiveLetter(tx, author, letter.id, { version: archived.version, archived: false });
      expect(unarchived.archived).toBe(false);

      // Копия отправленного — содержимое до подстановки подписи: блок «Подпись ИБ» живой.
      const copy = await letters.copyLetter(tx, author, letter.id);
      expect([copy.status, copy.frozen, copy.title, copy.versions.map((v) => v.reason), copy.events, copy.task, copy.content]).toEqual(
        ['draft', false, 'К отправке (копия)', ['copy'], [], null, both],
      );
    }));

  it('срочное — без согласования только с причиной; один язык — «только RU»; плановое без утверждения — 409', () =>
    inTx(async (tx) => {
      const { author } = await people(tx);
      const ru = { subjectRu: both.subjectRu, htmlRu: both.htmlRu, subjectTj: '', htmlTj: '' };
      const { letter: u } = await letters.createLetter(tx, author, { title: 'Инцидент', kind: 'urgent', reason: 'Новая схема мошенничества', ...ru });
      expect(u.langMark).toBe('only_ru');
      expect(u.actions).toContain('send_without_approval');
      const input = { version: u.version, sentOn: todayIso, audience: 'Все сотрудники' };
      await expectCode(letters.sendLetter(tx, author, u.id, input, { now: () => today }), 'COMMENT_REQUIRED');
      const sent = await letters.sendLetter(tx, author, u.id, { ...input, comment: 'Отправлено без согласования: атака идёт сейчас' }, { now: () => today });
      expect([sent.status, sent.sentWithoutApproval, sent.langMark, must(sent.events[0]).withoutApproval]).toEqual(['sent', true, 'only_ru', true]);
      expect((await lastAudit(tx)).diff).toMatchObject({ withoutApproval: true, langMark: 'only_ru' });

      const { letter: p } = await letters.createLetter(tx, author, { title: 'План', kind: 'planned', ...both });
      await expectCode(letters.sendLetter(tx, author, p.id, { version: p.version, sentOn: todayIso, audience: 'x', comment: 'причина' }, { now: () => today }), 'NOT_APPROVED');
      // Тип «срочное» без повода не сохраняется.
      await expectCode(letters.saveLetter(tx, author, p.id, { version: p.version, ...both, kind: 'urgent' }), 'REASON_REQUIRED');
    }));
});

describe('учебные письма по HTTP', () => {
  it('ib.work — да; без него и служебной учётной записи — 403; размер больше лимита — 413', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Letters-Test-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash: hash });
      const svc = await makeUser(tx, [SERVICE_ROLE_CODE], { passwordHash: hash });
      await tx.appSetting.upsert({
        where: { key: 'awareness.letters' },
        create: { key: 'awareness.letters', value: { maxImageKb: 16, maxLetterKb: 64, warnLetterKb: 32 } },
        update: { value: { maxImageKb: 16, maxLetterKb: 64, warnLetterKb: 32 } },
      });
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
      });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((x) => x.name === 'ib_session')?.value}`;
      };
      const S = await login(staff.login);
      const created = await app.inject({ method: 'POST', url: '/api/v1/awareness/letters', headers: { cookie: S }, payload: { title: 'По HTTP', kind: 'planned', ...both } });
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { letter: { id: string; version: number } }).letter.id;
      expect((await app.inject({ url: '/api/v1/awareness/letters', headers: { cookie: S } })).json().total).toBeGreaterThan(0);

      const big = `<p>${'а'.repeat(40_000)}</p>`;
      const tooBig = await app.inject({ method: 'PUT', url: `/api/v1/awareness/letters/${id}`, headers: { cookie: S }, payload: { version: 1, ...both, htmlRu: big } });
      expect([tooBig.statusCode, tooBig.json().error.code]).toEqual([413, 'LETTER_TOO_LARGE']);

      for (const who of [reader.login, svc.login]) {
        const C = await login(who);
        const res = await app.inject({ url: `/api/v1/awareness/letters/${id}`, headers: { cookie: C } });
        expect(res.statusCode, who).toBe(403);
        if (who === svc.login) expect(res.json().error.code).toBe('SERVICE_ACCOUNT');
      }
    }));
});
