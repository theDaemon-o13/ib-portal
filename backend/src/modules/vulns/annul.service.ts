// «Аннулировать скан» (1.13.12, ADR-0052; docs/plans/release-1.13.12.md). Аннулирование — событие корзины
// (deletions, entity = 'vuln_scan'): сам скан не меняется (триггер vuln_scans_guard), файл, снимок находок и сравнение
// остаются. Аннулированный скан не считается в «ждут передачи ИКТ» и показателях, не передаётся ИКТ и не бывает
// «прошлым» для следующего импорта. Изменения, которые он внёс в реестр, не откатываются.
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { formatDateRu } from '../../lib/register-values.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { createDeletion, SCAN_REASON_LABELS, SCAN_REASONS, type ScanReasonCode } from '../trash/service.js';
import { nodeLabel } from './groups.service.js';

const REASON_MAX = 2000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Id аннулированных сканов (невосстановленные события корзины). Их мало: фильтр — `id: { notIn }`. */
export async function annulledScanIds(db: Db): Promise<string[]> {
  return (await db.deletion.findMany({ where: { entity: 'vuln_scan', restoredAt: null }, select: { entityId: true } })).map((d) => d.entityId);
}

/** Условие Prisma «скан не аннулирован». */
export async function activeScanWhere(db: Db): Promise<{ id?: { notIn: string[] } }> {
  const ids = await annulledScanIds(db);
  return ids.length ? { id: { notIn: ids } } : {};
}

export interface AnnulInfo {
  at: string;
  by: string;
  reasonCode: string | null;
  reasonLabel: string | null;
  reason: string;
  deletionId: string;
}

/** Аннулирование скана (последнее невосстановленное событие) или null. */
export async function annulInfo(db: Db, scanId: string): Promise<AnnulInfo | null> {
  const d = await db.deletion.findFirst({
    where: { entity: 'vuln_scan', entityId: scanId, restoredAt: null },
    include: { deleter: { select: { fullName: true } } },
    orderBy: { deletedAt: 'desc' },
  });
  if (!d) return null;
  return {
    at: d.deletedAt.toISOString(), by: d.deleter.fullName, reasonCode: d.reasonCode,
    reasonLabel: d.reasonCode ? SCAN_REASON_LABELS[d.reasonCode as ScanReasonCode] ?? d.reasonCode : null, reason: d.reason, deletionId: d.id,
  };
}

/** Почему аннулировать нельзя (null — можно): передан ИКТ, уже аннулирован, нет более позднего неаннулированного скана. */
export async function annulBlocker(db: Db, scan: { id: string; nodeId: string; scanDate: Date; createdAt: Date; handedOverOn: Date | null }): Promise<{ code: string; message: string } | null> {
  if (scan.handedOverOn) return { code: 'SCAN_HANDED_OVER', message: `Скан передан ИКТ ${formatDateRu(iso(scan.handedOverOn))} — аннулировать нельзя` };
  const annulled = await annulledScanIds(db);
  if (annulled.includes(scan.id)) return { code: 'SCAN_ANNULLED', message: 'Скан уже аннулирован' };
  // «Более поздний» — в том же порядке, что «прошлый скан» импорта: дата скана, затем время загрузки.
  const later = await db.vulnScan.count({
    where: {
      nodeId: scan.nodeId, id: { notIn: [...annulled, scan.id] },
      OR: [{ scanDate: { gt: scan.scanDate } }, { scanDate: scan.scanDate, createdAt: { gt: scan.createdAt } }],
    },
  });
  if (!later) return { code: 'SCAN_LAST', message: 'Это последний скан узла — аннулировать нельзя. Аннулировать можно скан, после которого в узел загружен другой' };
  return null;
}

export interface AnnulInput {
  reason: ScanReasonCode;
  comment?: string | null;
}

export async function annulScan(db: Db, actor: Actor, scanId: string, input: AnnulInput) {
  if (!(SCAN_REASONS as readonly string[]).includes(input.reason)) throw badRequest('BAD_REASON', 'Выберите причину');
  const comment = trimmed(input.comment ?? '');
  if (input.reason === 'other' && !comment) throw badRequest('REASON_REQUIRED', 'Опишите причину');
  if (comment.length > REASON_MAX) throw badRequest('BAD_REASON', `Причина — не длиннее ${REASON_MAX} символов`);
  return withTx(db, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; node_id: string }[]>`SELECT id::text, node_id::text FROM vuln_scans WHERE id = ${scanId}::uuid FOR UPDATE`;
    if (!locked[0]) throw notFound('Скан');
    // Узел — тоже: два аннулирования в одном узле одновременно не оставят его без неаннулированного скана.
    await tx.$queryRaw`SELECT id FROM vuln_nodes WHERE id = ${locked[0].node_id}::uuid FOR UPDATE`;
    const scan = await tx.vulnScan.findUniqueOrThrow({ where: { id: scanId }, include: { node: { include: { group: true, systemType: true } } } });
    if (scan.node.deletedAt || scan.node.group.deletedAt) throw notFound('Скан');
    if (scan.legacyReportId) throw conflict('LEGACY_SCAN', 'Скан прежнего реестра не аннулируется');
    const blocker = await annulBlocker(tx, scan);
    if (blocker) throw conflict(blocker.code, blocker.message);
    const title = `Скан от ${formatDateRu(iso(scan.scanDate))}, файл «${scan.fileName}»`;
    const deletionId = await createDeletion(tx, actor, {
      entity: 'vuln_scan', entityId: scan.id, title, reasonCode: input.reason, reason: comment, counts: { findings: scan.findingsCount },
    });
    const why = [SCAN_REASON_LABELS[input.reason], comment].filter(Boolean).join(': ');
    await auditSettings(tx, actor, {
      action: 'vuln.scan.annulled', entity: 'vuln_scan', entityId: scan.id,
      summary: `Уязвимости, «${nodeLabel(scan.node)}»: аннулирован ${title.charAt(0).toLowerCase()}${title.slice(1)} — ${why}. Изменения реестра не откатывались`,
      after: { deletionId, nodeId: scan.nodeId, reasonCode: input.reason, reason: comment, findings: scan.findingsCount },
    });
    return { deletionId, annulled: await annulInfo(tx, scan.id) };
  });
}
