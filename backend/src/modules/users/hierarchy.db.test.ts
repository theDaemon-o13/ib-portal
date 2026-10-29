import { describe, expect, it } from 'vitest';
import { isSeniorOf, seniorIdsOf, subordinateIdsOf } from '../../lib/hierarchy.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, roleId, type Tx } from '../../test/db.js';
import * as users from './service.js';

async function setup(tx: Tx) {
  const admin = await makeUser(tx, ['super_admin']);
  const actor = await actorFor(tx, admin.id);
  // Цепочка: head ← lead ← staff.
  const head = await makeUser(tx, ['ib_staff']);
  const lead = await makeUser(tx, ['ib_staff'], { manager: { connect: { id: head.id } } });
  const staff = await makeUser(tx, ['ib_staff'], { manager: { connect: { id: lead.id } } });
  return { admin, actor, head, lead, staff };
}

const version = async (tx: Tx, id: string) => (await tx.user.findUniqueOrThrow({ where: { id } })).version;

/** Ошибка триггера прерывает транзакцию — проверяем её в точке сохранения. */
async function triggerRejects(tx: Tx, userId: string, managerId: string): Promise<string> {
  await tx.$executeRawUnsafe('SAVEPOINT cycle_check');
  try {
    await tx.$executeRaw`UPDATE users SET manager_id = ${managerId}::uuid WHERE id = ${userId}::uuid`;
    return 'принято';
  } catch (err) {
    return String((err as Error).message);
  } finally {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT cycle_check');
  }
}

describe('иерархия: руководитель у пользователя (ADR-0020)', () => {
  it('старшие — вся цепочка выше, ближний первым; подчинённые — все уровни ниже', () =>
    inTx(async (tx) => {
      const { head, lead, staff } = await setup(tx);
      expect(await seniorIdsOf(tx, staff.id)).toEqual([lead.id, head.id]);
      expect(await subordinateIdsOf(tx, head.id)).toEqual([lead.id, staff.id]);
      expect(await isSeniorOf(tx, head.id, staff.id)).toBe(true);
      expect(await isSeniorOf(tx, staff.id, head.id)).toBe(false);
      expect(await isSeniorOf(tx, staff.id, staff.id)).toBe(false);
    }));

  it('цикл A→B→A и A→B→C→A отклоняет сервис (понятный текст) и триггер БД', () =>
    inTx(async (tx) => {
      const { actor, head, lead, staff } = await setup(tx);
      await expectCode(users.updateUser(tx, actor, head.id, { version: await version(tx, head.id), managerId: lead.id }), 'MANAGER_CYCLE');
      await expectCode(users.updateUser(tx, actor, head.id, { version: await version(tx, head.id), managerId: staff.id }), 'MANAGER_CYCLE');
      await expectCode(users.updateUser(tx, actor, head.id, { version: await version(tx, head.id), managerId: head.id }), 'MANAGER_SELF');
      expect(await triggerRejects(tx, head.id, staff.id)).toMatch(/цикл в цепочке руководителей/);
      // Триггер BEFORE срабатывает раньше CHECK users_manager_not_self — любое из двух сообщений.
      expect(await triggerRejects(tx, head.id, head.id)).toMatch(/цикл в цепочке руководителей|users_manager_not_self/);
    }));

  it('назначение и снятие руководителя — в журнале «было → стало»; в карточке — руководитель и число подчинённых', () =>
    inTx(async (tx) => {
      const { actor, head, staff } = await setup(tx);
      const moved = await users.updateUser(tx, actor, staff.id, { version: await version(tx, staff.id), managerId: head.id });
      expect(moved.manager?.id).toBe(head.id);
      const entry = await lastAudit(tx);
      expect(entry.action).toBe('user.updated');
      expect((entry.diff as { summary: string }).summary).toMatch(/руководитель .* → .*\(/);
      const list = await users.listUsers(tx, { limit: 500, search: head.login });
      expect(list.items.find((u) => u.id === head.id)?.subordinateCount).toBe(2);

      const cleared = await users.updateUser(tx, actor, staff.id, { version: await version(tx, staff.id), managerId: null });
      expect(cleared.manager).toBeNull();
    }));

  it('только сотрудники ИБ: руководитель без ib.work или отключённый — нельзя; без ib.work руководитель снимается, а подчинённые мешают', () =>
    inTx(async (tx) => {
      const { actor, head, lead, staff } = await setup(tx);
      const reader = await makeUser(tx, ['ib_head']); // без ib.work
      await expectCode(users.updateUser(tx, actor, staff.id, { version: await version(tx, staff.id), managerId: reader.id }), 'MANAGER_NOT_IB');
      await expectCode(users.updateUser(tx, actor, reader.id, { version: await version(tx, reader.id), managerId: head.id }), 'SUBORDINATE_NOT_IB');
      const off = await makeUser(tx, ['ib_staff'], { isActive: false });
      await expectCode(users.updateUser(tx, actor, staff.id, { version: await version(tx, staff.id), managerId: off.id }), 'MANAGER_INACTIVE');

      // У lead есть подчинённый: снять с него ib.work нельзя.
      const headRole = await roleId(tx, 'ib_head');
      await expectCode(users.updateUser(tx, actor, lead.id, { version: await version(tx, lead.id), roleIds: [headRole] }), 'HAS_SUBORDINATES');
      // У staff подчинённых нет: без ib.work его руководитель снимается.
      const changed = await users.updateUser(tx, actor, staff.id, { version: await version(tx, staff.id), roleIds: [headRole] });
      expect(changed.manager).toBeNull();
    }));

  it('отключённый руководитель остаётся в цепочке: старшие выше него не теряются', () =>
    inTx(async (tx) => {
      const { actor, head, lead, staff } = await setup(tx);
      await users.setActive(tx, actor, lead.id, await version(tx, lead.id), false);
      expect(await isSeniorOf(tx, head.id, staff.id)).toBe(true);
    }));

  it('создание пользователя сразу с руководителем', () =>
    inTx(async (tx) => {
      const { actor, head } = await setup(tx);
      const { argon2Hasher } = await import('../../lib/passwords.js');
      const { user } = await users.createUser(tx, actor, argon2Hasher, {
        login: `h.${Date.now().toString(36)}`, fullName: 'Подчинённый', position: '', department: '',
        roleIds: [await roleId(tx, 'ib_staff')], managerId: head.id,
      });
      expect(user.manager?.id).toBe(head.id);
    }));
});
