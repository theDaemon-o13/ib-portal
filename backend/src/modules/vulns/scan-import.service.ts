// Импорт отчёта сканера в реестр уязвимостей (CLAUDE.md, раздел 7, правило 6).
// Как обычный импорт — в два шага: предпросмотр ничего не меняет, применение — одна транзакция.
// Дубли: открытая запись с той же парой «CVE + пакет» не создаётся заново, «Обнаружений» — по максимуму.
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { formatDateRu, isIsoDate, type Values } from '../../lib/register-values.js';
import { critKeyOf, fixKeyFromText, vulnScore, type CritKey } from '../../lib/vuln-score.js';
import { parseIsoDate } from '../../lib/working-days.js';
import { IMPORT_TTL_MS } from '../registers/excel.service.js';
import { assertNotArchived, isClosed, loadRegister, searchTextOf, type FieldMeta, type RegisterDef } from '../registers/definition.js';
import { nextNumbers } from '../registers/records.service.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { CRIT_LABELS, isVulnRegister, optionByKey, vulnFields, type VulnFields } from './definition.js';
import { applyDerived } from './derive.js';
import { dupKey, parseScanReport, SCAN_HEADERS, type ScanHostRow, type ScanIssue, type ScanRow } from './scan-parser.js';

const MAX_LIST = 500;

