// Системные значения справочников (CLAUDE.md, раздел 6): на них опирается логика портала.
import type { Prisma } from '@prisma/client';
import { SYSTEM_ITEMS } from '../../src/lib/catalogs.js';

type Tx = Prisma.TransactionClient;

/** Создать недостающие системные значения; одноимённое значение администратора сделать системным (с записью в журнал). */
export async function seedSystemItems(tx: Tx): Promise<void> {
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
      // Изменение значения, заведённого администратором, — в журнал (автор — система, как у автоматизаций).
      await tx.auditLog.create({
        data: {
          userId: null, action: 'catalog.item_made_system', entity: 'catalog_item', entityId: sameName.id,
          diff: {
            summary: `Seed: значение «${sameName.value}» справочника «${item.catalog}» стало системным (${item.why})`,
            before: { systemKey: null, isSystem: false, archivedAt: sameName.archivedAt?.toISOString() ?? null },
            after: { systemKey: item.key, isSystem: true, archivedAt: null },
          },
        },
      });
      console.log(`Значение «${sameName.value}» (${item.catalog}), заведённое администратором, стало системным: ${item.why}. Запись в журнале аудита`);
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
}
