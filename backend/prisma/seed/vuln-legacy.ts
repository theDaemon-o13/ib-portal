// Релиз 1.5.0 (ADR-0029, ADR-0030): записи и отчёты реестра уязвимостей без узла — в «Без группы / Из прежнего
// реестра». Выполняется при каждом migrate и берёт только то, чего в разделе ещё нет: при первом обновлении — весь
// прежний реестр, после отката на 1.1.0–1.4.0 и повторного обновления — созданное старой версией. Ничего не удаляет.
// «Срок из прежнего реестра» — срок по процедуре на момент переноса (без решения п. 7.3) и пишется только в это
// новое поле и только если оно пустое; остальные значения записей не меняются.
import type { Prisma } from '../../src/generated/prisma/client.js';
import { calcValue, isDueRule, type Values } from '../../src/lib/register-values.js';
import { calendarFor, isClosed, loadRegister, loadUsers, searchTextOf, userIdsIn } from '../../src/modules/registers/definition.js';
import { VULN_REGISTER_KEY, vulnFields } from '../../src/modules/vulns/definition.js';
import { legacyNode } from '../../src/modules/vulns/groups.service.js';
import { dupKey } from '../../src/modules/vulns/scan-parser.js';

type Tx = Prisma.TransactionClient;

const BATCH = 1000;

export interface LegacySummary {
  records: number;
  /** Не закрыты статусом и не в архиве — как в предпроверке deploy/prechecks/1.5.0.md. */
  open: number;
  withDue: number;
  withoutDue: number;
  deleted: number;
  reports: number;
  hosts: number;
  archivedReports: number;
  duplicateKeys: number;
}

