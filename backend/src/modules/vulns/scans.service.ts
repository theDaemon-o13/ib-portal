// Сканы узла и передача ИКТ (релиз 1.5.0, ADR-0029, ADR-0030). Скан не удаляется и не редактируется (триггер);
// передача — один раз. От неё начинается срок записей, которые встречались в скане после последнего открытия.
// Аннулированный скан (1.13.12, annul.service.ts) — не в списке по умолчанию, ИКТ не передаётся.
import type { Prisma } from '../../generated/prisma/client.js';
import { idChunks, updateRecordValues, type RecordValuesUpdate } from '../../lib/bulk.js';
import { BULK_TX, withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { calcValue, formatDateRu, isIsoDate, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { parseIsoDate } from '../../lib/working-days.js';
import { claimFiles } from '../files/links.js';
import { calendarFor, isClosed, loadRegister, loadUsers, searchTextOf, type RegisterDef } from '../registers/definition.js';
import { auditSettings, auditSettingsMany, trimmed, type Actor, type SettingsAuditEntry } from '../settings/common.js';
import { VULN_REGISTER_KEY, vulnFields, type VulnFields } from './definition.js';
import { annulBlocker, annulInfo, annulledScanIds } from './annul.service.js';
import { loadNode, nodeLabel } from './groups.service.js';

export const HANDOVER_TO_DEFAULT = 'ОИКТ';
const TO_MAX = 200;
const iso = (d: Date) => d.toISOString().slice(0, 10);

type ScanRow = Prisma.VulnScanGetPayload<{ include: { creator: { select: { fullName: true } }; handedBy: { select: { fullName: true } } } }>;

interface Counts { new: number; reopened: number; changed: number; unchanged: number; gone: number }

interface Comparison {
  counts?: Counts;
  critCounts?: { key: string; label: string; count: number }[];
  coverage?: { newHosts: string[]; goneHosts: string[] };
  groups?: Record<string, Record<string, unknown>[]>;
  archived?: Record<string, unknown>[];
  inFileDuplicates?: number;
  errorRows?: number;
  errors?: Record<string, unknown>[];
  notes?: Record<string, unknown>[];
  profileMismatch?: { fileProfile: { id: string; label: string } | null; nodeType: { id: string; label: string } | null; confirmedBy: string; confirmedAt: string } | null;
}

function scanBrief(s: ScanRow, annulled: ReadonlySet<string> = new Set()) {
  const cmp = (s.comparison ?? {}) as Comparison;
  return {
    annulled: annulled.has(s.id),
    id: s.id,
    nodeId: s.nodeId,
    scanDate: iso(s.scanDate),
    fileName: s.fileName,
    fileId: s.fileId,
    coverageTitle: s.coverageTitle,
    hostsCount: s.hostsCount,
    findingsCount: s.findingsCount,
    counts: cmp.counts ?? null,
    critCounts: cmp.critCounts ?? [],
    legacy: s.legacyReportId !== null,
    createdBy: s.creator.fullName,
    createdAt: s.createdAt.toISOString(),
    handover: s.handedOverOn
      ? { date: iso(s.handedOverOn), to: s.handedOverTo ?? '', fileId: s.handoverFileId, by: s.handedBy?.fullName ?? '', at: s.handedOverAt?.toISOString() ?? '' }
      : null,
  };
}

const withPeople = { creator: { select: { fullName: true } }, handedBy: { select: { fullName: true } } } as const;

/** Сканы узла, новые сверху. Аннулированные — только с withAnnulled («Показать аннулированные»), с отметкой. */
export async function listScans(db: Db, nodeId: string, opts: { withAnnulled?: boolean } = {}) {
  await loadNode(db, nodeId);
  const annulled = new Set(await annulledScanIds(db));
  const rows = await db.vulnScan.findMany({
    where: { nodeId, ...(opts.withAnnulled || !annulled.size ? {} : { id: { notIn: [...annulled] } }) },
    include: withPeople, orderBy: [{ scanDate: 'desc' }, { createdAt: 'desc' }],
  });
  return rows.map((r) => scanBrief(r, annulled));
}

export async function getScan(db: Db, id: string) {
  const s = await db.vulnScan.findUnique({
    where: { id },
    include: { ...withPeople, node: { include: { group: true, systemType: true } }, legacyReport: { include: { hosts: { orderBy: { sortOrder: 'asc' } } } }, previous: { select: { id: true, scanDate: true, fileName: true } } },
  });
  // Скан удалённого узла скрыт вместе с ним (1.6.1).
  if (!s || s.node.deletedAt || s.node.group.deletedAt) throw notFound('Скан');
  const cmp = (s.comparison ?? {}) as Comparison;
  const coverage = cmp.coverage ?? { newHosts: [], goneHosts: [] };
  const fresh = new Set(coverage.newHosts);
  // Хосты прежнего реестра лежат в scan_hosts и не копируются.
  const hosts = (s.legacyReport ? s.legacyReport.hosts.map((h) => ({ name: h.name, ip: h.ip, os: h.os })) : (s.hosts as unknown as { name: string; ip: string; os: string }[]))
    .map((h) => ({ ...h, status: fresh.has(h.name) ? 'new' as const : 'same' as const }));
  const annulled = await annulInfo(db, s.id);
  return {
    ...scanBrief(s, new Set(annulled ? [s.id] : [])),
    annulment: annulled,
    canAnnul: !s.legacyReportId && (await annulBlocker(db, s)) === null,
    node: { id: s.nodeId, label: nodeLabel(s.node) },
    previousScan: s.previous ? { id: s.previous.id, scanDate: iso(s.previous.scanDate), fileName: s.previous.fileName } : null,
    legacyArchived: s.legacyReport ? s.legacyReport.archivedAt !== null : false,
    hosts: [...hosts, ...coverage.goneHosts.map((name) => ({ name, ip: '', os: '', status: 'gone' as const }))],
    findings: s.findings as Record<string, unknown>[],
    comparison: s.comparison && !s.legacyReportId
      ? {
        groups: cmp.groups ?? {}, archived: cmp.archived ?? [], inFileDuplicates: cmp.inFileDuplicates ?? 0,
        errorRows: cmp.errorRows ?? 0, errors: cmp.errors ?? [], notes: cmp.notes ?? [], profileMismatch: cmp.profileMismatch ?? null,
      }
      : null,
  };
}

export interface HandoverInput {
  date: string;
  to?: string | null;
  fileId?: string | null;
}

async function vulnDef(db: Db): Promise<{ reg: RegisterDef; vf: VulnFields }> {
  const row = await db.register.findUniqueOrThrow({ where: { systemKey: VULN_REGISTER_KEY } });
  const reg = await loadRegister(db, row.id);
  return { reg, vf: vulnFields(reg) };
}

/**
 * Передача ИКТ. Срок начинается у открытых записей, которые встречались в этом скане в текущем цикле и у которых
 * он ещё не шёл: срок ведётся от первого переданного скана, поздняя передача более раннего его не сдвигает.
 * «Срок из прежнего реестра» остаётся базой — у таких записей передача ничего не меняет.
 */
export async function handOverScan(db: Db, actor: Actor, id: string, input: HandoverInput) {
  return withTx(db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM vuln_scans WHERE id = ${id}::uuid FOR UPDATE`;
    const scan = await tx.vulnScan.findUnique({ where: { id }, include: { node: { include: { group: true, systemType: true } } } });
    if (!scan || scan.node.deletedAt || scan.node.group.deletedAt) throw notFound('Скан');
    if ((await annulledScanIds(tx)).includes(id)) throw conflict('SCAN_ANNULLED', 'Скан аннулирован — передавать ИКТ нечего. Передайте более поздний скан узла');
    if (scan.handedOverOn) throw conflict('ALREADY_HANDED_OVER', `Скан уже передан ИКТ ${formatDateRu(iso(scan.handedOverOn))}. Повторная передача и правка даты не предусмотрены`);
    if (!isIsoDate(input.date)) throw badRequest('BAD_DATE', 'Дата передачи: неверная дата');
    const scanDate = iso(scan.scanDate);
    if (input.date < scanDate) throw badRequest('BAD_DATE', `Дата передачи не раньше даты скана (${formatDateRu(scanDate)})`);
    if (input.date > todayIso()) throw badRequest('BAD_DATE', 'Дата передачи не может быть позже сегодняшней');
    const to = trimmed(input.to ?? '') || HANDOVER_TO_DEFAULT;
    if (to.length > TO_MAX) throw badRequest('BAD_TO', `«Кому» — не длиннее ${TO_MAX} символов`);
    if (input.fileId) await claimFiles(tx, actor.id, [input.fileId]);

    await tx.vulnScan.update({
      where: { id },
      data: { handedOverOn: parseIsoDate(input.date), handedOverTo: to, handoverFileId: input.fileId ?? null, handedOverBy: actor.id, handedOverAt: new Date() },
    });

    const { reg, vf } = await vulnDef(tx);
    const candidates = await tx.$queryRaw<{ id: string; number: number; values: Values }[]>`
      SELECT r.id::text, r.number, r."values"
      FROM vuln_record_scans rs
      JOIN vuln_records v ON v.record_id = rs.record_id AND v.cycle = rs.cycle
      JOIN register_records r ON r.id = rs.record_id
      WHERE rs.scan_id = ${id}::uuid AND rs.outcome <> 'fixed' AND v.deadline_scan_id IS NULL AND r.deleted_at IS NULL AND r.archived_at IS NULL
      ORDER BY r.number
      FOR UPDATE OF r, v`;
    const calendar = await calendarFor(tx, reg);
    const users = await loadUsers(tx);
    const rule = vf.due.calcRule;
    let keptLegacy = 0;
    // Пачками (1.13.9): значения, связь со сканом срока и журнал — число запросов от числа пачек, не записей.
    const updates: RecordValuesUpdate[] = [];
    const audits: SettingsAuditEntry[] = [];
    for (const r of candidates) {
      if (isClosed(reg, r.values)) continue;
      if (r.values[vf.legacyDue.id] !== undefined) {
        keptLegacy++;
        continue;
      }
      const values: Values = { ...r.values, [vf.notified.id]: input.date };
      const due = rule ? calcValue(rule, values, { fields: reg.fields, calendar }) : null;
      updates.push({ id: r.id, values, searchText: searchTextOf(reg, r.number, values, users) });
      audits.push({
        action: 'register_record.updated', entity: 'register_record', entityId: r.id,
        summary: `«${reg.name}», запись #${r.number}: отчёт передан ИКТ ${formatDateRu(input.date)}, срок по процедуре: ${typeof due === 'string' ? formatDateRu(due) : 'не определён'}`,
        after: { changes: [{ fieldId: vf.notified.id, label: vf.notified.label, from: '', to: formatDateRu(input.date) }], via: 'handover', scanId: id },
      });
    }
    await updateRecordValues(tx, updates);
    for (const ids of idChunks(updates.map((u) => u.id))) {
      await tx.$executeRaw`UPDATE vuln_records SET deadline_scan_id = ${id}::uuid, version = version + 1, updated_at = now() WHERE record_id = ANY(${ids}::uuid[])`;
    }
    await auditSettingsMany(tx, actor, audits);
    const started = updates.length;
    await auditSettings(tx, actor, {
      action: 'vuln.scan.handed_over', entity: 'vuln_scan', entityId: id,
      summary: `Уязвимости, «${nodeLabel(scan.node)}»: скан от ${formatDateRu(scanDate)} передан ИКТ ${formatDateRu(input.date)} (${to}) — срок начался у записей: ${started}`,
      after: { date: input.date, to, fileId: input.fileId ?? null, started, keptLegacy },
    });
    return { started, keptLegacy, registerId: reg.id };
  }, BULK_TX);
}
