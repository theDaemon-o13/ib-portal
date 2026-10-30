// Раздел «Уязвимости» (релиз 1.5.0, ADR-0029): справочник «Типы систем» и системная группа «Без группы».
// Однократно (seed_markers): удалённое или архивированное администратором не восстанавливается.
import type { Prisma } from '../../src/generated/prisma/client.js';
import { LEGACY_NODE_KEY, SYSTEM_TYPES_CATALOG, UNGROUPED_KEY } from '../../src/modules/vulns/groups.service.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

const SYSTEM_TYPES = ['БД', 'Серверы', 'Рабочие станции', 'Сетевое оборудование', 'Веб-приложения'];
export const UNGROUPED_NAME = 'Без группы';

export async function seedVulnGroups(tx: Tx): Promise<void> {
  await once(tx, 'starter.system_types.v1', async () => {
    const max = await tx.catalogItem.aggregate({ where: { catalogCode: SYSTEM_TYPES_CATALOG }, _max: { sortOrder: true } });
    let order = max._max.sortOrder ?? 0;
    let created = 0;
    for (const value of SYSTEM_TYPES) {
      const exists = await tx.catalogItem.findFirst({ where: { catalogCode: SYSTEM_TYPES_CATALOG, deletedAt: null, value: { equals: value, mode: 'insensitive' } } });
      if (exists) continue;
      await tx.catalogItem.create({ data: { catalogCode: SYSTEM_TYPES_CATALOG, value, sortOrder: ++order } });
      created++;
    }
    return `«Типы систем»: стартовых значений ${created}`;
  });

  await once(tx, 'vulns.groups.v1.ungrouped', async () => {
    if (await tx.vulnGroup.findUnique({ where: { systemKey: UNGROUPED_KEY } })) return '«Без группы» уже есть';
    // Название уникально: если администратор успел завести свою группу «Без группы» — системная получает пометку.
    const clash = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM vuln_groups WHERE lower(btrim(name)) = lower(${UNGROUPED_NAME})`;
    const group = await tx.vulnGroup.create({ data: { name: clash.length ? `${UNGROUPED_NAME} (системная)` : UNGROUPED_NAME, kind: 'temporary', systemKey: UNGROUPED_KEY } });
    await tx.vulnNode.create({ data: { groupId: group.id, systemKey: LEGACY_NODE_KEY } });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'vuln.group.created', entity: 'vuln_group', entityId: group.id,
        diff: { summary: `Seed 1.5.0: системная группа «${group.name}» с узлом «Из прежнего реестра»` } as Prisma.InputJsonValue,
      },
    });
    return `Системная группа «${group.name}» с узлом «Из прежнего реестра»`;
  });
}
