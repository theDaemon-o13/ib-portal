import { describe, expect, it } from 'vitest';
import { seedPermissionGrants } from '../../../prisma/seed/rbac.js';
import { inTx, roleId } from '../../test/db.js';

const KEY = 'rbac.permissions.v1_2';

describe('seed: права обновления 1.2.0 выдаются один раз', () => {
  it('выдаёт недостающие права системным ролям и пишет журнал; снятое потом не возвращает', () =>
    inTx(async (tx) => {
      const head = await roleId(tx, 'ib_head');
      // Состояние до обновления: шага не было, права у роли нет.
      await tx.seedMarker.deleteMany({ where: { key: KEY } });
      await tx.rolePermission.deleteMany({ where: { roleId: head, permissionCode: { in: ['tasks.review', 'audit.view'] } } });

      await seedPermissionGrants(tx);
      const has = async (code: string) => !!(await tx.rolePermission.findUnique({ where: { roleId_permissionCode: { roleId: head, permissionCode: code } } }));
      expect(await has('tasks.review')).toBe(true);
      expect(await has('audit.view')).toBe(true);
      const logged = await tx.auditLog.findMany({ where: { action: 'role.permission.granted', entityId: head, userId: null }, orderBy: { id: 'desc' }, take: 2 });
      expect(logged.map((l) => (l.diff as { after: { permission: string } }).after.permission).sort()).toEqual(['audit.view', 'tasks.review']);

      // Администратор снял право — следующий запуск seed его не возвращает.
      await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: head, permissionCode: 'tasks.review' } } });
      await seedPermissionGrants(tx);
      expect(await has('tasks.review')).toBe(false);
    }));
});
