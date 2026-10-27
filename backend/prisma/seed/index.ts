// Идемпотентный seed: коды прав и системные роли (CLAUDE.md, раздел 5).
// Запускается сервисом migrate после prisma migrate deploy, от владельца схемы.
// Ничего не удаляет и не перетирает состав ролей, изменённый в интерфейсе.
import { PrismaClient } from '@prisma/client';
import { CATALOGS, SYSTEM_ITEMS } from '../../src/lib/catalogs.js';
import { PERMISSIONS, SUPER_ADMIN_LOCKED, SYSTEM_ROLES } from '../../src/lib/permissions.js';
import { DEFAULT_WEEKEND_DAYS } from '../../src/lib/working-days.js';
import { seedRegisters } from './registers.js';
import { seedStarter } from './starter.js';
import { seedVulns } from './vulns.js';

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

    // Справочники: набор фиксирован, названия и описания обновляются.
    for (const [index, c] of CATALOGS.entries()) {
      const data = { name: c.name, description: c.description, kind: c.kind, hasColor: c.hasColor, sortOrder: index };
      await tx.catalog.upsert({ where: { code: c.code }, create: { code: c.code, ...data }, update: data });
    }

    // Системные значения создаются, если их нет. Существующие не трогаются:
    // статусы администратор мог переименовать.
    for (const item of SYSTEM_ITEMS) {
      const existing = await tx.catalogItem.findUnique({
        where: { catalogCode_systemKey: { catalogCode: item.catalog, systemKey: item.key } },
      });
      if (existing) continue;
      // Администратор уже завёл значение с таким названием — оно становится системным (уникальность названия).
      const sameName = await tx.catalogItem.findFirst({
        where: { catalogCode: item.catalog, deletedAt: null, systemKey: null, value: { equals: item.value, mode: 'insensitive' } },
      });
      if (sameName) {
        await tx.catalogItem.update({ where: { id: sameName.id }, data: { systemKey: item.key, isSystem: true, archivedAt: null } });
        console.log(`Значение «${sameName.value}» стало системным`);
        continue;
      }
      const max = await tx.catalogItem.aggregate({ where: { catalogCode: item.catalog }, _max: { sortOrder: true } });
      await tx.catalogItem.create({
        data: {
          catalogCode: item.catalog,
          systemKey: item.key,
          isSystem: true,
          value: item.value,
          color: item.color ?? null,
          sortOrder: (max._max.sortOrder ?? 0) + 1,
        },
      });
      console.log(`Создано системное значение «${item.value}»`);
    }

    // Рабочая неделя по умолчанию — пятидневка.
    await tx.appSetting.upsert({
      where: { key: 'work_week' },
      create: { key: 'work_week', value: { weekendDays: [...DEFAULT_WEEKEND_DAYS] } },
      update: {},
    });

    await seedStarter(tx);
    await seedRegisters(tx);
    await seedVulns(tx);
    // Правила, созданные до справочника меток (первая установка: миграция шла раньше seed), — привязать по названию.
    const [linked] = await tx.$queryRaw<{ n: number }[]>`SELECT link_recipient_labels() AS n`;
    if (linked?.n) console.log(`Привязаны метки получателей в правилах: ${linked.n}`);
  });
  console.log(`Seed выполнен: прав ${PERMISSIONS.length}, системных ролей ${SYSTEM_ROLES.length}, справочников ${CATALOGS.length}`);
}

main()
  .catch((err: unknown) => {
    console.error('Seed не выполнен:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
