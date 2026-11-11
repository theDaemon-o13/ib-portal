// Самооценка (этап Д): права, жизненный цикл, расчёт по снимку методики, журнал без текста комментариев и только
// для держателей права. HTTP — тем же приложением, что в бою; БД — транзакция с откатом.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { sectionsOf, type Methodology } from '../../lib/assessment-score.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { actorFor, expectCode, inTx, makeUser, must, roleId, type Tx } from '../../test/db.js';
import { seedAssessmentMethodology } from '../../../prisma/seed/assessment.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { listAudit, auditFacets } from '../audit/service.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as roles from '../roles/service.js';
import * as svc from './service.js';

const PASSWORD = 'Assess-Test-Pass-2026';
/** Ответы эталона 07.07.2025 по порядку разделов методики: 34 балла. */
const ETALON = [2, 1, 2, 1, 2, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 2, 2, 2, 1];

async function fixture(tx: Tx) {
  const owner = await makeUser(tx, ['assessment'], { fullName: 'Владелец самооценки' });
  const admin = await makeUser(tx, ['super_admin'], { fullName: 'Администратор' });
  // Черновик в тестовой базе может остаться от прогонов вне транзакции — в архив на время теста.
  await tx.assessment.updateMany({ where: { status: 'draft' }, data: { status: 'archived', archivedAt: new Date() } });
  const as = async () => actorFor(tx, owner.id);
  const create = async (title = 'Экспресс-оценка 2026', extra: { copyFromId?: string } = {}) =>
    svc.createAssessment(tx, await as(), { title, assessedOn: '2026-10-30', ...extra });
  const codes = async (id: string) => sectionsOf((await svc.getAssessment(tx, id)).methodology as Methodology).map((s) => s.code);
  const answer = async (id: string, code: string, body: { level?: number | null; targetLevel?: number | null; comment?: string }) => {
    const a = must((await svc.getAssessment(tx, id)).answers.find((x) => x.code === code));
    return svc.saveAnswer(tx, await as(), id, code, { version: a.version, ...body });
  };
  const fill = async (id: string, levels = ETALON) => {
    const list = await codes(id);
    for (const [i, code] of list.entries()) await answer(id, code, { level: levels[i] ?? 1 });
  };
  const version = async (id: string) => (await tx.assessment.findUniqueOrThrow({ where: { id } })).version;
  /** Сделать активной методику по коду (v1 — чтобы завести оценку на прежней версии); индекс допускает одну активную. */
  const activate = async (code: string) => {
    await tx.assessmentMethodology.updateMany({ where: { isActive: true }, data: { isActive: false } });
    await tx.assessmentMethodology.updateMany({ where: { code }, data: { isActive: true } });
  };
  return { owner, admin, as, create, codes, answer, fill, version, activate };
}