/** Тексты сканера → системные ключи значений: так множитель находится, даже если значение переименовали. */
const OPTION_ALIASES: Partial<Record<keyof VulnFields, Record<string, string>>> = {
  exploit: { 'есть, эксплуатируется': 'exploited', есть: 'exists', нет: 'none', 'нет данных': 'nodata' },
  vector: { 'удалённо (сеть)': 'remote', 'удаленно (сеть)': 'remote', локально: 'local' },
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface ScanSummary {
  fileName: string;
  sheet: string;
  department: string;
  reportDate: string | null;
  rows: number;
  created: number;
  merged: number;
  mergedChanged: number;
  inFileDuplicates: number;
  errorRows: number;
  hostsCount: number;
  hosts: ScanHostRow[];
  critCounts: { key: CritKey; label: string; count: number }[];
  newOptions: { field: string; values: string[] }[];
  duplicates: { row: number; cve: string; pkg: string; recordId: string; number: number; hitsBefore: number | null; hitsAfter: number | null }[];
  items: { row: number; cve: string; pkg: string; cvss: number | null; score: number | null; crit: string }[];
  errors: ScanIssue[];
  warnings: string[];
}

interface ScanPayload {
  creates: ScanRow[];
  merges: { row: number; recordId: string; number: number; version: number; hits: number | null }[];
  hosts: ScanHostRow[];
  department: string;
  fieldVersions: Record<string, number>;
}

/** Существующее значение списка по системному ключу (через синонимы) или по подписи, без учёта регистра. */
function findOption(vf: VulnFields, key: keyof VulnFields, label: string): FieldMeta['options'][number] | undefined {
  const field = vf[key];
  const sys = OPTION_ALIASES[key]?.[norm(label)];
  if (sys) {
    const bySys = field.options.find((o) => o.systemKey === sys);
    if (bySys) return bySys;
  }
  return field.options.find((o) => norm(o.label) === norm(label));
}

/** Открытые записи реестра по ключу «CVE + пакет» (закрытые, архивные и удалённые не считаются). */
async function openByKey(db: Db, reg: RegisterDef, vf: VulnFields, exceptIds: readonly string[] = []) {
  const rows = await db.registerRecord.findMany({
    where: { registerId: reg.id, deletedAt: null, archivedAt: null, ...(exceptIds.length ? { id: { notIn: [...exceptIds] } } : {}) },
    select: { id: true, number: true, version: true, values: true },
    orderBy: { number: 'asc' },
  });
  const map = new Map<string, { id: string; number: number; version: number; values: Values }>();
  for (const r of rows) {
    const values = r.values as Values;
    if (isClosed(reg, values)) continue;
    const cve = values[vf.cve.id];
    const pkg = vf.pkg.options.find((o) => o.id === values[vf.pkg.id])?.label;
    if (typeof cve !== 'string' || !pkg) continue;
    const key = dupKey(cve, pkg);
    if (!map.has(key)) map.set(key, { id: r.id, number: r.number, version: r.version, values });
  }
  return map;
}

async function vulnRegister(db: Db, registerId: string) {
  const reg = await loadRegister(db, registerId);
  if (!isVulnRegister(reg)) throw badRequest('NOT_VULN_REGISTER', 'Отчёт сканера загружается только в реестр уязвимостей');
  assertNotArchived(reg);
  return { reg, vf: vulnFields(reg) };
}

// ---------------------------------------------------------------- предпросмотр

export async function previewScan(db: Db, actor: Actor, registerId: string, buffer: Buffer, fileName: string) {
  const { reg, vf } = await vulnRegister(db, registerId);
  const parsed = await parseScanReport(buffer, fileName);

  // Дубли внутри файла: первая строка остаётся, «Обнаружений» — максимум.
  const unique = new Map<string, ScanRow>();
  let inFileDuplicates = 0;
  for (const r of parsed.rows) {
    const key = dupKey(r.cve, r.pkg);
    const first = unique.get(key);
    if (!first) {
      unique.set(key, { ...r });
      continue;
    }
    inFileDuplicates++;
    if (r.hits !== null && (first.hits === null || r.hits > first.hits)) first.hits = r.hits;
  }

  const open = await openByKey(db, reg, vf);
  const payload: ScanPayload = {
    creates: [], merges: [], hosts: parsed.hosts, department: parsed.department,
    fieldVersions: Object.fromEntries(reg.fields.map((f) => [f.id, f.version])),
  };
  const summary: ScanSummary = {
    fileName, sheet: parsed.sheet, department: parsed.department, reportDate: parsed.reportDate,
    rows: parsed.rows.length + new Set(parsed.errors.map((e) => e.row)).size,
    created: 0, merged: 0, mergedChanged: 0, inFileDuplicates,
    errorRows: new Set(parsed.errors.map((e) => e.row)).size,
    hostsCount: parsed.hosts.length, hosts: parsed.hosts.slice(0, 1000),
    critCounts: [], newOptions: [], duplicates: [], items: [],
    errors: parsed.errors.slice(0, MAX_LIST), warnings: [...parsed.warnings],
  };
  const critCounts = new Map<CritKey, number>();
  const newLabels = new Map<keyof VulnFields, Set<string>>();
  const noteNew = (key: keyof VulnFields, label: string | null) => {
    if (!label || findOption(vf, key, label)) return;
    const set = newLabels.get(key) ?? new Set<string>();
    if (![...set].some((l) => norm(l) === norm(label))) set.add(label);
    newLabels.set(key, set);
  };

  for (const r of unique.values()) {
    const rec = open.get(dupKey(r.cve, r.pkg));
    if (rec) {
      const before = rec.values[vf.hits.id];
      const hitsBefore = typeof before === 'number' ? before : null;
      const hitsAfter = r.hits === null ? hitsBefore : Math.max(hitsBefore ?? 0, r.hits);
      summary.merged++;
      if (hitsAfter !== hitsBefore) summary.mergedChanged++;
      payload.merges.push({ row: r.row, recordId: rec.id, number: rec.number, version: rec.version, hits: hitsAfter });
      if (summary.duplicates.length < MAX_LIST) {
        summary.duplicates.push({ row: r.row, cve: r.cve, pkg: r.pkg, recordId: rec.id, number: rec.number, hitsBefore, hitsAfter });
      }
      continue;
    }
    payload.creates.push(r);
    summary.created++;
    noteNew('pkg', r.pkg);
    noteNew('level', r.level);
    noteNew('exploit', r.exploit);
    noteNew('vector', r.vector);
    const exploitKey = r.exploit ? findOption(vf, 'exploit', r.exploit)?.systemKey ?? null : null;
    const score = vulnScore(r.cvss, exploitKey, fixKeyFromText(r.fixVersion));
    const crit = critKeyOf(score);
    critCounts.set(crit, (critCounts.get(crit) ?? 0) + 1);
    if (summary.items.length < MAX_LIST) {
      const label = vf.crit.options.find((o) => o.systemKey === crit)?.label ?? CRIT_LABELS[crit];
      summary.items.push({ row: r.row, cve: r.cve, pkg: r.pkg, cvss: r.cvss, score, crit: label });
    }
  }
  summary.critCounts = (['critical', 'high', 'medium', 'low'] as const)
    .filter((k) => critCounts.has(k))
    .map((k) => ({ key: k, label: vf.crit.options.find((o) => o.systemKey === k)?.label ?? CRIT_LABELS[k], count: critCounts.get(k) ?? 0 }));
  summary.newOptions = [...newLabels.entries()].map(([k, set]) => ({ field: vf[k].label, values: [...set] }));
  if (!parsed.reportDate) summary.warnings.push('В имени файла нет даты отчёта (ГГГГ-ММ-ДД) — укажите её перед применением');
  if (summary.errorRows > summary.errors.length) summary.warnings.push(`Показаны первые ${summary.errors.length} ошибок`);

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const imp = await withTx(db, async (tx) => {
    const created = await tx.registerImport.create({
      data: {
        registerId: reg.id,
        kind: 'scan',
        fileName: fileName.slice(0, 255),
        fileSha256: sha256,
        summary: summary as unknown as Prisma.InputJsonValue,
        payload: payload as unknown as Prisma.InputJsonValue,
        createdBy: actor.id,
        expiresAt: new Date(Date.now() + IMPORT_TTL_MS),
      },
    });
    await auditSettings(tx, actor, {
      action: 'register.scan.previewed', entity: 'register_import', entityId: created.id,
      summary: `«${reg.name}»: предпросмотр отчёта сканера «${fileName}» — новых ${summary.created}, дублей ${summary.merged}, строк с ошибками ${summary.errorRows}`,
      after: { fileName, sha256, created: summary.created, merged: summary.merged, errorRows: summary.errorRows, hosts: summary.hostsCount },
    });
    return created;
  });
  return { id: imp.id, status: imp.status, expiresAt: imp.expiresAt.toISOString(), summary };
}

export async function getScanImport(db: Db, id: string) {
  const imp = await db.registerImport.findUnique({ where: { id } });
  if (!imp || imp.kind !== 'scan') throw notFound('Импорт');
  const status = imp.status === 'preview' && imp.expiresAt < new Date() ? 'expired' : imp.status;
  return { id: imp.id, registerId: imp.registerId, status, expiresAt: imp.expiresAt.toISOString(), summary: imp.summary as unknown as ScanSummary };
}

// ---------------------------------------------------------------- применение

export interface ApplyScanInput {
  /** Дата отчёта: обязательна, если её нет в имени файла. */
  reportDate?: string | null;
  /** Дата передачи отчёта в ДИКТ — от неё считается срок (п. 7.2). По умолчанию — дата отчёта. */
  notifiedDate?: string | null;
}

function checkDate(v: string, what: string): string {
  if (!isIsoDate(v)) throw badRequest('BAD_DATE', `${what}: неверная дата`);
  return v;
}

export async function applyScan(db: Db, actor: Actor, importId: string, input: ApplyScanInput) {
  return withTx(db, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM register_imports WHERE id = ${importId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound('Импорт');
    const imp = await tx.registerImport.findUniqueOrThrow({ where: { id: importId } });
    if (imp.kind !== 'scan') throw notFound('Импорт');
    if (imp.createdBy !== actor.id) throw new AppError(403, 'IMPORT_OTHER_USER', 'Применить импорт может только тот, кто загрузил файл');
    if (imp.status !== 'preview') throw conflict('IMPORT_NOT_PENDING', 'Этот импорт уже применён или отменён');
    if (imp.expiresAt < new Date()) {
      await tx.registerImport.update({ where: { id: importId }, data: { status: 'expired' } });
      throw conflict('IMPORT_EXPIRED', 'Предпросмотр устарел (30 минут). Загрузите файл снова');
    }
    const summary = imp.summary as unknown as ScanSummary;
    const payload = imp.payload as unknown as ScanPayload;
    const rawReport = input.reportDate ?? summary.reportDate;
    if (!rawReport) throw badRequest('REPORT_DATE_REQUIRED', 'Укажите дату отчёта: в имени файла её нет');
    const reportDate = checkDate(rawReport, 'Дата отчёта');
    const notifiedDate = checkDate(input.notifiedDate ?? reportDate, 'Дата передачи в ДИКТ');
    if (notifiedDate < reportDate) throw badRequest('BAD_DATE', 'Отчёт не мог быть передан в ДИКТ раньше, чем составлен');

    const { reg, vf } = await vulnRegister(tx, imp.registerId);
    for (const [fieldId, version] of Object.entries(payload.fieldVersions)) {
      const f = reg.fields.find((x) => x.id === fieldId);
      if (!f || f.version !== version || f.archived) throw conflict('IMPORT_STALE', 'После предпросмотра изменились поля реестра. Повторите предпросмотр');
    }

    // Дубли: записи не изменились и всё ещё открыты.
    const mergeIds = payload.merges.map((m) => m.recordId);
    const current = mergeIds.length
      ? await tx.$queryRaw<{ id: string; number: number; values: Values; version: number; archived_at: Date | null; deleted_at: Date | null }[]>`
          SELECT id, number, "values", version, archived_at, deleted_at FROM register_records WHERE id = ANY(${mergeIds}::uuid[]) FOR UPDATE`
      : [];
    const byId = new Map(current.map((r) => [r.id, r]));
    const stale = payload.merges.filter((m) => {
      const r = byId.get(m.recordId);
      return !r || r.version !== m.version || r.deleted_at !== null || r.archived_at !== null;
    });
    if (stale.length) {
      throw conflict('IMPORT_STALE', `После предпросмотра изменились записи (${stale.map((s) => s.number).slice(0, 10).join(', ')}${stale.length > 10 ? '…' : ''}). Повторите предпросмотр`);
    }
    // Новые записи: пока смотрели предпросмотр, такую же пару «CVE + пакет» могли завести вручную.
    const openNow = await openByKey(tx, reg, vf, mergeIds);
    const appeared = payload.creates.filter((c) => openNow.has(dupKey(c.cve, c.pkg)));
    if (appeared.length) {
      throw conflict('IMPORT_STALE', `После предпросмотра появились записи с теми же «CVE + пакет» (${appeared.slice(0, 5).map((c) => c.cve).join(', ')}). Повторите предпросмотр`);
    }

    // Значения списков: недостающие пакеты, уровни и т. п. добавляются в реестр.
    const createdOptions: string[] = [];
    const optionId = async (key: keyof VulnFields, label: string | null): Promise<string | null> => {
      if (!label) return null;
      const field = vf[key];
      const found = findOption(vf, key, label);
      if (found) return found.id;
      const max = await tx.registerFieldOption.aggregate({ where: { fieldId: field.id }, _max: { sortOrder: true } });
      const o = await tx.registerFieldOption.create({ data: { fieldId: field.id, label: label.slice(0, 200), sortOrder: (max._max.sortOrder ?? 0) + 1 } });
      field.options.push({ id: o.id, label: o.label, isClosed: false, archived: false, sortOrder: o.sortOrder, version: o.version, systemKey: null });
      createdOptions.push(`${field.label}: «${o.label}»`);
      return o.id;
    };
    // Подпись отчёта уникальна в списке «Отчёт сканирования»: повторная загрузка того же дня получает номер.
    const base = `${payload.department || 'Отчёт сканера'} · ${formatDateRu(reportDate)}`;
    let label = base;
    for (let n = 2; vf.report.options.some((o) => norm(o.label) === norm(label)); n++) label = `${base} (${n})`;
    const reportOption = await optionId('report', label);

    const statusOpen = optionByKey(vf.status, 'open');
    const noUsers = new Map();
    let number = payload.creates.length ? await nextNumbers(tx, reg.id, payload.creates.length) : 0;
    for (const c of payload.creates) {
      const raw: Values = { [vf.cve.id]: c.cve, [vf.notified.id]: notifiedDate, [vf.status.id]: statusOpen };
      const set = (f: FieldMeta, v: string | number | null) => {
        if (v !== null) raw[f.id] = v;
      };
      set(vf.pkg, await optionId('pkg', c.pkg));
      set(vf.level, await optionId('level', c.level));
      set(vf.cvss, c.cvss);
      set(vf.exploit, await optionId('exploit', c.exploit));
      set(vf.vector, await optionId('vector', c.vector));
      set(vf.fix, optionByKey(vf.fix, fixKeyFromText(c.fixVersion)));
      set(vf.fixVersion, c.fixVersion);
      set(vf.desc, c.desc);
      set(vf.hits, c.hits);
      set(vf.report, reportOption);
      // Критичность в отчёте не приходит — считается по Оценке.
      const { values } = applyDerived(reg, { before: {}, after: raw, manual: [], edited: Object.keys(raw), isNew: true });
      const rec = await tx.registerRecord.create({
        data: { registerId: reg.id, number, values: values as Prisma.InputJsonValue, searchText: searchTextOf(reg, number, values, noUsers) },
      });
      await auditSettings(tx, actor, {
        action: 'register_record.created', entity: 'register_record', entityId: rec.id,
        summary: `«${reg.name}»: создана запись #${number} из отчёта сканера «${summary.fileName}»`,
        after: { registerId: reg.id, number, via: 'scan_import', importId, row: c.row },
      });
      number++;
    }

    let updated = 0;
    for (const m of payload.merges) {
      const r = byId.get(m.recordId);
      if (!r) continue;
      const before = r.values[vf.hits.id];
      if (m.hits === null || before === m.hits) continue;
      const values: Values = { ...r.values, [vf.hits.id]: m.hits };
      await tx.registerRecord.update({
        where: { id: r.id },
        data: { values: values as Prisma.InputJsonValue, searchText: searchTextOf(reg, r.number, values, noUsers), version: { increment: 1 } },
      });
      updated++;
      await auditSettings(tx, actor, {
        action: 'register_record.updated', entity: 'register_record', entityId: r.id,
        summary: `«${reg.name}», запись #${r.number}: повторно в отчёте сканера «${summary.fileName}»`,
        after: {
          changes: [{ fieldId: vf.hits.id, label: vf.hits.label, from: before === undefined ? '' : String(before), to: String(m.hits) }],
          via: 'scan_import', importId,
        },
      });
    }

    const report = await tx.scanReport.create({
      data: {
        registerId: reg.id, importId, fileName: summary.fileName, fileSha256: imp.fileSha256,
        reportDate: parseIsoDate(reportDate), notifiedDate: parseIsoDate(notifiedDate),
        department: payload.department, label,
        rowsTotal: summary.rows, createdCount: payload.creates.length, mergedCount: payload.merges.length, hostsCount: payload.hosts.length,
        createdBy: actor.id,
        hosts: { create: payload.hosts.map((h, i) => ({ sortOrder: i + 1, name: h.name, ip: h.ip, os: h.os })) },
      },
    });
    await tx.registerImport.update({ where: { id: importId }, data: { status: 'applied', appliedAt: new Date() } });
    await auditSettings(tx, actor, {
      action: 'register.scan.applied', entity: 'scan_report', entityId: report.id,
      summary: `«${reg.name}»: загружен отчёт сканера «${summary.fileName}» (${label}) — новых ${payload.creates.length}, дублей ${payload.merges.length}, обновлено «${vf.hits.label}» ${updated}, хостов ${payload.hosts.length}`,
      after: {
        fileName: summary.fileName, sha256: imp.fileSha256, reportDate, notifiedDate, created: payload.creates.length,
        merged: payload.merges.length, updated, hosts: payload.hosts.length, newOptions: createdOptions,
      },
    });
    return { reportId: report.id, label, created: payload.creates.length, merged: payload.merges.length, updated, skipped: summary.errorRows };
  });
}

// ---------------------------------------------------------------- отчёты

export async function listScanReports(db: Db, registerId: string, opts: { includeArchived: boolean }) {
  await loadRegister(db, registerId);
  const rows = await db.scanReport.findMany({
    where: { registerId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    include: { hosts: { orderBy: { sortOrder: 'asc' } }, author: { select: { fullName: true } } },
    orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    fileName: r.fileName,
    department: r.department,
    reportDate: r.reportDate.toISOString().slice(0, 10),
    notifiedDate: r.notifiedDate.toISOString().slice(0, 10),
    rowsTotal: r.rowsTotal,
    createdCount: r.createdCount,
    mergedCount: r.mergedCount,
    hostsCount: r.hostsCount,
    createdBy: r.author.fullName,
    createdAt: r.createdAt.toISOString(),
    archived: r.archivedAt !== null,
    hosts: r.hosts.map((h) => ({ name: h.name, ip: h.ip, os: h.os })),
  }));
}

/** Отчёт уходит в архив вместе с историей: записи реестра остаются как есть. */
export async function setScanReportArchived(db: Db, actor: Actor, id: string, archived: boolean) {
  await withTx(db, async (tx) => {
    const r = await tx.scanReport.findUnique({ where: { id } });
    if (!r) throw notFound('Отчёт сканера');
    if ((r.archivedAt !== null) === archived) return;
    await tx.scanReport.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
    await auditSettings(tx, actor, {
      action: archived ? 'register.scan.archived' : 'register.scan.restored', entity: 'scan_report', entityId: id,
      summary: `Отчёт сканера «${r.label}» ${archived ? 'отправлен в архив' : 'возвращён из архива'}`,
    });
  });
}

export { SCAN_HEADERS };
