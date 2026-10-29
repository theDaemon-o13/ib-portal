// Права, добавленные в обновлении: выдаются системным ролям один раз (seed_markers).
// Снятое администратором право при следующем обновлении не возвращается. Каждая выдача — в журнал аудита.
import type { Prisma } from '../../src/generated/prisma/client.js';
import { PERMISSION_GRANTS } from '../../src/lib/permissions.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

export async function seedPermissionGrants(tx: Tx): Promise<void> {
  for (const step of PERMISSION_GRANTS) {
    await once(tx, step.key, async () => {
      const done: string[] = [];
      for (const [roleCode, codes] of Object.entries(step.grants)) {
        const role = await tx.role.findUnique({ where: { code: roleCode } });
        if (!role) continue;
        const before = done.length;
        for (const code of codes ?? []) {
          const res = await tx.rolePermission.createMany({ data: [{ roleId: role.id, permissionCode: code }], skipDuplicates: true });
          if (res.count === 0) continue;
          const permName = (await tx.permission.findUnique({ where: { code } }))?.name ?? code;
          await tx.auditLog.create({
            data: {
              userId: null, action: 'role.permission.granted', entity: 'role', entityId: role.id,
              diff: {
                summary: `Обновление ${step.release}: роли «${role.name}» выдано право «${permName}»`,
                after: { permission: code, granted: true },
              },
            },
          });
          done.push(`«${role.name}» — ${code}`);
        }
        if (done.length > before) await tx.role.update({ where: { id: role.id }, data: { version: { increment: 1 } } });
      }
      return `Права обновления ${step.release}: ${done.length ? done.join(', ') : 'уже выданы'}`;
    });
  }
}