describe('самооценка: права (ADR-0026)', () => {
  it('без права — 403 на всех маршрутах, в том числе у супер-администратора; с правом без ib.work — работает', () =>
    inTx(async (tx) => {
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL,
      });
      const hash = await argon2Hasher.hash(PASSWORD);
      const owner = await makeUser(tx, ['assessment'], { passwordHash: hash });
      const admin = await makeUser(tx, ['super_admin', 'ib_head'], { passwordHash: hash });
      await tx.assessment.updateMany({ where: { status: 'draft' }, data: { status: 'archived', archivedAt: new Date() } });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        expect(res.statusCode).toBe(200);
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const O = await login(owner.login);
      const A = await login(admin.login);
      const created = await app.inject({ method: 'POST', url: '/api/v1/assessments', headers: { cookie: O, origin: TEST_PORTAL_URL }, payload: { title: 'Оценка', assessedOn: '2026-10-30' } });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const urls: [string, string][] = [
        ['GET', '/api/v1/assessments'], ['GET', '/api/v1/assessments/methodology'], ['GET', `/api/v1/assessments/${id}`],
        ['GET', `/api/v1/assessments/${id}/log`], ['GET', `/api/v1/assessments/${id}/answers/1.1/history`],
        ['GET', `/api/v1/assessments/compare?a=${id}&b=${id}`], ['GET', '/api/v1/assessments/assignees'],
        ['POST', `/api/v1/assessments/${id}/answers/1.1/tasks`], ['GET', '/api/v1/assessments/export.xlsx'],
        ['POST', `/api/v1/assessments/${id}/import?dryRun=true`],
        ['POST', '/api/v1/assessments'], ['PATCH', `/api/v1/assessments/${id}`], ['PUT', `/api/v1/assessments/${id}/answers/1.1`],
        ['POST', `/api/v1/assessments/${id}/finalize`], ['POST', `/api/v1/assessments/${id}/reopen`], ['POST', `/api/v1/assessments/${id}/archive`],
      ];
      // Тело — корректное для любого из маршрутов (лишние поля отбрасываются): проверяется право, а не схема.
      const validBody = { version: 1, title: 'x', assessedOn: '2026-10-30', categoryId: id, assigneeId: owner.id };
      for (const [method, url] of urls) {
        const res = await app.inject({ method: method as 'GET', url, headers: { cookie: A, origin: TEST_PORTAL_URL }, payload: method === 'GET' ? undefined : validBody });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
      const mine = await app.inject({ url: `/api/v1/assessments/${id}`, headers: { cookie: O } });
      expect(mine.statusCode).toBe(200);
      expect(mine.json()).toMatchObject({ status: 'draft', total: 0, max: 96, answered: 0, sections: 28, preliminary: true });
      // Без ib.work разделов ИБ нет.
      expect((await app.inject({ url: '/api/v1/tasks', headers: { cookie: O } })).statusCode).toBe(403);
    }));

  it('право — только у системной роли «Самооценка»: другим ролям не выдаётся, с неё не снимается', () =>
    inTx(async (tx) => {
      const admin = await makeUser(tx, ['super_admin']);
      const actor = await actorFor(tx, admin.id);
      for (const code of ['super_admin', 'ib_head', 'ib_staff']) {
        await expectCode(roles.setRolePermission(tx, actor, await roleId(tx, code), 'assessment.manage', true), 'ASSESSMENT_EXCLUSIVE');
      }
      const custom = await roles.createRole(tx, actor, { name: 'Аудитор самооценки', description: '' });
      await expectCode(roles.setRolePermission(tx, actor, custom.id, 'assessment.manage', true), 'ASSESSMENT_EXCLUSIVE');
      const own = await roleId(tx, 'assessment');
      await expectCode(roles.setRolePermission(tx, actor, own, 'assessment.manage', false), 'LOCKED_PERMISSION');
      const list = await roles.listRoles(tx);
      expect(list.find((r) => r.code === 'assessment')).toMatchObject({ isSystem: true, permissions: ['assessment.manage'], lockedPermissions: ['assessment.manage'], userCount: expect.any(Number) });
      expect(list.find((r) => r.code === 'ib_head')?.forbiddenPermissions).toContain('assessment.manage');
      expect(list.find((r) => r.code === 'assessment')?.forbiddenPermissions).not.toContain('assessment.manage');
    }));
});

