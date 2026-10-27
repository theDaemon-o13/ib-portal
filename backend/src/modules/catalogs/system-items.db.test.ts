import { describe, expect, it } from 'vitest';
import { seedSystemItems } from '../../../prisma/seed/system-items.js';
import { inTx } from '../../test/db.js';

describe('seed: системные значения', () => {
  it('одноимённое значение администратора становится системным — с записью в журнале аудита', () =>
    inTx(async (tx) => {
      // Как будто администратор завёл «Документы» сам до появления системной категории.
      const item = await tx.catalogItem.findUniqueOrThrow({ where: { catalogCode_systemKey: { catalogCode: 'task_categories', systemKey: 'documents' } } });
      await tx.catalogItem.update({ where: { id: item.id }, data: { systemKey: null, isSystem: false, value: 'документы', archivedAt: new Date() } });
      const before = await tx.catalogItem.count({ where: { catalogCode: 'task_categories' } });

      await seedSystemItems(tx);

      const after = await tx.catalogItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after).toMatchObject({ systemKey: 'documents', isSystem: true, archivedAt: null, value: 'документы' });
      expect(await tx.catalogItem.count({ where: { catalogCode: 'task_categories' } })).toBe(before); // дубль не создан
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: 'catalog.item_made_system', entityId: item.id } });
      expect(audit.userId).toBeNull();
      expect((audit.diff as { summary: string }).summary).toMatch(/Seed: значение «документы» справочника «task_categories» стало системным/);

      // Повторный seed ничего не меняет и в журнал не пишет.
      await seedSystemItems(tx);
      expect(await tx.auditLog.count({ where: { action: 'catalog.item_made_system', entityId: item.id } })).toBe(1);
    }));
});
