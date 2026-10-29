// Процесс задач (релиз 1.2.0, ADR-0022): колонки Backlog → Поставленные → В работе → На проверке → Выполнено.
// Однократный шаг: порядок колонок, прежние названия по умолчанию → новые, признаки комментария, перенос задач
// «Новые» с исполнителем в «Поставленные». Каждый запуск: выравнивание открытых задач после работы backend 1.1.0.
import type { Prisma } from '../../src/generated/prisma/client.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

const ORDER = ['new', 'assigned', 'work', 'review', 'done'] as const;
/** Названия 1.1.0 по умолчанию: переименовываются, только если администратор их не менял. */
const RENAME: Record<string, [from: string, to: string]> = { new: ['Новые', 'Backlog'], done: ['Готово', 'Выполнено'] };
const FLAGS: Record<string, { commentForward: boolean; commentReturn: boolean }> = {
  work: { commentForward: false, commentReturn: true },
  review: { commentForward: true, commentReturn: false },
  done: { commentForward: true, commentReturn: false },
};

type StatusIds = Record<(typeof ORDER)[number], string>;

/** Системные колонки создаёт seedSystemItems раньше этого шага; нет хотя бы одной — seed останавливается. */
async function statusIds(tx: Tx): Promise<StatusIds> {
  const items = await tx.catalogItem.findMany({ where: { catalogCode: 'task_statuses', systemKey: { in: [...ORDER] } }, select: { id: true, systemKey: true } });
  const out = {} as StatusIds;
  for (const key of ORDER) {
    const id = items.find((i) => i.systemKey === key)?.id;
    if (!id) throw new Error(`нет системной колонки задач «${key}»`);
    out[key] = id;
  }
  return out;
}

/** Открытые задачи: в Backlog — без исполнителя, в «Поставленные» — с исполнителем. Возвращает число перенесённых. */
async function align(tx: Tx, ids: StatusIds, kind: 'migration' | 'system', comment: string): Promise<number> {
  const moves: [from: string, to: string, withAssignee: boolean][] = [[ids.new, ids.assigned, true], [ids.assigned, ids.new, false]];
  let total = 0;
  for (const [from, to, withAssignee] of moves) {
    const tasks = await tx.task.findMany({
      where: {
        statusId: from, deletedAt: null, assigneeId: withAssignee ? { not: null } : null,
        // Однократный перенос — все задачи «Новые» с исполнителем, в том числе архивные; выравнивание — только открытые.
        ...(kind === 'system' ? { completedAt: null } : {}),
      },
      select: { id: true },
    });
    if (!tasks.length) continue;
    const taskIds = tasks.map((t) => t.id);
    await tx.task.updateMany({ where: { id: { in: taskIds } }, data: { statusId: to, version: { increment: 1 } } });
    await tx.taskTransition.createMany({ data: taskIds.map((taskId) => ({ taskId, fromStatusId: from, toStatusId: to, kind, comment })) });
    total += taskIds.length;
  }
  return total;
}

export async function seedTaskProcess(tx: Tx): Promise<void> {
  await once(tx, 'tasks.process.v1_2', async () => {
    const ids = await statusIds(tx);
    const notes: string[] = [];
    for (const [i, key] of ORDER.entries()) {
      const item = await tx.catalogItem.findUniqueOrThrow({ where: { id: ids[key] } });
      const data: Prisma.CatalogItemUpdateInput = { sortOrder: i + 1, ...(FLAGS[key] ?? {}) };
      const rename = RENAME[key];
      if (rename && item.value === rename[0]) {
        data.value = rename[1];
        notes.push(`«${rename[0]}» → «${rename[1]}»`);
      } else if (rename && item.value !== rename[1]) {
        notes.push(`«${item.value}» оставлено (название задал администратор)`);
      }
      await tx.catalogItem.update({ where: { id: item.id }, data: { ...data, version: { increment: 1 } } });
    }
    const moved = await align(tx, ids, 'migration', 'Перенесена при обновлении на 1.2.0');
    const summary = `Задачи 1.2.0: колонки Backlog → Поставленные → В работе → На проверке → Выполнено; ${notes.join(', ') || 'названия не менялись'}; в «Поставленные» перенесено ${moved}`;
    await tx.auditLog.create({
      data: { userId: null, action: 'catalog.item.updated', entity: 'catalog_item', entityId: ids.new, diff: { summary: `Обновление 1.2.0: ${summary}`, moved } },
    });
    return summary;
  });
  // После отката на 1.1.0 и повторной выкладки: 1.1.0 создаёт задачи с исполнителем в Backlog.
  const fixed = await align(tx, await statusIds(tx), 'system', 'Колонка выровнена по исполнителю при обновлении');
  if (fixed > 0) console.log(`Задачи: выровнено по исполнителю ${fixed} (Backlog ↔ «Поставленные»)`);
}
