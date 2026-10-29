// Процесс задач по HTTP (ADR-0022): права проверяет backend по сессии — без права 403, кнопки в ответе — по пользователю.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { inTx, makeUser, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { statusIdOf } from './flow.js';

const PASSWORD = 'Tasks-Test-Pass-2026';

async function appWith(tx: Tx) {
  return buildApp({
    db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
    sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
  });
}

describe('процесс задач по HTTP', () => {
  it('PATCH statusId без tasks.status.override — 403; назначить другого без tasks.assign — 403; кнопки — по пользователю', () =>
    inTx(async (tx) => {
      const hash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const other = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const head = await makeUser(tx, ['ib_staff', 'ib_head'], { passwordHash: hash });
      const app = await appWith(tx);
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((x) => x.name === 'ib_session')?.value}`;
      };
      const S = await login(staff.login);
      const H = await login(head.login);
      const category = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', deletedAt: null, archivedAt: null } });
      const post = (cookie: string, url: string, payload: object) => app.inject({ method: 'POST', url, headers: { cookie }, payload });

      expect((await post(S, '/api/v1/tasks', { title: 'Другому', categoryId: category.id, assigneeId: other.id })).statusCode).toBe(403);
      const created = await post(S, '/api/v1/tasks', { title: 'Себе', categoryId: category.id, assigneeId: staff.id });
      expect(created.statusCode).toBe(201);
      const t = created.json() as { id: string; version: number; actions: string[]; status: { systemKey: string } };
      expect([t.status.systemKey, t.actions]).toEqual(['assigned', ['start']]);

      const work = await statusIdOf(tx, 'work');
      const patch = (cookie: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/v1/tasks/${t.id}`, headers: { cookie }, payload });
      const denied = await patch(S, { version: t.version, statusId: work });
      expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'NO_OVERRIDE']);
      expect((await patch(H, { version: t.version, statusId: work })).statusCode).toBe(200);

      // Кнопка процесса: исполнитель отправляет на проверку с комментарием; начальнику (старший — нет, автор — нет) кнопок нет,
      // у исполнителя нет руководителя — значит, принимает любой с tasks.review.
      const submitted = await post(S, `/api/v1/tasks/${t.id}/actions/submit`, { version: t.version + 1, comment: 'Готово' });
      expect(submitted.statusCode).toBe(200);
      const view = await app.inject({ url: `/api/v1/tasks/${t.id}`, headers: { cookie: H } });
      expect(view.json().actions).toEqual(['accept', 'return']);
      expect((await post(S, `/api/v1/tasks/${t.id}/actions/accept`, { version: t.version + 2, comment: 'сам' })).statusCode).toBe(409);
      expect((await post(H, `/api/v1/tasks/${t.id}/actions/accept`, { version: t.version + 2, comment: 'Принято' })).json().status.systemKey).toBe('done');
      expect((await post(H, `/api/v1/tasks/${t.id}/actions/unknown`, { version: 1 })).statusCode).toBe(400);
    }));
});
