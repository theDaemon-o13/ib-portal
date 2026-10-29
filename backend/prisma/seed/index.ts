// Идемпотентный seed: коды прав и системные роли (CLAUDE.md, раздел 5).
// Запускается сервисом migrate после prisma migrate deploy, от владельца схемы.
// Ничего не удаляет и не перетирает состав ролей, изменённый в интерфейсе.
import { createPrisma } from '../../src/lib/db.js';
import { CATALOGS } from '../../src/lib/catalogs.js';
import { PERMISSIONS, SUPER_ADMIN_LOCKED, SYSTEM_ROLES } from '../../src/lib/permissions.js';
import { DEFAULT_WEEKEND_DAYS } from '../../src/lib/working-days.js';
import { seedDashboardLayouts } from './dashboard.js';
import { seedDlp } from './dlp.js';
import { seedMonitorSlides } from './monitor.js';
import { seedPermissionGrants } from './rbac.js';
import { seedCompareKeys, seedRegisters } from './registers.js';
import { seedRisks } from './risks.js';
import { seedStarter } from './starter.js';
import { seedSystemItems } from './system-items.js';
import { seedVulns } from './vulns.js';

const prisma = createPrisma();

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

    await seedPermissionGrants(tx);

    // Справочники: набор фиксирован, названия и описания обновляются.
    for (const [index, c] of CATALOGS.entries()) {
      const data = { name: c.name, description: c.description, kind: c.kind, hasColor: c.hasColor, sortOrder: index };
      await tx.catalog.upsert({ where: { code: c.code }, create: { code: c.code, ...data }, update: data });
    }

    await seedSystemItems(tx);

    // Рабочая неделя по умолчанию — пятидневка.
    await tx.appSetting.upsert({
      where: { key: 'work_week' },
      create: { key: 'work_week', value: { weekendDays: [...DEFAULT_WEEKEND_DAYS] } },
      update: {},
    });

    await seedStarter(tx);
    await seedRegisters(tx);
    await seedVulns(tx);
    await seedRisks(tx);
    await seedDlp(tx);
    await seedCompareKeys(tx);
    await seedDashboardLayouts(tx);
    await seedMonitorSlides(tx);
  });
  console.log(`Seed выполнен: прав ${PERMISSIONS.length}, системных ролей ${SYSTEM_ROLES.length}, справочников ${CATALOGS.length}`);
}

main()
  .catch((err: unknown) => {
    console.error('Seed не выполнен:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
