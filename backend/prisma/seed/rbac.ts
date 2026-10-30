// Права, добавленные в обновлении: выдаются системным ролям один раз (seed_markers).
// Снятое администратором право при следующем обновлении не возвращается. Каждая выдача — в журнал аудита.
import type { Prisma } from '../../src/generated/prisma/client.js';
import { PERMISSION_GRANTS, RETIRED_ROLE_CODES, SYSTEM_ROLES } from '../../src/lib/permissions.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

/**
 * Системные роли: создаются, если роли с таким кодом нет; состав существующей не перезаписывается (его настраивают
 * в интерфейсе). Своя роль с тем же названием — понятная остановка вместо ошибки уникальности: seed — одна транзакция.
 */
export async function seedSystemRoles(tx: Tx): Promise<void> {
  for (const role of SYSTEM_ROLES) {
    const existing = await tx.role.findUnique({ where: { code: role.code } });
    if (!existing) {
      const clash = await tx.role.findFirst({ where: { name: { equals: role.name, mode: 'insensitive' } }, select: { name: true } });
      if (clash) throw new Error(`уже есть роль «${clash.name}»: переименуйте её в «Настройки → Пользователи и роли» и повторите migrate — системная роль «${role.name}» создаётся с этим названием`);
      await tx.role.create({
        data: {
          code: role.code,
          name: role.name,
          description: role.description,
          isSystem: true,
          permissions: { create: role.permissions.map((permissionCode) => ({ permissionCode })) },
        },
      });
      console.log(`Создана роль «${role.name}»`);
    } else if (!existing.isSystem) {
      await tx.role.update({ where: { id: existing.id }, data: { isSystem: true } });
    }
  }
}

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

/**
 * Роли «Юрист» и «Правление» выведены из обращения (релиз 1.2.0, ADR-0024): их пользователи получают роль
 * «Читатель документов», прежняя роль снимается. Учётные записи не отключаются. Каждый запуск: после отката на 1.1.0
 * и повторной выкладки переносятся и назначенные там. Снятое администратором позже не возвращается — шаг смотрит
 * только на тех, кто сейчас в выведенных ролях. Каждая смена — в журнал (автор — «Система»).
 */
export async function seedDocReaders(tx: Tx): Promise<void> {
  const reader = await tx.role.findUniqueOrThrow({ where: { code: 'doc_reader' } });
  const links = await tx.userRole.findMany({
    where: { role: { code: { in: [...RETIRED_ROLE_CODES] } } },
    select: { userId: true, roleId: true, role: { select: { name: true } }, user: { select: { fullName: true, login: true } } },
    orderBy: [{ user: { login: 'asc' } }],
  });
  if (!links.length) return;
  const byUser = new Map<string, typeof links>();
  for (const l of links) byUser.set(l.userId, [...(byUser.get(l.userId) ?? []), l]);
  for (const [userId, own] of byUser) {
    await tx.userRole.deleteMany({ where: { userId, roleId: { in: own.map((l) => l.roleId) } } });
    await tx.userRole.createMany({ data: [{ userId, roleId: reader.id }], skipDuplicates: true });
    await tx.user.update({ where: { id: userId }, data: { version: { increment: 1 } } });
    const from = own.map((l) => `«${l.role.name}»`).join(', ');
    const u = must(own[0]).user;
    await tx.auditLog.create({
      data: {
        userId: null, action: 'user.updated', entity: 'user', entityId: userId,
        diff: {
          summary: `Обновление 1.2.0: ${u.fullName} (${u.login}) — роли ${from} → «${reader.name}»`,
          after: { changes: [{ label: 'Роли', from, to: `«${reader.name}»` }] },
        } as Prisma.InputJsonValue,
      },
    });
  }
  const summary = `Читатель документов: перенесено пользователей — ${byUser.size} (из ролей «Юрист» и «Правление»)`;
  await tx.auditLog.create({
    data: { userId: null, action: 'role.users_migrated', entity: 'role', entityId: reader.id, diff: { summary, users: byUser.size } as Prisma.InputJsonValue },
  });
  console.log(summary);
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('пустая группа ролей');
  return v;
}
