import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, roleId, type Tx } from '../../test/db.js';
import { setRolePermission } from '../roles/service.js';
import * as users from './service.js';

async function setup(tx: Tx) {
  const admin = await makeUser(tx, ['super_admin']);
  const a = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Первый Начальник' });
  const b = await makeUser(tx, ['ib_staff'], { fullName: 'Второй Начальник' });
  return { admin, a, b, actor: await actorFor(tx, admin.id) };
}

const version = async (tx: Tx, id: string) => (await tx.user.findUniqueOrThrow({ where: { id } })).version;
const set = async (tx: Tx, actor: Awaited<ReturnType<typeof setup>>['actor'], id: string, value: boolean, transfer?: boolean) =>
  users.setIbHead(tx, actor, id, { version: await version(tx, id), value, ...(transfer === undefined ? {} : { transfer }) });

describe('отметка «Является начальником ИБ» (1.4.0)', () => {
  it('ставится одному; второму — 409 с ФИО держателя; передача переносит одной транзакцией с записью в журнал', () =>
    inTx(async (tx) => {
      const { a, b, actor } = await setup(tx);
      expect((await set(tx, actor, a.id, true)).isIbHead).toBe(true);
      expect((await lastAudit(tx)).action).toBe('user.ib_head.set');

      const err = await set(tx, actor, b.id, true).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('IB_HEAD_TAKEN');
      expect((err as AppError).details).toMatchObject({ holder: { id: a.id, fullName: 'Первый Начальник' } });

      expect((await set(tx, actor, b.id, true, true)).isIbHead).toBe(true);
      expect((await tx.user.findUniqueOrThrow({ where: { id: a.id } })).isIbHead).toBe(false);
      const entry = await lastAudit(tx);
      expect(entry.action).toBe('user.ib_head.transferred');
      expect((entry.diff as { summary: string }).summary).toMatch(/Первый Начальник .* → Второй Начальник/);

      // Снятие с последнего держателя разрешено, с записью в журнал.
      expect((await set(tx, actor, b.id, false)).isIbHead).toBe(false);
      expect((await lastAudit(tx)).action).toBe('user.ib_head.cleared');
      expect(await tx.user.count({ where: { isIbHead: true } })).toBe(0);
    }));

  it('уникальность — на уровне БД: вторую отметку не поставить и в обход сервиса', () =>
    inTx(async (tx) => {
      const { a, b } = await setup(tx);
      await tx.user.update({ where: { id: a.id }, data: { isIbHead: true } });
      await expect(tx.user.update({ where: { id: b.id }, data: { isIbHead: true } })).rejects.toThrow();
    }));

  it('только активному, с доступом к разделам ИБ, не супер-администратору — в обе стороны', () =>
    inTx(async (tx) => {
      const { admin, a, actor } = await setup(tx);
      const reader = await makeUser(tx, ['doc_reader']);
      await expectCode(set(tx, actor, reader.id, true), 'IB_HEAD_NOT_IB');
      // Другой супер-администратор (себе — IB_HEAD_SELF, отдельный тест).
      expect(admin.id).toBe(actor.id);
      await expectCode(set(tx, actor, (await makeUser(tx, ['super_admin'])).id, true), 'IB_HEAD_SUPER_ADMIN');
      const off = await makeUser(tx, ['ib_staff'], { isActive: false });
      await expectCode(set(tx, actor, off.id, true), 'INACTIVE');

      await set(tx, actor, a.id, true);
      const roles = async (codes: string[]) => Promise.all(codes.map((c) => roleId(tx, c)));
      // Держателю не дать роль «Супер-администратор» и не отнять доступ к разделам ИБ.
      await expectCode(users.updateUser(tx, actor, a.id, { version: await version(tx, a.id), roleIds: await roles(['ib_staff', 'ib_head', 'super_admin']) }), 'IB_HEAD_SUPER_ADMIN');
      await expectCode(users.updateUser(tx, actor, a.id, { version: await version(tx, a.id), roleIds: await roles(['ib_head']) }), 'IB_HEAD_NOT_IB');
      await expectCode(setRolePermission(tx, actor, await roleId(tx, 'ib_staff'), 'ib.work', false), 'IB_HEAD_NOT_IB');
    }));

  it('себе отметку не поставить (409 IB_HEAD_SELF), в том числе передачей; свою — снять или передать другому можно', () =>
    inTx(async (tx) => {
      const { a, b, actor } = await setup(tx);
      // Администратор ИБ (своя роль с users.manage и ib.work, не супер-администратор); право проверяет маршрут.
      const manager = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Администратор ИБ' });
      const self = await actorFor(tx, manager.id);
      await expectCode(set(tx, self, manager.id, true), 'IB_HEAD_SELF');
      await set(tx, actor, a.id, true);
      await expectCode(set(tx, self, manager.id, true, true), 'IB_HEAD_SELF');
      expect((await tx.user.findUniqueOrThrow({ where: { id: a.id } })).isIbHead).toBe(true);

      // Держатель сам передаёт отметку другому и снимает свою.
      const holder = await actorFor(tx, a.id);
      expect((await set(tx, holder, b.id, true, true)).isIbHead).toBe(true);
      expect((await lastAudit(tx)).action).toBe('user.ib_head.transferred');
      const holderB = await actorFor(tx, b.id);
      expect((await set(tx, holderB, b.id, false)).isIbHead).toBe(false);
    }));

  it('отключение держателя снимает отметку с записью в журнал', () =>
    inTx(async (tx) => {
      const { a, actor } = await setup(tx);
      await set(tx, actor, a.id, true);
      const off = await users.setActive(tx, actor, a.id, await version(tx, a.id), false);
      expect(off.isIbHead).toBe(false);
      const cleared = await tx.auditLog.findFirstOrThrow({ where: { action: 'user.ib_head.cleared', entityId: a.id } });
      expect((cleared.diff as { summary: string }).summary).toMatch(/отключён; этап «Начальник ИБ» без исполнителя/);
      // Включение отметку не возвращает.
      expect((await users.setActive(tx, actor, a.id, await version(tx, a.id), true)).isIbHead).toBe(false);
    }));
});