describe('самооценка: жизненный цикл и расчёт', () => {
  it('черновик → ответы → итог «предварительно» → фиксация при 24/24 → итог заморожен → в черновик → архив', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await expectCode(x.create('Вторая'), 'DRAFT_EXISTS');
      // Активна v2 (1.13.10): 28 разделов, итог по-прежнему из 96, домен 11 вне итога.
      const codes = await x.codes(id);
      expect(codes).toHaveLength(28);
      for (const [i, code] of codes.slice(0, 23).entries()) await x.answer(id, code, { level: ETALON[i] ?? null });
      const partial = await svc.getAssessment(tx, id);
      expect(partial).toMatchObject({ answered: 23, sections: 28, preliminary: true });
      await expectCode(svc.finalizeAssessment(tx, await x.as(), id, { version: await x.version(id) }), 'INCOMPLETE');

      const saved = await x.answer(id, must(codes[23]), { level: 1, targetLevel: 3, comment: 'Пентест не проводился' });
      // 24 из 28: итог 34 из 96 уже полный по доменам в итоге, но оценка «предварительно» и не фиксируется.
      expect(saved.score).toMatchObject({ total: 34, max: 96, answered: 24, preliminary: true, level: { name: 'Цифровая гигиена' } });
      expect(saved.score.domains.map((d) => d.sum)).toEqual([5, 4, 5, 2, 3, 5, 1, 2, 6, 1, 0]);
      await expectCode(svc.finalizeAssessment(tx, await x.as(), id, { version: await x.version(id) }), 'INCOMPLETE');
      for (const [i, code] of ['11.1', '11.2', '11.3', '11.4'].entries()) await x.answer(id, code, { level: [4, 3, 2, 1][i] ?? 1 });
      const full = await svc.getAssessment(tx, id);
      expect(full.score).toMatchObject({ total: 34, max: 96, answered: 28, preliminary: false, level: { name: 'Цифровая гигиена' } });
      expect(full.score.domains[10]).toMatchObject({ no: 11, inTotal: false, sum: 10, max: 16, answered: 4, avg: 2.5 });
      await expectCode(x.answer(id, '1.1', { level: 5 }), 'BAD_LEVEL');
      // Устаревшая версия ответа — 409.
      await expectCode(svc.saveAnswer(tx, await x.as(), id, '10.1', { version: 1, level: 2 }), 'VERSION_CONFLICT');

      await svc.finalizeAssessment(tx, await x.as(), id, { version: await x.version(id) });
      let d = await svc.getAssessment(tx, id);
      expect(d).toMatchObject({ status: 'final', statusName: 'Зафиксирована', total: 34 });
      // Ответы вне черновика — 409, и триггер в БД.
      await expectCode(x.answer(id, '1.1', { level: 4 }), 'NOT_DRAFT');
      await tx.$executeRawUnsafe('SAVEPOINT s1');
      await expect(tx.$executeRawUnsafe(`UPDATE assessment_answers SET level = 4 WHERE assessment_id = '${id}' AND section_code = '1.1'`)).rejects.toThrow(/только в черновике/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s1');
      // Итог заморожен: правка методики и снимка его не меняет.
      await tx.assessment.update({ where: { id }, data: { methodologySnapshot: {} } });
      expect((await svc.listAssessments(tx)).items.find((a) => a.id === id)).toMatchObject({ total: 34, level: { name: 'Цифровая гигиена' } });
      await tx.assessment.update({ where: { id }, data: { methodologySnapshot: (await svc.activeMethodology(tx)).content as object } });

      await svc.reopenAssessment(tx, await x.as(), id, { version: await x.version(id), comment: 'Уточнить 5.3' });
      d = await svc.getAssessment(tx, id);
      expect(d).toMatchObject({ status: 'draft', reopenComment: 'Уточнить 5.3', total: 34 });
      await x.answer(id, '1.1', { level: 4 });
      expect((await svc.getAssessment(tx, id)).total).toBe(36);
      await svc.archiveAssessment(tx, await x.as(), id, { version: await x.version(id) });
      expect((await svc.getAssessment(tx, id)).status).toBe('archived');
      await expectCode(x.answer(id, '1.1', { level: 2 }), 'NOT_DRAFT');
      // Удаления нет: и у роли приложения нет DELETE.
      await tx.$executeRawUnsafe('SAVEPOINT s2');
      await expect(tx.$executeRawUnsafe(`DELETE FROM assessments WHERE id = '${id}'`)).rejects.toThrow(/permission denied/);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s2');
    }));

  it('новая оценка — копия зафиксированной: баллы и цели переносятся, комментарии — нет; динамика с предыдущей', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const first = await x.create('Экспресс-оценка 2025');
      await x.fill(first);
      await x.answer(first, '1.1', { targetLevel: 4, comment: 'Стратегия в работе' });
      await svc.finalizeAssessment(tx, await x.as(), first, { version: await x.version(first) });
      const second = await x.create('Экспресс-оценка 2026', { copyFromId: first });
      let d = await svc.getAssessment(tx, second);
      expect(d.answers.find((a) => a.code === '1.1')).toMatchObject({ level: 2, targetLevel: 4, comment: '' });
      expect(d).toMatchObject({ total: 34, preliminary: false, previous: { id: first, total: 34 } });
      await x.answer(second, '1.1', { level: 3 });
      d = await svc.getAssessment(tx, second);
      expect(d.previous?.delta.total).toBe(1);
      expect(d.previous?.delta.sections.find((s) => s.code === '1.1')).toMatchObject({ from: 2, to: 3, delta: 1 });
      const cmp = await svc.compareAssessments(tx, first, second);
      expect(cmp.domains[0]).toMatchObject({ a: 5, b: 6 });
      // Копировать черновик нельзя.
      await svc.archiveAssessment(tx, await x.as(), second, { version: await x.version(second) });
      const draft = await x.create('Черновик');
      await svc.archiveAssessment(tx, await x.as(), draft, { version: await x.version(draft) });
      await expectCode(x.create('Копия черновика', { copyFromId: draft }), 'NOT_FINAL');
    }));

  it('снимок методики: оценка работает со своим снимком, а не с активной методикой', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const m = await svc.activeMethodology(tx);
      const changed = { ...(m.content as object), name: 'Изменённая методика' };
      await tx.assessmentMethodology.update({ where: { id: m.id }, data: { content: changed } });
      expect((await svc.getAssessment(tx, id)).methodology.name).toBe('Экспресс-оценка уровня кибербезопасности организации');
    }));
});

