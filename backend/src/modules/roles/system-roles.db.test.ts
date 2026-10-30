import { describe, expect, it } from 'vitest';
import { seedSystemRoles } from '../../../prisma/seed/rbac.js';
import { inTx, roleId } from '../../test/db.js';

const permsOf = async (tx: Parameters<Parameters<typeof inTx>[0]>[0], code: string) =>
  (await tx.rolePermission.findMany({ where: { role: { code } }, select: { permissionCode: true } })).map((p) => p.permissionCode).sort();

describe('seed: системные роли (релиз 1.4.0 — «SOC»)', () => {
  it('«SOC» — системная, права «Сотрудника ИБ», без пользователей', () =>
    inTx(async (tx) => {
      const soc = await tx.role.findUniqueOrThrow({ where: { code: 'soc' }, include: { users: true } });
      expect(soc.isSystem).toBe(true);
      expect(soc.name).toBe('SOC');
      expect(soc.users).toHaveLength(0);
      expect(await permsOf(tx, 'soc')).toEqual(await permsOf(tx, 'ib_staff'));
    }));

  it('повторный запуск не трогает состав существующей роли; нет роли — создаёт заново', () =>
    inTx(async (tx) => {
      const soc = await roleId(tx, 'soc');
      await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: soc, permissionCode: 'records.edit' } } });
      await seedSystemRoles(tx);
      expect(await permsOf(tx, 'soc')).toEqual(['evidence.review', 'ib.work']);

      await tx.rolePermission.deleteMany({ where: { roleId: soc } });
      await tx.role.delete({ where: { id: soc } });
      await seedSystemRoles(tx);
      expect(await permsOf(tx, 'soc')).toEqual(['evidence.review', 'ib.work', 'records.edit']);
    }));

  it('своя роль с тем же названием — остановка с понятным текстом, ничего не создаётся', () =>
    inTx(async (tx) => {
      const soc = await roleId(tx, 'soc');
      await tx.rolePermission.deleteMany({ where: { roleId: soc } });
      await tx.role.delete({ where: { id: soc } });
      await tx.role.create({ data: { name: 'soc', description: 'своя' } });
      await expect(seedSystemRoles(tx)).rejects.toThrow('уже есть роль «soc»: переименуйте её');
      expect(await tx.role.findUnique({ where: { code: 'soc' } })).toBeNull();
    }));
});
