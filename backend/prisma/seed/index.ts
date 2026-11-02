// Идемпотентный seed: коды прав и системные роли (CLAUDE.md, раздел 5).
// Запускается сервисом migrate после prisma migrate deploy, от владельца схемы.
// Ничего не удаляет и не перетирает состав ролей, изменённый в интерфейсе.
import { createPrisma } from '../../src/lib/db.js';
import { CATALOGS } from '../../src/lib/catalogs.js';
import { PERMISSIONS, SUPER_ADMIN_LOCKED, SYSTEM_ROLES } from '../../src/lib/permissions.js';
import { DEFAULT_WEEKEND_DAYS } from '../../src/lib/working-days.js';
import { seedAssessmentMethodology } from './assessment.js';
import { seedAssets, seedComponentInstances } from './assets.js';
import { seedDashboardLayouts } from './dashboard.js';
import { seedDlp } from './dlp.js';
import { seedDocumentRoute } from './documents.js';
import { seedMonitorSlides } from './monitor.js';
import { seedDocReaders, seedPermissionGrants, seedSystemRoles } from './rbac.js';
import { seedCompareKeys, seedRegisters } from './registers.js';
import { seedRisks } from './risks.js';
import { seedStarter } from './starter.js';
import { seedSystemItems } from './system-items.js';
import { seedTaskProcess, seedTaskReviewers } from './tasks.js';
import { seedVulnGroups } from './vuln-groups.js';
import { seedVulnLegacy } from './vuln-legacy.js';
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

    await seedSystemRoles(tx);

    // У супер-администратора settings.manage и users.manage не снимаются.
    const superAdmin = await tx.role.findUniqueOrThrow({ where: { code: 'super_admin' } });
    await tx.rolePermission.createMany({
      data: SUPER_ADMIN_LOCKED.map((permissionCode) => ({ roleId: superAdmin.id, permissionCode })),
      skipDuplicates: true,
    });

    await seedPermissionGrants(tx);
    await seedDocReaders(tx);

    // Справочники: набор фиксирован, названия и описания обновляются.
    for (const [index, c] of CATALOGS.entries()) {
      const data = { name: c.name, description: c.description, kind: c.kind, hasColor: c.hasColor, sortOrder: index };
      await tx.catalog.upsert({ where: { code: c.code }, create: { code: c.code, ...data }, update: data });
    }

    await seedSystemItems(tx);
    await seedTaskProcess(tx);
    await seedTaskReviewers(tx);
    await seedDocumentRoute(tx);
    await seedAssessmentMethodology(tx);

    // Рабочая неделя по умолчанию — пятидневка.
    await tx.appSetting.upsert({
      where: { key: 'work_week' },
      create: { key: 'work_week', value: { weekendDays: [...DEFAULT_WEEKEND_DAYS] } },
      update: {},
    });

    await seedStarter(tx);
    await seedRegisters(tx);
    await seedVulns(tx);
    await seedVulnGroups(tx);
    await seedVulnLegacy(tx);
    await seedRisks(tx);
    await seedDlp(tx);
    await seedAssets(tx);
    await seedComponentInstances(tx);
    await seedCompareKeys(tx);
    await seedDashboardLayouts(tx);
    await seedMonitorSlides(tx);
    // Одна транзакция на весь seed: перенос прежнего реестра уязвимостей (1.5.0) на десятках тысяч записей идёт
    // минуты — таймаут по умолчанию (5 с) откатил бы всё обновление.
  }, { timeout: 30 * 60_000, maxWait: 60_000 });
  console.log(`Seed выполнен: прав ${PERMISSIONS.length}, системных ролей ${SYSTEM_ROLES.length}, справочников ${CATALOGS.length}`);
}

main()
  .catch((err: unknown) => {
    console.error('Seed не выполнен:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