describe('самооценка: журнал (ADR-0026)', () => {
  it('в журнал — баллы и цели как есть, без текста комментария; история раздела — без history.view', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await x.answer(id, '5.3', { level: 2, targetLevel: 4, comment: 'Секретная подробность' });
      const rows = await tx.auditLog.findMany({ where: { entity: 'assessment', entityId: id, action: 'assessment.answer_updated' } });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]?.diff)).not.toContain('Секретная подробность');
      expect((rows[0]?.diff as { summary: string }).summary).toMatch(/5\.3 .*: балл — → 2, цель — → 4, комментарий изменён$/);
      const history = await svc.assessmentLog(tx, id, '5.3');
      expect(history.items.map((h) => h.action)).toEqual(['assessment.answer_updated']);
      expect((await svc.assessmentLog(tx, id, '1.1')).items).toEqual([]);
      expect((await svc.assessmentLog(tx, id)).items.map((h) => h.action)).toEqual(['assessment.answer_updated', 'assessment.created']);
    }));

  it('в разделе «Журнал» записи самооценки видят только держатели права: список, фильтры, выгрузка', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Скрытая оценка');
      const hidden = await listAudit(tx, { limit: 200, hideAssessment: true, entity: 'assessment' });
      expect(hidden.items).toEqual([]);
      const all = await listAudit(tx, { limit: 200, hideAssessment: true, q: 'Скрытая оценка' });
      expect(all.items).toEqual([]);
      const shown = await listAudit(tx, { limit: 200, hideAssessment: false, q: 'Скрытая оценка' });
      expect(shown.items.map((i) => i.entityId)).toContain(id);
      expect((await auditFacets(tx, { hideAssessment: true })).actions.some((a) => a.code.startsWith('assessment.'))).toBe(false);
      expect((await auditFacets(tx, { hideAssessment: false })).actions.some((a) => a.code === 'assessment.created')).toBe(true);
    }));

  it('по HTTP: начальник ИБ с «Журналом действий» не видит записей самооценки', () =>
    inTx(async (tx) => {
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL,
      });
      const hash = await argon2Hasher.hash(PASSWORD);
      const head = await makeUser(tx, ['ib_staff', 'ib_head'], { passwordHash: hash });
      const x = await fixture(tx);
      await tx.user.update({ where: { id: x.owner.id }, data: { passwordHash: hash } });
      await x.create('Оценка для журнала');
      const login = async (l: string) => `ib_session=${(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } })).cookies.find((c) => c.name === 'ib_session')?.value}`;
      const H = await login(head.login);
      const res = await app.inject({ url: `/api/v1/audit?limit=100&q=${encodeURIComponent('Оценка для журнала')}`, headers: { cookie: H } });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([]);
    }));
});