export async function seedVulnLegacy(tx: Tx): Promise<LegacySummary | null> {
  const row = await tx.register.findUnique({ where: { systemKey: VULN_REGISTER_KEY } });
  if (!row) return null;
  const node = await legacyNode(tx);
  const reg = await loadRegister(tx, row.id);
  const vf = vulnFields(reg);
  const sum: LegacySummary = { records: 0, open: 0, withDue: 0, withoutDue: 0, deleted: 0, reports: 0, hosts: 0, archivedReports: 0, duplicateKeys: 0 };

  // Отчёты прежнего реестра — сканы узла «Из прежнего реестра»: переданы ИКТ в дату «Уведомлено ДИКТ».
  const reports = await tx.$queryRaw<{ id: string; label: string; file_name: string; file_sha256: string; report_date: Date; notified_date: Date; department: string;
    rows_total: number; hosts_count: number; created_by: string; created_at: Date; archived_at: Date | null }[]>`
    SELECT s.id::text, s.label, s.file_name, s.file_sha256, s.report_date, s.notified_date, s.department, s.rows_total, s.hosts_count,
           s.created_by::text, s.created_at, s.archived_at
    FROM scan_reports s LEFT JOIN vuln_scans v ON v.legacy_report_id = s.id
    WHERE s.register_id = ${row.id}::uuid AND v.id IS NULL ORDER BY s.report_date, s.created_at`;
  for (const r of reports) {
    await tx.vulnScan.create({
      data: {
        nodeId: node.id, legacyReportId: r.id, fileName: r.file_name, fileSha256: r.file_sha256, scanDate: r.report_date,
        coverageTitle: r.department, hostsCount: r.hosts_count, findingsCount: r.rows_total, createdBy: r.created_by, createdAt: r.created_at,
        // До 1.5.0 импорт не пускал дату передачи раньше даты отчёта; на всякий случай — не раньше неё.
        handedOverOn: r.notified_date < r.report_date ? r.report_date : r.notified_date, handedOverTo: 'ДИКТ', handedOverBy: r.created_by, handedOverAt: r.created_at,
        comparison: { legacy: true, label: r.label } as Prisma.InputJsonValue,
      },
    });
    sum.reports++;
    sum.hosts += r.hosts_count;
    if (r.archived_at) sum.archivedReports++;
  }
  // Запись прежнего реестра → скан её отчёта (по значению «Отчёт сканирования»).
  const scans = await tx.vulnScan.findMany({ where: { nodeId: node.id, legacyReportId: { not: null } }, select: { id: true, comparison: true } });
  const scanByLabel = new Map(scans.map((s) => [(s.comparison as { label?: string } | null)?.label ?? '', s.id]));

  const records = await tx.$queryRaw<{ id: string; number: number; values: Values; deleted_at: Date | null; archived_at: Date | null }[]>`
    SELECT r.id::text, r.number, r."values", r.deleted_at, r.archived_at
    FROM register_records r LEFT JOIN vuln_records v ON v.record_id = r.id
    WHERE r.register_id = ${row.id}::uuid AND v.record_id IS NULL ORDER BY r.number`;
  // Срок по процедуре без решения п. 7.3 и без прибавок: «передача ИКТ + дни по Критичности», перенос на рабочий день.
  const rule = vf.due.calcRule;
  if (!isDueRule(rule)) throw new Error('у поля «Срок устранения» нет правила срока');
  const baseRule = { ...rule, overrideFieldId: null, overrideWhenFilledFieldId: null, baseFieldId: null, addDaysFieldId: null };
  const calendar = await calendarFor(tx, reg);
  const users = await loadUsers(tx, userIdsIn(reg, records.map((r) => r.values ?? {})));
  const keys = new Map<string, number>();
  const nodeRows: Prisma.VulnRecordCreateManyInput[] = [];
  const seenRows: Prisma.VulnRecordScanCreateManyInput[] = [];
  const audits: Prisma.AuditLogCreateManyInput[] = [];
  for (const r of records) {
    const values = r.values ?? {};
    const reportLabel = vf.report.options.find((o) => o.id === values[vf.report.id])?.label;
    const scanId = reportLabel ? scanByLabel.get(reportLabel) ?? null : null;
    nodeRows.push({ recordId: r.id, nodeId: node.id, legacy: true, firstScanId: scanId, lastScanId: scanId });
    if (scanId) seenRows.push({ recordId: r.id, scanId, outcome: 'legacy', cycle: 1 });
    sum.records++;
    if (r.deleted_at) {
      sum.deleted++;
      continue;
    }
    if (!r.archived_at && !isClosed(reg, values)) sum.open++;
    const pkg = vf.pkg.options.find((o) => o.id === values[vf.pkg.id])?.label;
    const cve = values[vf.cve.id];
    if (pkg && typeof cve === 'string') {
      const k = dupKey(cve, pkg);
      keys.set(k, (keys.get(k) ?? 0) + 1);
    }
    const already = values[vf.legacyDue.id];
    const due = typeof already === 'string' ? already : calcValue(baseRule, values, { fields: reg.fields, calendar });
    if (typeof due !== 'string') {
      sum.withoutDue++;
      continue;
    }
    sum.withDue++;
    if (typeof already === 'string') continue;
    const after: Values = { ...values, [vf.legacyDue.id]: due };
    await tx.registerRecord.update({
      where: { id: r.id },
      data: { values: after as Prisma.InputJsonValue, searchText: searchTextOf(reg, r.number, after, users), version: { increment: 1 } },
    });
    const shown = `${due.slice(8, 10)}.${due.slice(5, 7)}.${due.slice(0, 4)}`;
    audits.push({
      userId: null, action: 'register_record.updated', entity: 'register_record', entityId: r.id,
      diff: {
        summary: `«${reg.name}», запись #${r.number}: «${vf.legacyDue.label}» — ${shown} (обновление 1.5.0, «Без группы»)`,
        after: { changes: [{ fieldId: vf.legacyDue.id, label: vf.legacyDue.label, from: '', to: shown }], via: 'seed' },
      } as Prisma.InputJsonValue,
    });
  }
  // Пакетами: прежний реестр бывает в десятки тысяч записей, а seed — одна транзакция.
  for (let i = 0; i < nodeRows.length; i += BATCH) await tx.vulnRecord.createMany({ data: nodeRows.slice(i, i + BATCH) });
  for (let i = 0; i < seenRows.length; i += BATCH) await tx.vulnRecordScan.createMany({ data: seenRows.slice(i, i + BATCH) });
  for (let i = 0; i < audits.length; i += BATCH) await tx.auditLog.createMany({ data: audits.slice(i, i + BATCH) });
  const written = audits.length;
  sum.duplicateKeys = [...keys.values()].filter((n) => n > 1).length;
  if (sum.records || sum.reports) {
    await tx.auditLog.create({
      data: {
        userId: null, action: 'vuln.legacy.moved', entity: 'vuln_node', entityId: node.id,
        diff: { summary: `Seed 1.5.0: в «Без группы / Из прежнего реестра» — ${describe(sum)}; «Срок из прежнего реестра» записан у ${written}`, after: { ...sum, written } } as Prisma.InputJsonValue,
      },
    });
  }
  console.log(`Без группы: ${describe(sum)}`);
  return sum;
}

function describe(s: LegacySummary): string {
  return `записей ${s.records} (открытых ${s.open}, со сроком ${s.withDue}, без срока ${s.withoutDue}, удалённых ${s.deleted}), `
    + `отчётов прежнего реестра ${s.reports} (хостов ${s.hosts}, в архиве ${s.archivedReports}), повторов ключа ${s.duplicateKeys}`;
}
