// Удаление учебного письма (1.13.3, ADR-0048) с настоящей БД: только архивное и ни разу не отмеченное отправленным,
// мягко (deleted_at), с записью в журнал; удалённое не видно в списках и карточке, версии остаются; задача и запуск
// расписания остаются, в происхождении задачи — «письмо удалено»; право awareness.delete. Письма и люди вымышленные.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as letters from './letters.service.js';
import { taskOrigin, taskOriginInclude } from './origin.js';
import * as rules from './rules.service.js';
import { runAwarenessSchedule } from './schedule.service.js';
import * as templates from './templates.service.js';

const both = { subjectRu: 'Осторожно: звонки', subjectTj: 'Эҳтиёт: зангҳо', htmlRu: '<p>Не называйте код.</p>', htmlTj: '<p>Рамзро нагӯед.</p>' };
const todayIso = new Date().toISOString().slice(0, 10);

async function people(tx: Tx) {
  const author = await actorFor(tx, (await makeUser(tx, ['ib_staff'], { fullName: 'Автор Удаления' })).id);
  const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник Удаления', isIbHead: true })).id);
  return { author, head };
}

describe('удаление учебного письма', () => {
  it('архивное неотправленное — мягко: нет в списках и карточке, версии в базе, журнал — кто, название, версия', () =>
    inTx(async (tx) => {
      const { author, head } = await people(tx);
      const { letter } = await letters.createLetter(tx, author, { title: 'Черновик на удаление', kind: 'planned', ...both });
      const saved = await letters.saveLetter(tx, author, letter.id, { version: letter.version, ...both, subjectRu: 'Осторожно: звонки (2)' });
      const archived = await letters.archiveLetter(tx, author, letter.id, { version: saved.letter.version, archived: true });
      expect(archived.deletable).toBe(true);

      const res = await letters.deleteLetter(tx, head, letter.id, { version: archived.version });
      expect(res).toEqual({ id: letter.id, number: letter.number, deleted: true });

      const row = must(await tx.awarenessLetter.findUnique({ where: { id: letter.id } }));
      expect(row.deletedAt).not.toBeNull();
      expect(await tx.awarenessLetterVersion.count({ where: { letterId: letter.id } })).toBe(2);
      const a = await lastAudit(tx);
      expect([a.action, a.entity, a.entityId, a.userId]).toEqual(['awareness_letter.deleted', 'awareness_letter', letter.id, head.id]);
      expect(a.diff).toMatchObject({ title: 'Черновик на удаление', version: archived.version });

      for (const scope of ['active', 'archived', 'all'] as const) {
        const list = await letters.listLetters(tx, { scope, limit: 200 });
        expect(list.items.map((i) => i.id), scope).not.toContain(letter.id);
      }
      expect((await letters.listLetters(tx, { scope: 'all', q: 'Черновик на удаление', limit: 50 })).total).toBe(0);
      expect((await letters.listLetters(tx, { scope: 'all', q: String(letter.number), limit: 50 })).items.map((i) => i.id)).not.toContain(letter.id);
      await expectCode(letters.getLetter(tx, author.id, letter.id), 'NOT_FOUND');
      await expectCode(letters.deleteLetter(tx, head, letter.id, { version: archived.version + 1 }), 'NOT_FOUND');
      await expectCode(letters.archiveLetter(tx, author, letter.id, { version: archived.version + 1, archived: false }), 'NOT_FOUND');
    }));

  it('отправленное — 409 LETTER_SENT (и в архиве), триггер не даёт пометить его удалённым; не в архиве — 409 LETTER_NOT_ARCHIVED', () =>
    inTx(async (tx) => {
      const { author, head } = await people(tx);
      const { letter } = await letters.createLetter(tx, author, { title: 'Отправленное', kind: 'planned', ...both });
      const s = await letters.submitLetter(tx, author, letter.id, { version: letter.version });
      const ap = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      const sent = await letters.sendLetter(tx, author, letter.id, { version: ap.version, sentOn: todayIso, audience: 'Все сотрудники' });
      await expectCode(letters.deleteLetter(tx, head, letter.id, { version: sent.version }), 'LETTER_SENT');
      const arch = await letters.archiveLetter(tx, author, letter.id, { version: sent.version, archived: true });
      expect(arch.deletable).toBe(false);
      await expectCode(letters.deleteLetter(tx, head, letter.id, { version: arch.version }), 'LETTER_SENT');
      // Вторая линия — триггер awareness_letters_guard: у замороженного письма deleted_at не меняется.
      await tx.$executeRawUnsafe('SAVEPOINT guard');
      await expect(tx.$executeRaw`UPDATE awareness_letters SET deleted_at = now() WHERE id = ${letter.id}::uuid`).rejects.toThrow(/письмо отправлено/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT guard');

      const { letter: draft } = await letters.createLetter(tx, author, { title: 'Не в архиве', kind: 'planned', ...both });
      expect((await letters.getLetter(tx, author.id, draft.id)).deletable).toBe(false);
      await expectCode(letters.deleteLetter(tx, head, draft.id, { version: draft.version }), 'LETTER_NOT_ARCHIVED');
      expect((await tx.awarenessLetter.findUniqueOrThrow({ where: { id: draft.id } })).deletedAt).toBeNull();
    }));

  it('письмо задачи рассылки по расписанию: удаление разрешено, задача и запуск остаются, «письмо удалено»; прогон расписания не падает', () =>
    inTx(async (tx) => {
      const { author, head } = await people(tx);
      const role = await tx.role.create({ data: { name: `Рассылки удаления ${Math.random().toString(36).slice(2, 8)}`, permissions: { create: [{ permissionCode: 'ib.work' }] } } });
      const holder = await makeUser(tx, ['ib_staff']);
      await tx.userRole.create({ data: { userId: holder.id, roleId: role.id } });
      const { template } = await templates.createTemplate(tx, author, { title: 'Шаблон удаления', ...both });
      const rule = await rules.createRule(tx, author, {
        title: 'Ежемесячная удаления', cadence: { kind: 'monthly', day: 5 }, startsOn: '2042-01-01', roleId: role.id, templateId: template.id,
      }, new Date('2042-01-01T06:00:00Z'));
      expect((await runAwarenessSchedule(tx, { now: new Date('2042-01-01T06:00:00Z') })).created).toBe(1);
      const run = must(await tx.awarenessScheduleRun.findFirst({ where: { ruleId: rule.id } }));
      const letterId = must(run.letterId);

      const l = await letters.getLetter(tx, author.id, letterId);
      const arch = await letters.archiveLetter(tx, author, letterId, { version: l.version, archived: true });
      await letters.deleteLetter(tx, head, letterId, { version: arch.version });

      const task = must(await tx.task.findUnique({ where: { id: run.taskId }, include: taskOriginInclude }));
      expect([task.archivedAt, task.deletedAt]).toEqual([null, null]);
      const origin = must(taskOrigin(task, '2042-01-01'));
      expect(origin).toMatchObject({ kind: 'schedule', letter: { id: letterId, deleted: true }, letterSent: false });
      expect(origin.kind === 'schedule' && origin.stages.every((s) => !s.done)).toBe(true);
      expect(await tx.awarenessScheduleRun.count({ where: { ruleId: rule.id } })).toBe(1);

      // Следующие прогоны — без ошибок и без повторной задачи на ту же дату.
      expect((await runAwarenessSchedule(tx, { now: new Date('2042-01-01T07:00:00Z') })).created).toBe(0);
      expect((await runAwarenessSchedule(tx, { now: new Date('2042-01-27T06:00:00Z') })).ran).toBe(true);
    }));

  it('по HTTP: нужно право awareness.delete — сотрудник ИБ 403, начальник ИБ 200; отправленное — 409 LETTER_SENT', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Delete-Letters-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const head = await makeUser(tx, ['ib_staff', 'ib_head'], { passwordHash: hash });
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
      });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((x) => x.name === 'ib_session')?.value}`;
      };
      const S = await login(staff.login);
      const H = await login(head.login);
      const post = (cookie: string, url: string, payload: object) => app.inject({ method: 'POST', url, headers: { cookie, origin: TEST_PORTAL_URL }, payload });

      const created = (await post(S, '/api/v1/awareness/letters', { title: 'HTTP удаление', kind: 'planned', ...both })).json() as { letter: { id: string; version: number } };
      const id = created.letter.id;
      const arch = (await post(S, `/api/v1/awareness/letters/${id}/archive`, { version: created.letter.version })).json() as { version: number };
      const denied = await post(S, `/api/v1/awareness/letters/${id}/delete`, { version: arch.version });
      expect(denied.statusCode).toBe(403);
      const ok = await post(H, `/api/v1/awareness/letters/${id}/delete`, { version: arch.version });
      expect([ok.statusCode, ok.json().deleted]).toEqual([200, true]);
      expect((await app.inject({ url: `/api/v1/awareness/letters/${id}`, headers: { cookie: S } })).statusCode).toBe(404);
      const list = (await app.inject({ url: '/api/v1/awareness/letters?scope=all&limit=200', headers: { cookie: S } })).json() as { items: { id: string }[] };
      expect(list.items.map((i) => i.id)).not.toContain(id);

      // Отправленное (срочное без согласования) — 409 LETTER_SENT и через API.
      const u = (await post(S, '/api/v1/awareness/letters', { title: 'HTTP отправленное', kind: 'urgent', reason: 'Новая схема', ...both })).json() as { letter: { id: string; version: number } };
      const sent = (await post(S, `/api/v1/awareness/letters/${u.letter.id}/send`, {
        version: u.letter.version, sentOn: todayIso, audience: 'Все сотрудники', comment: 'Отправлено без согласования: атака идёт сейчас',
      })).json() as { version: number };
      const a2 = (await post(S, `/api/v1/awareness/letters/${u.letter.id}/archive`, { version: sent.version })).json() as { version: number };
      const refused = await post(H, `/api/v1/awareness/letters/${u.letter.id}/delete`, { version: a2.version });
      expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'LETTER_SENT']);
    }));
});
