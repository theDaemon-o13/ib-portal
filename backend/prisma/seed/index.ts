// Идемпотентный seed: коды прав и системные роли (CLAUDE.md, раздел 5).
// Запускается сервисом migrate после prisma migrate deploy, от владельца схемы.
// Ничего не удаляет и не перетирает состав ролей, изменённый в интерфейсе.
import { PrismaClient } from '@prisma/client';
import { PERMISSIONS, SUPER_ADMIN_LOCKED, SYSTEM_ROLES } from '../../src/lib/permissions.js';

const prisma = new PrismaClient();

async function main() {
  await prisma.$transaction(async (tx) => {
    for (const [index, p] of PERMISSIONS.entries()) {
      await tx.permission.upsert({
        where: { code: p.code },
        create: { code: p.code, name: p.name, description: p.description, sortOrder: index },
        update: { name: p.name, description: p.description, sortOrder: index },
      });
    }

    for (const role of SYSTEM_ROLES) {
      const existing = await tx.role.findUnique({ where: { code: role.code } });
      if (!existing) {
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

    // У супер-администратора settings.manage и users.manage не снимаются.
    const superAdmin = await tx.role.findUniqueOrThrow({ where: { code: 'super_admin' } });
    await tx.rolePermission.createMany({
      data: SUPER_ADMIN_LOCKED.map((permissionCode) => ({ roleId: superAdmin.id, permissionCode })),
      skipDuplicates: true,
    });
  });
  console.log(`Seed выполнен: прав ${PERMISSIONS.length}, системных ролей ${SYSTEM_ROLES.length}`);
}

main()
  .catch((err: unknown) => {
    console.error('Seed не выполнен:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
