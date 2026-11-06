// Маршрут документа 1.2.0 (ADR-0024): рабочие версии старого маршрута (этапы 0–3) переходят на новый (11–16):
// «Автор» → «Драфт», «Начальник ИБ» → «Согласование начальника ИБ», «Юридический отдел» и «Правление» →
// «Согласование с ответственными лицами» (решение владельца). Утверждённые версии не меняются (триггер).
// Каждый запуск: после отката на 1.1.0 и повторной выкладки переносятся и версии, созданные старой версией.
// История не переписывается: в document_approvals добавляется решение migrated (откуда → куда).
import type { Prisma } from '../../src/generated/prisma/client.js';
import { LEGACY_STAGE_NAMES, placeName, ROUTE_FROM_LEGACY, ROUTE_V2_NAMES, routeV3Of, stageName, stageState } from '../../src/modules/documents/status.js';
import { syncAllStageTasks } from '../../src/modules/documents/service.js';
import { closeTasks } from '../../src/modules/documents/tasks.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

export async function seedDocumentRoute(tx: Tx): Promise<void> {
  const working = await tx.documentVersion.findMany({
    where: { stage: { in: Object.keys(ROUTE_FROM_LEGACY).map(Number) }, approvedAt: null, workingOf: { isNot: null } },
    select: { id: true, no: true, round: true, stage: true, documentId: true, document: { select: { ownerId: true } } },
  });
  if (!working.length) return;
  const counts = new Map<string, number>();
  for (const v of working) {
    const to = ROUTE_FROM_LEGACY[v.stage] as number;
    await tx.documentVersion.update({ where: { id: v.id }, data: { stage: to } });
    await tx.document.update({ where: { id: v.documentId }, data: { version: { increment: 1 } } });
    const label = `«${LEGACY_STAGE_NAMES[v.stage]}» → «${stageName(to)}»`;
    await tx.documentApproval.create({
      data: {
        documentId: v.documentId, versionId: v.id, versionNo: v.no, round: v.round, stage: v.stage, toStage: to,
        // Решение без автора-человека: в истории показывается «Система»; actor_id обязателен — владелец документа.
        decision: 'migrated', comment: `Перенесён на новый маршрут при обновлении на 1.2.0: ${label}`, actorId: v.document.ownerId,
      },
    });
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = `Документы 1.2.0: на новый маршрут перенесено ${working.length} (${[...counts].map(([k, n]) => `${k}: ${n}`).join('; ')})`;
  await tx.auditLog.create({
    data: { userId: null, action: 'document.route_migrated', entity: 'document', entityId: null, diff: { summary, moved: working.length } as Prisma.InputJsonValue },
  });
  console.log(summary);
}

/**
 * Маршрут 1.11.0 (ADR-0042, план 1.11.0, раздел 3): рабочие версии маршрута 1.2.0 (этапы 11–16) переходят на этапы
 * 21–24 — 11 и 12 → 21 «Драфт»; 13 → 21 «На проверке у начальника ИБ» (его задача сохраняется: состояние задачи
 * переписывается на новое); 14 → 22 «Согласование», а если все лица (хотя бы одно) согласовали — «На повторной
 * проверке»; 15 → 23 «Перевод» (файлы перевода остаются в «Файлах прежнего маршрута»); 16 → 24 «Утверждение».
 * Каждый запуск: после отката на 1.10.0 и повторной выкладки переносятся и версии, созданные 1.10.0. Утверждённые и
 * отменённые версии не трогаются; история не переписывается — решение migrated (откуда → куда) и сводка в журнале.
 * Остальные задачи этапов приводит к новому маршруту seedDocumentStageTasks (закрывает прежние, создаёт новые).
 */
export async function seedDocumentRouteV3(tx: Tx): Promise<void> {
  const working = await tx.documentVersion.findMany({
    where: { stage: { in: Object.keys(ROUTE_V2_NAMES).map(Number) }, approvedAt: null, cancelledAt: null, workingOf: { isNot: null } },
    select: {
      id: true, no: true, round: true, stage: true, documentId: true, document: { select: { ownerId: true } },
      parties: { where: { removedAt: null }, select: { approvedAt: true } },
    },
  });
  if (!working.length) return;
  const counts = new Map<string, number>();
  let headTasks = 0;
  for (const v of working) {
    const allApproved = v.parties.length > 0 && v.parties.every((p) => p.approvedAt !== null);
    const to = routeV3Of(v.stage, allApproved);
    if (!to) continue;
    await tx.documentVersion.update({ where: { id: v.id }, data: { stage: to.stage, routeState: to.state } });
    await tx.document.update({ where: { id: v.documentId }, data: { version: { increment: 1 } } });
    const label = `«${stageName(v.stage)}» → «${placeName(to.stage, to.state)}»`;
    await tx.documentApproval.create({
      data: {
        documentId: v.documentId, versionId: v.id, versionNo: v.no, round: v.round, stage: v.stage, toStage: to.stage,
        decision: 'migrated', comment: `Перенесён на маршрут 1.11.0 при обновлении: ${label}`, actorId: v.document.ownerId,
      },
    });
    if (v.stage === 13) {
      // Задача начальника ИБ «Согласовать» остаётся у него — теперь как задача «На проверке» (то же место по смыслу).
      const res = await tx.task.updateMany({
        where: { documentId: v.documentId, documentReason: 'stage', documentState: `${v.id}:${v.round}:13`, completedAt: null, archivedAt: null, deletedAt: null },
        data: { documentState: stageState({ id: v.id, round: v.round, stage: to.stage }, to.state), version: { increment: 1 } },
      });
      headTasks += res.count;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = `Документы 1.11.0: на маршрут из 4 этапов перенесено ${working.length} (${[...counts].map(([k, n]) => `${k}: ${n}`).join('; ')}); задач начальника ИБ сохранено ${headTasks}`;
  await tx.auditLog.create({
    data: { userId: null, action: 'document.route_migrated', entity: 'document', entityId: null, diff: { summary, moved: working.length, headTasks } as Prisma.InputJsonValue },
  });
  console.log(summary);
}

/**
 * Задачи этапов маршрута (1.6.3, ADR-0034) для документов, которые уже в работе: без этого шага задача появилась бы
 * только при следующем действии с документом. Каждый запуск — идемпотентно: syncStageTasks не дублирует задачи и не
 * возвращает закрытые вручную; после отката на 1.6.2 и повторной выкладки задачи создаются снова.
 */
export async function seedDocumentStageTasks(tx: Tx): Promise<void> {
  const before = await tx.task.count({ where: { documentReason: 'stage' } });
  const docs = await tx.document.count({ where: { deletedAt: null, archivedAt: null, workingVersionId: { not: null } } });
  await syncAllStageTasks(tx);
  const created = (await tx.task.count({ where: { documentReason: 'stage' } })) - before;
  if (created) console.log(`Документы: задачи этапов маршрута — документов в работе ${docs}, создано задач ${created}`);
}

/**
 * 1.6.4, один раз: задачи «Проверить документ» из 1.6.3 — по одной каждому сотруднику ИБ — уходят в архив (открытые
 * закрываются системой). Их заменяет одна общая задача со списком «Могут взять» (seedDocumentStageTasks). Личные задачи
 * этапа 12 — у всех, кроме владельца документа (у владельца — «Учесть комментарии»). Архив мягкий: задачи остаются.
 */
export async function seedReviewTasksGrouped(tx: Tx): Promise<void> {
  await once(tx, 'docs.stage_tasks.group.v1', async () => {
    const rows = await tx.$queryRaw<{ id: string; number: number; status_id: string; open: boolean }[]>`
      SELECT t.id::text, t.number, t.status_id::text, t.completed_at IS NULL AS open
      FROM tasks t JOIN documents d ON d.id = t.document_id
      WHERE t.document_reason = 'stage' AND t.document_state LIKE '%:12' AND t.assignee_id IS DISTINCT FROM d.owner_id
        AND t.archived_at IS NULL AND t.deleted_at IS NULL`;
    const open = rows.filter((r) => r.open).map((r) => ({ id: r.id, number: r.number, statusId: r.status_id }));
    await closeTasks(tx, open, 'Заменена общей задачей «Проверить документ» (1.6.4)', { archive: true });
    const closed = rows.filter((r) => !r.open).map((r) => r.id);
    if (closed.length) await tx.task.updateMany({ where: { id: { in: closed } }, data: { archivedAt: new Date(), version: { increment: 1 } } });
    if (rows.length) {
      await tx.auditLog.create({
        data: {
          userId: null, action: 'task.archived', entity: 'task', entityId: null,
          diff: { summary: `Задачи «Проверить документ» по одной на сотрудника — в архив: ${rows.length} (открытых ${open.length})`, ids: rows.map((r) => r.id) } as Prisma.InputJsonValue,
        },
      });
    }
    return `Документы: задачи проверки сотрудниками по одной на сотрудника — в архив ${rows.length} (открытых ${open.length})`;
  });
}