describe('самооценка: методика v2 — домен «Контроль ИИ» (1.13.10, ADR-0050)', () => {
  it('seed: активна cyber-express-v2; v1 выключена и остаётся; повторный прогон ничего не меняет; ручной возврат v1 отменяется seed', () =>
    inTx(async (tx) => {
      const rows = await tx.assessmentMethodology.findMany({ orderBy: { version: 'asc' } });
      expect(rows.map((r) => [r.code, r.version, r.isActive])).toEqual([['cyber-express-v1', 1, false], ['cyber-express-v2', 2, true]]);
      const v2 = (rows[1]?.content as unknown as Methodology);
      expect(v2.domains).toHaveLength(11);
      expect(v2.domains[10]).toMatchObject({ no: 11, name: 'Контроль ИИ', inTotal: false });
      const before = await tx.auditLog.count({ where: { action: 'assessment.methodology_activated' } });
      await seedAssessmentMethodology(tx);
      expect(await tx.auditLog.count({ where: { action: 'assessment.methodology_activated' } })).toBe(before);
      expect(await tx.assessmentMethodology.count()).toBe(2);
      // Откат на 1.13.7 с ручным SQL — и повторное обновление: seed снова включает v2.
      await tx.assessmentMethodology.updateMany({ where: { version: 2 }, data: { isActive: false } });
      await tx.assessmentMethodology.updateMany({ where: { version: 1 }, data: { isActive: true } });
      await seedAssessmentMethodology(tx);
      const after = await tx.assessmentMethodology.findMany({ orderBy: { version: 'asc' } });
      expect(after.map((r) => r.isActive)).toEqual([false, true]);
      expect(await tx.auditLog.count({ where: { action: 'assessment.methodology_activated' } })).toBe(before + 1);
    }));

  it('оценка на v1 не меняется; «Копия последней» на v2 переносит ответы и цели по кодам, домен 11 пустой; сравнение v1 и v2', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await x.activate('cyber-express-v1');
      const first = await x.create('Экспресс-оценка 2025');
      expect(await x.codes(first)).toHaveLength(24);
      await x.fill(first);
      await x.answer(first, '1.1', { targetLevel: 4 });
      await svc.finalizeAssessment(tx, await x.as(), first, { version: await x.version(first) });
      await x.activate('cyber-express-v2');
      // Оценка v1 читается со своим снимком и замороженным итогом.
      let d1 = await svc.getAssessment(tx, first);
      expect(d1).toMatchObject({ total: 34, max: 96, sections: 24, methodologyUpgrade: null });
      expect(d1.methodology.domains).toHaveLength(10);
      expect(d1.score.domains.every((d) => d.inTotal)).toBe(true);

      const second = await x.create('Экспресс-оценка 2026', { copyFromId: first });
      const d2 = await svc.getAssessment(tx, second);
      expect(d2).toMatchObject({ total: 34, max: 96, answered: 24, sections: 28, preliminary: true, methodologyUpgrade: null, previous: { id: first, total: 34 } });
      expect(d2.answers.find((a) => a.code === '1.1')).toMatchObject({ level: 2, targetLevel: 4 });
      expect(d2.answers.filter((a) => a.code.startsWith('11.')).map((a) => [a.code, a.level, a.targetLevel])).toEqual([['11.1', null, null], ['11.2', null, null], ['11.3', null, null], ['11.4', null, null]]);
      // Динамика: домены 1–10 как обычно, у домена 11 разницы нет.
      expect(d2.previous?.delta.domains[10]).toEqual({ no: 11, sum: null, avg: null });
      expect(d2.previous?.domains.find((d) => d.no === 11)).toBeUndefined();
      await expectCode(svc.finalizeAssessment(tx, await x.as(), second, { version: await x.version(second) }), 'INCOMPLETE');

      const cmp = await svc.compareAssessments(tx, first, second);
      expect(cmp.domains).toHaveLength(11);
      expect(cmp.domains[0]).toMatchObject({ no: 1, a: 5, b: 5 });
      expect(cmp.domains[10]).toMatchObject({ no: 11, a: null, b: 0 });
      expect(cmp.sections.filter((s) => !s.inA).map((s) => s.code)).toEqual(['11.1', '11.2', '11.3', '11.4']);
      expect(cmp.sections.find((s) => s.code === '1.1')).toMatchObject({ inA: true, a: 2, b: 2 });
      // Оценка v1 в базе не тронута: 24 строки ответов, снимок v1.
      expect(await tx.assessmentAnswer.count({ where: { assessmentId: first } })).toBe(24);
      d1 = await svc.getAssessment(tx, first);
      expect((d1.methodology as Methodology).version).toBe(1);
    }));

  it('«Обновить методику до v2»: только черновик, ответы 1–10 сохранены, домен 11 добавлен пустым, журнал; та же методика — 409', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await x.activate('cyber-express-v1');
      const id = await x.create('Черновик на v1');
      await x.fill(id);
      await x.answer(id, '5.3', { targetLevel: 4, comment: 'Скан раз в квартал' });
      // Пока активна v1 — обновлять некуда.
      expect((await svc.getAssessment(tx, id)).methodologyUpgrade).toBeNull();
      await expectCode(svc.upgradeMethodology(tx, await x.as(), id, { version: await x.version(id) }), 'SAME_METHODOLOGY');
      await x.activate('cyber-express-v2');
      let d = await svc.getAssessment(tx, id);
      expect(d).toMatchObject({ total: 34, sections: 24, preliminary: false, methodologyUpgrade: { code: 'cyber-express-v2', version: 2 } });
      // Устаревшая версия — 409.
      await expectCode(svc.upgradeMethodology(tx, await x.as(), id, { version: 1 }), 'VERSION_CONFLICT');
      const v = await x.version(id);
      await svc.upgradeMethodology(tx, await x.as(), id, { version: v });
      d = await svc.getAssessment(tx, id);
      expect(d).toMatchObject({ total: 34, max: 96, answered: 24, sections: 28, preliminary: true, version: v + 1, methodologyUpgrade: null, level: { name: 'Цифровая гигиена' } });
      expect(d.methodology.domains).toHaveLength(11);
      expect(d.answers.find((a) => a.code === '5.3')).toMatchObject({ level: ETALON[13], targetLevel: 4, comment: 'Скан раз в квартал' });
      expect(d.answers.filter((a) => a.code.startsWith('11.')).every((a) => a.level === null && a.targetLevel === null)).toBe(true);
      expect(await tx.assessmentAnswer.count({ where: { assessmentId: id } })).toBe(28);
      const log = await tx.auditLog.findMany({ where: { entity: 'assessment', entityId: id, action: 'assessment.methodology_upgraded' } });
      expect(log).toHaveLength(1);
      expect((log[0]?.diff as { summary: string }).summary).toMatch(/методика обновлена — cyber-express-v1 v1 → cyber-express-v2 v2, новых разделов 4 \(11\.1, 11\.2, 11\.3, 11\.4\)$/);
      expect((await svc.assessmentLog(tx, id)).items[0]?.action).toBe('assessment.methodology_upgraded');
      // Повторно — та же методика; вне черновика — 409 и кнопки нет.
      await expectCode(svc.upgradeMethodology(tx, await x.as(), id, { version: await x.version(id) }), 'SAME_METHODOLOGY');
      await svc.archiveAssessment(tx, await x.as(), id, { version: await x.version(id) });
      await x.activate('cyber-express-v1');
      expect((await svc.getAssessment(tx, id)).methodologyUpgrade).toBeNull();
      await expectCode(svc.upgradeMethodology(tx, await x.as(), id, { version: await x.version(id) }), 'NOT_DRAFT');
      await x.activate('cyber-express-v2');
    }));
});
