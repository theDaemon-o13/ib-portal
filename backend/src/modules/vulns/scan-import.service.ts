// Импорт скана в узел (релиз 1.5.0, ADR-0029; CLAUDE.md, раздел 7, правило 6). Два шага: предпросмотр сравнивает
// файл с реестром узла и ничего не меняет в записях, применение — выбранное, одной транзакцией.
// Пять групп: новые, повторно обнаружены, изменились, без изменений, пропали. Ключ — «Пакет + Идентификатор».
// Импорт срок не запускает: «Уведомлено ДИКТ» ставит передача скана ИКТ (ADR-0030).
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import type { FileStore } from '../../lib/file-store.js';
import { formatDateRu, isIsoDate, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { critKeyOf, fixKeyFromText, vulnScore, type CritKey } from '../../lib/vuln-score.js';
import { parseIsoDate, type WorkCalendar } from '../../lib/working-days.js';
import { uploadFile } from '../files/service.js';
import { IMPORT_TTL_MS } from '../registers/excel.service.js';
import { assertNotArchived, calendarFor, dateOf, isClosed, loadRegister, loadUsers, searchTextOf, type FieldMeta, type RegisterDef } from '../registers/definition.js';
import { describeChanges, nextNumbers } from '../registers/records.service.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { CRIT_LABELS, optionByKey, VULN_REGISTER_KEY, vulnFields, type VulnFields } from './definition.js';
import { applyDerived } from './derive.js';
import { reasonText, vulnKeyOf } from '../trash/service.js';
import { checkNewNode, loadNode, nodeLabel } from './groups.service.js';
import { keyNorm } from './keys.js';
import { detectFileProfile, type ProfileType } from './profiles.js';
import { deptKey, mergeDuplicates, norm, parseScanReport, type ScanHostRow, type ScanIssue, type ScanRow } from './scan-parser.js';

const MAX_LIST = 500;

/** Тексты сканера → системные ключи значений: так множитель находится, даже если значение переименовали. */
const OPTION_ALIASES: Partial<Record<keyof VulnFields, Record<string, string>>> = {
  exploit: { 'есть, эксплуатируется': 'exploited', есть: 'exists', нет: 'none', 'нет данных': 'nodata' },
  vector: { 'удалённо (сеть)': 'remote', 'удаленно (сеть)': 'remote', локально: 'local' },
};

/** Списки, значения которых сравниваются со строкой файла. */
type OptionKey = 'level' | 'exploit' | 'vector';
const OPTION_KEYS: readonly OptionKey[] = ['level', 'exploit', 'vector'];

/** deleted — ключ записи, удалённой в этом узле (1.6.1): по умолчанию не выбрана, выбор заводит новую запись. */
export type ScanGroup = 'new' | 'reopened' | 'changed' | 'unchanged' | 'deleted';

export interface ScanFieldChange {
  fieldId: string;
  label: string;
  from: string;
  to: string;
}

export interface ScanItem {
  key: string;
  sheet: string;
  row: number;
  recordId: string | null;
  number: number | null;
  pkg: string;
  cve: string;
  cvss: number | null;
  score: number | null;
  /** Критичность, посчитанная по строке файла (п. 7.1). */
  crit: string;
  /** «Изменились», «Повторно»: поля «было → стало». */
  changes: ScanFieldChange[];
  dueBefore: string | null;
  dueAfter: string | null;
  /** Изменение делает открытую запись просроченной. */
  becomesOverdue: boolean;
  /** Запись закрыта не как «Устранена» («Риск принят»): не открывается, поля обновляются. */
  closedStatus: string | null;
  /** «Была удалена»: номер удалённой записи, причина и дата удаления. */
  deleted?: { number: number; reason: string; deletedAt: string } | null;
}

export interface ScanGoneItem {
  key: string;
  recordId: string;
  number: number;
  pkg: string;
  cve: string;
  crit: string;
  status: string;
  due: string | null;
}

export interface ScanSummary {
  /** id — null: узла ещё нет, создаётся при применении (импорт с группы). */
  node: { id: string | null; label: string };
  fileName: string;
  sheets: { name: string; rows: number }[];
  /** Дата скана из имени файла; нет — вводится в предпросмотре. */
  scanDate: string | null;
  coverageTitle: string;
  hostsCount: number;
  hosts: ScanHostRow[];
  /** Строк находок в файле, повторов ключа (объединены), пропущенных строк. */
  rows: number;
  inFileDuplicates: number;
  errorRows: number;
  errors: ScanIssue[];
  /** Строка загрузится, но значение считается пустым (CVSS или «Обнаружений» не число). */
  notes: ScanIssue[];
  warnings: string[];
  previousScan: { id: string; scanDate: string; fileName: string; handedOver: boolean } | null;
  /** Хосты против прошлого скана узла. Хосты — только охват: выбывший хост объясняет «Пропали», но не доказывает. */
  coverage: { newHosts: string[]; goneHosts: string[] };
  counts: Record<ScanGroup | 'gone', number>;
  /** Новые записи по критичности. */
  critCounts: { key: CritKey; label: string; count: number }[];
  newOptions: { field: string; values: string[] }[];
  groups: { new: ScanItem[]; reopened: ScanItem[]; changed: ScanItem[]; unchanged: ScanItem[]; deleted?: ScanItem[]; gone: ScanGoneItem[] };
  /** Запись узла в архиве — строка файла её не трогает. */
  archived: { number: number; pkg: string; cve: string }[];
  /** Система из прошлого импорта узла: предзаполняет окно. */
  systemId: string | null;
  /** Профиль по имени файла. mismatch — профиль найден и это не тип узла: применение только с подтверждением. */
  profile: { detected: ProfileType | null; nodeType: ProfileType | null; mismatch: boolean } | null;
}

interface ScanPayload {
  nodeId: string | null;
  /** Импорт с группы, узла ещё нет: создаётся в транзакции применения. */
  newNode: { groupId: string; systemTypeId: string } | null;
  rows: ScanRow[];
  hosts: ScanHostRow[];
  coverageTitle: string;
  fileId: string;
  previousScanId: string | null;
  /** Записи узла с ключом на момент предпросмотра: разошлось — IMPORT_STALE. */
  known: { id: string; key: string; version: number; archived: boolean }[];
  fieldVersions: Record<string, number>;
}

/** Запись узла с ключом (без удалённых). */
interface NodeRecord {
  id: string;
  number: number;
  version: number;
  values: Values;
  manual_field_ids: string[];
  archived: boolean;
  key: string;
  cycle: number;
  first_scan_id: string | null;
}

async function nodeRecords(db: Db, nodeId: string): Promise<NodeRecord[]> {
  return db.$queryRaw<NodeRecord[]>`
    SELECT r.id::text, r.number, r.version, r."values", r.manual_field_ids::text[] AS manual_field_ids, r.archived_at IS NOT NULL AS archived,
           v.key_norm AS key, v.cycle, v.first_scan_id::text AS first_scan_id
    FROM vuln_records v JOIN register_records r ON r.id = v.record_id
    WHERE v.node_id = ${nodeId}::uuid AND v.key_norm IS NOT NULL AND r.deleted_at IS NULL
    ORDER BY r.number`;
}

type DeletedInfo = NonNullable<ScanItem['deleted']>;

/**
 * Удалённые записи узла по ключу «Пакет + Идентификатор» (ключ считается из значений: при удалении узел его освобождает).
 * Последнее удаление ключа; восстановленные записи — уже не удалённые. Удалённые до 1.6.1 — «причина не указана».
 */
async function deletedRecords(db: Db, reg: RegisterDef, nodeId: string): Promise<Map<string, DeletedInfo>> {
  const rows = await db.$queryRaw<{ number: number; values: Values; deleted_at: Date; reason_code: string | null; reason: string | null }[]>`
    SELECT r.number, r."values", r.deleted_at, d.reason_code, d.reason
    FROM vuln_records v JOIN register_records r ON r.id = v.record_id LEFT JOIN deletions d ON d.id = r.deletion_id
    WHERE v.node_id = ${nodeId}::uuid AND r.deleted_at IS NOT NULL
    ORDER BY r.deleted_at`;
  const out = new Map<string, DeletedInfo>();
  for (const r of rows) {
    const key = vulnKeyOf(reg, r.values);
    if (!key) continue;
    out.set(key, {
      number: r.number,
      reason: r.reason_code === null && r.reason === null ? 'причина не указана' : reasonText(r.reason_code, r.reason ?? ''),
      deletedAt: r.deleted_at.toISOString(),
    });
  }
  return out;
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

/** Значение поля «Отдел» для охвата скана: сравнение без регистра, пробелов и «ё» (deptKey). */
export function departmentOption(vf: VulnFields, department: string) {
  const k = deptKey(department);
  return k ? vf.department.options.find((o) => deptKey(o.label) === k) : undefined;
}

async function vulnRegisterDef(db: Db): Promise<{ reg: RegisterDef; vf: VulnFields }> {
  const row = await db.register.findUniqueOrThrow({ where: { systemKey: VULN_REGISTER_KEY } });
  const reg = await loadRegister(db, row.id);
  assertNotArchived(reg);
  return { reg, vf: vulnFields(reg) };
}

const labelOf = (f: FieldMeta, id: unknown) => f.options.find((o) => o.id === id)?.label ?? '';
const shown = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/**
 * Значения записи после строки файла. Пустое в файле не стирает значение реестра: колонки может не быть,
 * CVSS может оказаться нечислом («н/д») — это не повод терять оценку.
 */
function patchValues(vf: VulnFields, before: Values, r: ScanRow, optionId: (key: OptionKey, label: string) => string): { values: Values; edited: string[]; changes: ScanFieldChange[] } {
  const values: Values = { ...before };
  const edited: string[] = [];
  const changes: ScanFieldChange[] = [];
  const set = (f: FieldMeta, value: string | number, from: string, to: string) => {
    values[f.id] = value;
    edited.push(f.id);
    changes.push({ fieldId: f.id, label: f.label, from, to });
  };
  for (const key of OPTION_KEYS) {
    const label = r[key];
    if (label === null) continue;
    const id = optionId(key, label);
    if (id !== before[vf[key].id]) set(vf[key], id, labelOf(vf[key], before[vf[key].id]), findOption(vf, key, label)?.label ?? label);
  }
  if (r.cvss !== null && r.cvss !== before[vf.cvss.id]) set(vf.cvss, r.cvss, shown(before[vf.cvss.id]), String(r.cvss));
  const fixBefore = before[vf.fixVersion.id];
  if (r.fixVersion !== null && norm(r.fixVersion) !== norm(typeof fixBefore === 'string' ? fixBefore : '')) {
    set(vf.fixVersion, r.fixVersion, shown(fixBefore), r.fixVersion);
    // «Исправление» следует за версией, но отдельным различием не считается.
    const fix = optionByKey(vf.fix, fixKeyFromText(r.fixVersion));
    if (fix !== before[vf.fix.id]) {
      values[vf.fix.id] = fix;
      edited.push(vf.fix.id);
    }
  }
  if (r.hits !== null && r.hits !== before[vf.hits.id]) set(vf.hits, r.hits, shown(before[vf.hits.id]), String(r.hits));
  return { values, edited, changes };
}

const optionResolver = (vf: VulnFields) => (key: OptionKey, label: string) => findOption(vf, key, label)?.id ?? `new:${norm(label)}`;

function rowScore(vf: VulnFields, r: ScanRow): { score: number | null; crit: CritKey } {
  const exploitKey = r.exploit ? findOption(vf, 'exploit', r.exploit)?.systemKey ?? null : null;
  const score = vulnScore(r.cvss, exploitKey, fixKeyFromText(r.fixVersion));
  return { score, crit: critKeyOf(score) };
}

const critLabel = (vf: VulnFields, crit: CritKey) => vf.crit.options.find((o) => o.systemKey === crit)?.label ?? CRIT_LABELS[crit];

/** Повторное обнаружение: статус «Открыта», служебные значения и решение п. 7.3 снимаются — у нового цикла свой срок. */
function reopenedValues(vf: VulnFields, values: Values): Values {
  const cleared = new Set([vf.notified.id, vf.legacyDue.id, vf.extDays.id, vf.measures.id, vf.newDue.id]);
  return { ...Object.fromEntries(Object.entries(values).filter(([id]) => !cleared.has(id))), [vf.status.id]: optionByKey(vf.status, 'open') };
}

interface Classified {
  items: Record<ScanGroup, ScanItem[]>;
  gone: ScanGoneItem[];
  archived: ScanSummary['archived'];
  rowOf: Map<string, ScanRow>;
  recordOf: Map<string, NodeRecord>;
}

/** Раскладывает строки файла по группам. Одна функция для предпросмотра и применения: версии проверены — результат тот же. */
function classify(
  reg: RegisterDef, vf: VulnFields, rows: readonly ScanRow[], known: readonly NodeRecord[], calendar: WorkCalendar | null,
  deletedOf: ReadonlyMap<string, DeletedInfo> = new Map(),
): Classified {
  const recordOf = new Map(known.map((k) => [k.key, k]));
  const rowOf = new Map<string, ScanRow>();
  const out: Classified = { items: { new: [], reopened: [], changed: [], unchanged: [], deleted: [] }, gone: [], archived: [], rowOf, recordOf };
  const today = todayIso();
  const option = optionResolver(vf);
  for (const r of rows) {
    const key = keyNorm(r.pkg, r.cve);
    rowOf.set(key, r);
    const { score, crit } = rowScore(vf, r);
    const base = { key, sheet: r.sheet, row: r.row, pkg: r.pkg, cve: r.cve, cvss: r.cvss, score, crit: critLabel(vf, crit) };
    const rec = recordOf.get(key);
    if (!rec) {
      const item: ScanItem = { ...base, recordId: null, number: null, changes: [], dueBefore: null, dueAfter: null, becomesOverdue: false, closedStatus: null };
      const deleted = deletedOf.get(key);
      if (deleted) out.items.deleted.push({ ...item, deleted });
      else out.items.new.push(item);
      continue;
    }
    if (rec.archived) {
      out.archived.push({ number: rec.number, pkg: r.pkg, cve: r.cve });
      continue;
    }
    const { values, edited, changes } = patchValues(vf, rec.values, r, option);
    const status = vf.status.options.find((o) => o.id === rec.values[vf.status.id]);
    const reopened = status?.systemKey === 'fixed';
    const closed = isClosed(reg, rec.values);
    const derived = applyDerived(reg, { before: rec.values, after: values, manual: rec.manual_field_ids, edited, isNew: false }).values;
    const dueBefore = dateOf(reg, vf.due, rec.values, calendar);
    const dueAfter = dateOf(reg, vf.due, reopened ? reopenedValues(vf, derived) : derived, calendar);
    const item: ScanItem = {
      ...base, recordId: rec.id, number: rec.number, changes, dueBefore, dueAfter,
      becomesOverdue: !closed && !reopened && dueAfter !== null && dueAfter < today && !(dueBefore !== null && dueBefore < today),
      closedStatus: closed && !reopened ? status?.label ?? null : null,
    };
    if (reopened) out.items.reopened.push(item);
    else if (changes.length) out.items.changed.push(item);
    else out.items.unchanged.push(item);
  }
  for (const rec of known) {
    if (rowOf.has(rec.key) || rec.archived || isClosed(reg, rec.values)) continue;
    const cve = rec.values[vf.cve.id];
    out.gone.push({
      key: rec.key, recordId: rec.id, number: rec.number, pkg: labelOf(vf.pkg, rec.values[vf.pkg.id]), cve: typeof cve === 'string' ? cve : '',
      crit: labelOf(vf.crit, rec.values[vf.crit.id]), status: labelOf(vf.status, rec.values[vf.status.id]), due: dateOf(reg, vf.due, rec.values, calendar),
    });
  }
  return out;
}

async function previousScanOf(db: Db, nodeId: string) {
  return db.vulnScan.findFirst({ where: { nodeId }, orderBy: [{ scanDate: 'desc' }, { createdAt: 'desc' }] });
}

// ---------------------------------------------------------------- предпросмотр

interface ScanTarget {
  nodeId: string | null;
  label: string;
  nodeType: ProfileType | null;
  newNode: ScanPayload['newNode'];
}

export async function previewNodeScan(db: Db, store: FileStore, actor: Actor, nodeId: string, buffer: Buffer, fileName: string) {
  const node = await loadNode(db, nodeId);
  if (node.systemKey) throw conflict('LEGACY_NODE', 'В «Без группы» сканы не загружаются. Откройте узел группы');
  const nodeType = node.systemType ? { id: node.systemType.id, label: node.systemType.value } : null;
  return previewScan(db, store, actor, { nodeId: node.id, label: nodeLabel(node), nodeType, newNode: null }, buffer, fileName);
}

/** Импорт с группы в тип, которого в группе ещё нет: сравнение с пустым реестром, узла нет до применения. */
export async function previewNewNodeScan(db: Db, store: FileStore, actor: Actor, groupId: string, systemTypeId: string, buffer: Buffer, fileName: string) {
  const { group, type } = await checkNewNode(db, groupId, systemTypeId);
  return previewScan(db, store, actor, { nodeId: null, label: `${group.name} / ${type.value}`, nodeType: { id: type.id, label: type.value }, newNode: { groupId, systemTypeId } }, buffer, fileName);
}

async function previewScan(db: Db, store: FileStore, actor: Actor, target: ScanTarget, buffer: Buffer, fileName: string) {
  const { nodeId, nodeType } = target;
  const { reg, vf } = await vulnRegisterDef(db);
  const parsed = await parseScanReport(buffer, fileName);
  const { unique, duplicates } = mergeDuplicates(parsed.rows);
  const known = nodeId ? await nodeRecords(db, nodeId) : [];
  const calendar = await calendarFor(db, reg);
  const c = classify(reg, vf, unique, known, calendar, nodeId ? await deletedRecords(db, reg, nodeId) : new Map());

  const previous = nodeId ? await previousScanOf(db, nodeId) : null;
  const hostKeys = (hosts: readonly ScanHostRow[]) => new Set(hosts.map((h) => norm(h.name)));
  const prevHosts = (previous?.hosts ?? []) as unknown as ScanHostRow[];
  const coverage = previous
    ? {
      newHosts: parsed.hosts.filter((h) => !hostKeys(prevHosts).has(norm(h.name))).map((h) => h.name),
      goneHosts: prevHosts.filter((h) => !hostKeys(parsed.hosts).has(norm(h.name))).map((h) => h.name),
    }
    : { newHosts: [], goneHosts: [] };

  const critCounts = new Map<CritKey, number>();
  for (const i of [...c.items.new, ...c.items.deleted]) {
    const { crit } = rowScore(vf, c.rowOf.get(i.key) as ScanRow);
    critCounts.set(crit, (critCounts.get(crit) ?? 0) + 1);
  }
  const newLabels = new Map<keyof VulnFields, Set<string>>();
  const noteNew = (key: keyof VulnFields, label: string | null) => {
    if (!label || findOption(vf, key, label)) return;
    const set = newLabels.get(key) ?? new Set<string>();
    if (![...set].some((l) => norm(l) === norm(label))) set.add(label);
    newLabels.set(key, set);
  };
  for (const i of [...c.items.new, ...c.items.deleted]) noteNew('pkg', i.pkg);
  for (const r of unique) for (const k of OPTION_KEYS) noteNew(k, r[k]);

  const detected = await detectFileProfile(db, fileName);

  const warnings = [...parsed.warnings];
  if (!parsed.reportDate) warnings.push('В имени файла нет даты скана (ГГГГ_ММ_ДД, ГГГГ-ММ-ДД, ГГГГ.ММ.ДД) — укажите её перед применением');
  const prevDate = previous?.scanDate.toISOString().slice(0, 10);
  if (prevDate && parsed.reportDate && parsed.reportDate < prevDate) warnings.push(`Дата скана раньше прошлого скана узла (${formatDateRu(prevDate)})`);
  if (coverage.goneHosts.length) warnings.push(`Из охвата выбыли хосты (${coverage.goneHosts.length}): часть «Пропавших» могла просто не сканироваться`);
  if (c.archived.length) warnings.push(`Записей в архиве, которые есть в файле: ${c.archived.length} — они не обновятся`);
  if (c.items.deleted.length) warnings.push(`Снова пришли удалённые записи: ${c.items.deleted.length} — по умолчанию не загружаются, отметьте нужные в группе «Были удалены»`);
  if (parsed.errors.length > MAX_LIST) warnings.push(`Показаны первые ${MAX_LIST} пропущенных строк`);

  const prevSystem = (previous?.comparison as { systemId?: string | null } | null)?.systemId ?? null;
  const summary: ScanSummary = {
    node: { id: nodeId, label: target.label },
    fileName,
    sheets: parsed.sheets,
    scanDate: parsed.reportDate,
    coverageTitle: parsed.coverageTitle,
    hostsCount: parsed.hosts.length,
    hosts: parsed.hosts.slice(0, 1000),
    rows: parsed.rows.length,
    inFileDuplicates: duplicates,
    errorRows: parsed.errors.length,
    errors: parsed.errors.slice(0, MAX_LIST),
    notes: parsed.notes.slice(0, MAX_LIST),
    warnings,
    previousScan: previous && prevDate ? { id: previous.id, scanDate: prevDate, fileName: previous.fileName, handedOver: previous.handedOverOn !== null } : null,
    coverage,
    counts: { new: c.items.new.length, reopened: c.items.reopened.length, changed: c.items.changed.length, unchanged: c.items.unchanged.length, deleted: c.items.deleted.length, gone: c.gone.length },
    critCounts: (['critical', 'high', 'medium', 'low'] as const)
      .filter((k) => critCounts.has(k))
      .map((k) => ({ key: k, label: critLabel(vf, k), count: critCounts.get(k) ?? 0 })),
    newOptions: [...newLabels.entries()].map(([k, set]) => ({ field: vf[k].label, values: [...set] })),
    groups: { ...c.items, gone: c.gone },
    archived: c.archived,
    systemId: prevSystem && vf.system.options.some((o) => o.id === prevSystem && !o.archived) ? prevSystem : null,
    profile: { detected, nodeType, mismatch: detected !== null && detected.id !== nodeType?.id },
  };

  // Файл — доказательство: к скану привязывается при применении, брошенный предпросмотр убирает часовая очистка.
  const file = await uploadFile(db, store, actor, fileName, buffer);
  const payload: ScanPayload = {
    nodeId, newNode: target.newNode, rows: unique, hosts: parsed.hosts, coverageTitle: parsed.coverageTitle, fileId: file.id, previousScanId: previous?.id ?? null,
    known: known.map((k) => ({ id: k.id, key: k.key, version: k.version, archived: k.archived })),
    fieldVersions: Object.fromEntries(reg.fields.map((f) => [f.id, f.version])),
  };
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const imp = await withTx(db, async (tx) => {
    const created = await tx.registerImport.create({
      data: {
        registerId: reg.id, kind: 'scan', fileName: fileName.slice(0, 255), fileSha256: sha256,
        summary: summary as unknown as Prisma.InputJsonValue, payload: payload as unknown as Prisma.InputJsonValue,
        createdBy: actor.id, expiresAt: new Date(Date.now() + IMPORT_TTL_MS),
      },
    });
    await auditSettings(tx, actor, {
      action: 'vuln.scan.previewed', entity: 'register_import', entityId: created.id,
      summary: `Уязвимости, «${summary.node.label}»: предпросмотр скана «${fileName}» — новых ${summary.counts.new}, повторно ${summary.counts.reopened}, изменились ${summary.counts.changed}, без изменений ${summary.counts.unchanged}, пропали ${summary.counts.gone}`,
      after: { nodeId, newNode: target.newNode, fileName, sha256, fileId: file.id, counts: summary.counts, errorRows: summary.errorRows, hosts: summary.hostsCount },
    });
    return created;
  });
  return { id: imp.id, status: imp.status, expiresAt: imp.expiresAt.toISOString(), summary };
}

const isNodeScan = (p: ScanPayload) => !!p.nodeId || !!p.newNode;

export async function getNodeScanImport(db: Db, id: string) {
  const imp = await db.registerImport.findUnique({ where: { id } });
  if (!imp || imp.kind !== 'scan' || !isNodeScan(imp.payload as unknown as ScanPayload)) throw notFound('Импорт');
  const status = imp.status === 'preview' && imp.expiresAt < new Date() ? 'expired' : imp.status;
  const summary = imp.summary as unknown as ScanSummary;
  return { id: imp.id, registerId: imp.registerId, status, expiresAt: imp.expiresAt.toISOString(), summary: { ...summary, profile: summary.profile ?? null } };
}

// ---------------------------------------------------------------- применение

export interface ApplyScanInput {
  /** Дата скана: обязательна, если её нет в имени файла; иначе правит дату из имени. */
  scanDate?: string | null;
  /** Система новых записей: от неё правила п. 7.4 находят владельца. Не указано — из прошлого импорта узла. */
  systemId?: string | null;
  /** Выбор по строкам — ключи групп. Не указано: новые, повторные и изменившиеся все, пропавшие никакие. */
  selected?: { new?: string[]; reopened?: string[]; changed?: string[]; deleted?: string[]; gone?: string[] };
  /** «Я проверил, файл относится к этому узлу»: обязательно, если профиль файла не совпал с типом узла. */
  profileConfirmed?: boolean;
  /** Право «Конструктор реестров»: без него узел при применении не создаётся. */
  canAddNode?: boolean;
}

function pick(all: readonly { key: string }[], chosen: readonly string[] | undefined, byDefault: boolean, what: string): Set<string> {
  if (chosen === undefined) return new Set(byDefault ? all.map((i) => i.key) : []);
  const keys = new Set(all.map((i) => i.key));
  if (chosen.some((k) => !keys.has(k))) throw badRequest('BAD_SELECTION', `Выбрана строка не из группы «${what}». Повторите предпросмотр`);
  return new Set(chosen);
}

export async function applyNodeScan(db: Db, actor: Actor, importId: string, input: ApplyScanInput) {
  return withTx(db, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM register_imports WHERE id = ${importId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound('Импорт');
    const imp = await tx.registerImport.findUniqueOrThrow({ where: { id: importId } });
    const payload = imp.payload as unknown as ScanPayload;
    if (imp.kind !== 'scan' || !isNodeScan(payload)) throw notFound('Импорт');
    if (imp.createdBy !== actor.id) throw new AppError(403, 'IMPORT_OTHER_USER', 'Применить импорт может только тот, кто загрузил файл');
    if (imp.status !== 'preview') throw conflict('IMPORT_NOT_PENDING', 'Этот импорт уже применён или отменён');
    if (imp.expiresAt < new Date()) {
      await tx.registerImport.update({ where: { id: importId }, data: { status: 'expired' } });
      throw conflict('IMPORT_EXPIRED', 'Предпросмотр устарел (30 минут). Загрузите файл снова');
    }
    const summary = imp.summary as unknown as ScanSummary;
    const mismatch = summary.profile?.mismatch ? summary.profile : null;
    if (mismatch && !input.profileConfirmed) throw conflict('PROFILE_NOT_CONFIRMED', 'Файл похож на скан другого профиля. Подтвердите, что он относится к этому узлу');
    const scanDate = input.scanDate ?? summary.scanDate;
    if (!scanDate) throw badRequest('SCAN_DATE_REQUIRED', 'Укажите дату скана: в имени файла её нет');
    if (!isIsoDate(scanDate)) throw badRequest('BAD_DATE', 'Дата скана: неверная дата');
    if (scanDate > todayIso()) throw badRequest('BAD_DATE', 'Дата скана не может быть позже сегодняшней');

    // Импорт с группы: узел появляется здесь же, откат применения уберёт и его.
    let nodeId = payload.nodeId as string;
    if (payload.newNode) {
      if (!input.canAddNode) throw new AppError(403, 'FORBIDDEN', 'Добавить тип в группу может сотрудник с правом «Конструктор реестров»');
      const { group, type } = await checkNewNode(tx, payload.newNode.groupId, payload.newNode.systemTypeId);
      nodeId = (await tx.vulnNode.create({ data: { groupId: group.id, systemTypeId: type.id, createdBy: actor.id } })).id;
      await auditSettings(tx, actor, {
        action: 'vuln.node.created', entity: 'vuln_group', entityId: group.id,
        summary: `Уязвимости: в группу «${group.name}» добавлен тип «${type.value}» при импорте скана «${summary.fileName}»`,
        after: { systemTypeIds: [type.id], nodeId },
      });
    }

    // Импорты одного узла — по очереди; записи узла не меняются, пока идёт применение.
    await tx.$queryRaw`SELECT id FROM vuln_nodes WHERE id = ${nodeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`
      SELECT r.id FROM vuln_records v JOIN register_records r ON r.id = v.record_id
      WHERE v.node_id = ${nodeId}::uuid AND v.key_norm IS NOT NULL FOR UPDATE OF r`;
    const node = await loadNode(tx, nodeId);
    const { reg, vf } = await vulnRegisterDef(tx);
    for (const [fieldId, version] of Object.entries(payload.fieldVersions)) {
      const f = reg.fields.find((x) => x.id === fieldId);
      if (!f || f.version !== version || f.archived) throw conflict('IMPORT_STALE', 'После предпросмотра изменились поля реестра. Повторите предпросмотр');
    }
    const previous = await previousScanOf(tx, node.id);
    if ((previous?.id ?? null) !== payload.previousScanId) throw conflict('IMPORT_STALE', 'После предпросмотра в узел загрузили другой скан. Повторите предпросмотр');
    const known = await nodeRecords(tx, node.id);
    const was = new Map(payload.known.map((k) => [k.id, k]));
    const moved = known.filter((k) => {
      const w = was.get(k.id);
      return !w || w.version !== k.version || w.key !== k.key || w.archived !== k.archived;
    });
    if (moved.length || known.length !== payload.known.length) {
      const numbers = moved.map((m) => m.number);
      throw conflict('IMPORT_STALE', `После предпросмотра изменились записи узла${numbers.length ? ` (${numbers.slice(0, 10).join(', ')}${numbers.length > 10 ? '…' : ''})` : ''}. Повторите предпросмотр`);
    }

    const calendar = await calendarFor(tx, reg);
    const c = classify(reg, vf, payload.rows, known, calendar, await deletedRecords(tx, reg, node.id));
    const chosen = {
      new: pick(c.items.new, input.selected?.new, true, 'Новые'),
      deleted: pick(c.items.deleted, input.selected?.deleted, false, 'Были удалены'),
      reopened: pick(c.items.reopened, input.selected?.reopened, true, 'Повторно обнаружены'),
      changed: pick(c.items.changed, input.selected?.changed, true, 'Изменились'),
      gone: pick(c.gone, input.selected?.gone, false, 'Пропали'),
    };

    const systemId = input.systemId === undefined ? summary.systemId : input.systemId;
    const system = systemId ? vf.system.options.find((o) => o.id === systemId && !o.archived) : null;
    if (systemId && !system) throw badRequest('BAD_SYSTEM', 'Нет такой системы в справочнике «Системы» (или она в архиве)');

    // Значения списков: недостающие пакеты, уровни и т. п. добавляются в реестр.
    const createdOptions: string[] = [];
    const ensureOption = async (key: keyof VulnFields, label: string | null): Promise<string | null> => {
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
    for (const k of [...chosen.new, ...chosen.deleted, ...chosen.reopened, ...chosen.changed]) {
      const r = c.rowOf.get(k) as ScanRow;
      for (const o of OPTION_KEYS) await ensureOption(o, r[o]);
    }
    const option = optionResolver(vf);

    // Подпись и отдел — для реестра и отката на 1.1.0: «Отчёт сканирования» и «Отдел» заполняются охватом скана.
    let reportOption: string | null = null;
    if (chosen.new.size || chosen.deleted.size || chosen.reopened.size) {
      const base = `${payload.coverageTitle || nodeLabel(node)} · ${formatDateRu(scanDate)}`;
      let label = base;
      for (let n = 2; vf.report.options.some((o) => norm(o.label) === norm(label)); n++) label = `${base} (${n})`;
      reportOption = await ensureOption('report', label);
    }
    const coverage = payload.coverageTitle.trim();
    const departmentId = coverage && (chosen.new.size || chosen.deleted.size) ? departmentOption(vf, coverage)?.id ?? await ensureOption('department', coverage) : null;

    const users = await loadUsers(tx);
    const statusOpen = optionByKey(vf.status, 'open');
    const statusFixed = optionByKey(vf.status, 'fixed');

    // Новые записи — до скана: скан не меняется, а в его сравнении нужны их номера.
    const createdByKey = new Map<string, { id: string; number: number }>();
    // Выбранные «Были удалены» заводятся новыми записями: удалённая остаётся в корзине.
    const toCreate = [...c.items.new.filter((i) => chosen.new.has(i.key)), ...c.items.deleted.filter((i) => chosen.deleted.has(i.key))];
    let number = toCreate.length ? await nextNumbers(tx, reg.id, toCreate.length) : 0;
    for (const i of toCreate) {
      const r = c.rowOf.get(i.key) as ScanRow;
      const raw: Values = {
        [vf.cve.id]: r.cve, [vf.status.id]: statusOpen,
        ...(system ? { [vf.system.id]: system.id } : {}), ...(departmentId ? { [vf.department.id]: departmentId } : {}),
      };
      const set = (f: FieldMeta, v: string | number | null) => {
        if (v !== null) raw[f.id] = v;
      };
      set(vf.pkg, await ensureOption('pkg', r.pkg));
      set(vf.level, r.level ? option('level', r.level) : null);
      set(vf.cvss, r.cvss);
      set(vf.exploit, r.exploit ? option('exploit', r.exploit) : null);
      set(vf.vector, r.vector ? option('vector', r.vector) : null);
      set(vf.fix, optionByKey(vf.fix, fixKeyFromText(r.fixVersion)));
      set(vf.fixVersion, r.fixVersion);
      set(vf.desc, r.desc);
      set(vf.hits, r.hits);
      set(vf.report, reportOption);
      // Критичность в отчёте не приходит — считается по Оценке.
      const { values } = applyDerived(reg, { before: {}, after: raw, manual: [], edited: Object.keys(raw), isNew: true });
      const rec = await tx.registerRecord.create({
        data: { registerId: reg.id, number, values: values as Prisma.InputJsonValue, searchText: searchTextOf(reg, number, values, users) },
      });
      createdByKey.set(i.key, { id: rec.id, number });
      await auditSettings(tx, actor, {
        action: 'register_record.created', entity: 'register_record', entityId: rec.id,
        summary: `«${reg.name}»: создана запись #${number} из скана «${summary.fileName}» (${nodeLabel(node)})`,
        after: { registerId: reg.id, number, via: 'scan_import', importId, nodeId: node.id, sheet: r.sheet, row: r.row, ...(i.deleted ? { wasDeleted: i.deleted } : {}) },
      });
      number++;
    }

    const selectedOf = (group: ScanGroup, key: string) => (group === 'unchanged' ? true : chosen[group].has(key));
    const groupOf = new Map<string, ScanGroup>();
    for (const g of ['new', 'reopened', 'changed', 'unchanged', 'deleted'] as const) for (const i of c.items[g]) groupOf.set(i.key, g);
    const brief = (g: ScanGroup) => c.items[g].map((i) => ({
      key: i.key, pkg: i.pkg, cve: i.cve, recordId: i.recordId ?? createdByKey.get(i.key)?.id ?? null, number: i.number ?? createdByKey.get(i.key)?.number ?? null,
      selected: selectedOf(g, i.key), changes: i.changes, closedStatus: i.closedStatus, ...(i.deleted ? { deleted: i.deleted } : {}),
    }));
    const findings = payload.rows.map((r) => {
      const key = keyNorm(r.pkg, r.cve);
      const { score, crit } = rowScore(vf, r);
      const group = groupOf.get(key) ?? null; // null — запись узла в архиве
      return { ...r, key, score, crit, critLabel: critLabel(vf, crit), group, selected: group ? selectedOf(group, key) : false };
    });
    const comparison = {
      groups: { new: brief('new'), reopened: brief('reopened'), changed: brief('changed'), unchanged: brief('unchanged'), deleted: brief('deleted'), gone: c.gone.map((g) => ({ ...g, selected: chosen.gone.has(g.key) })) },
      counts: summary.counts,
      critCounts: summary.critCounts,
      coverage: summary.coverage,
      archived: c.archived,
      systemId: system?.id ?? null,
      inFileDuplicates: summary.inFileDuplicates,
      errorRows: summary.errorRows,
      errors: summary.errors,
      notes: summary.notes,
      profileMismatch: mismatch ? { fileProfile: mismatch.detected, nodeType: mismatch.nodeType, confirmedBy: actor.id, confirmedAt: new Date().toISOString() } : null,
    };
    const scan = await tx.vulnScan.create({
      data: {
        nodeId: node.id, importId, fileId: payload.fileId, fileName: summary.fileName, fileSha256: imp.fileSha256, scanDate: parseIsoDate(scanDate),
        coverageTitle: payload.coverageTitle, hosts: payload.hosts as unknown as Prisma.InputJsonValue, hostsCount: payload.hosts.length,
        findings: findings as unknown as Prisma.InputJsonValue, findingsCount: findings.length,
        comparison: comparison as unknown as Prisma.InputJsonValue, previousScanId: payload.previousScanId, createdBy: actor.id,
      },
    });

    const seen: Prisma.VulnRecordScanCreateManyInput[] = [];
    const vulnRows: Prisma.VulnRecordCreateManyInput[] = [];
    for (const [key, rec] of createdByKey) {
      vulnRows.push({ recordId: rec.id, nodeId: node.id, keyNorm: key, firstScanId: scan.id, lastScanId: scan.id });
      seen.push({ recordId: rec.id, scanId: scan.id, outcome: 'new', cycle: 1 });
    }
    if (vulnRows.length) await tx.vulnRecord.createMany({ data: vulnRows });

    /** Запись изменена сканом: значения, журнал и история. */
    const rewrite = async (rec: NodeRecord, values: Values, manualFieldIds: string[], text: string, extra: Record<string, unknown> = {}) => {
      const fields = reg.fields.filter((f) => shown(rec.values[f.id]) !== shown(values[f.id]));
      const changes = describeChanges(reg, rec.values, values, fields, users);
      await tx.registerRecord.update({
        where: { id: rec.id },
        data: { values: values as Prisma.InputJsonValue, manualFieldIds, searchText: searchTextOf(reg, rec.number, values, users), version: { increment: 1 } },
      });
      await auditSettings(tx, actor, {
        action: 'register_record.updated', entity: 'register_record', entityId: rec.id,
        summary: `«${reg.name}», запись #${rec.number}: ${text} (скан «${summary.fileName}»)`,
        after: { changes, via: 'scan_import', importId, scanId: scan.id, nodeId: node.id, ...extra },
      });
      return changes as unknown as Prisma.InputJsonValue;
    };
    const fromRow = (rec: NodeRecord, key: string) => {
      const patch = patchValues(vf, rec.values, c.rowOf.get(key) as ScanRow, option);
      return applyDerived(reg, { before: rec.values, after: patch.values, manual: rec.manual_field_ids, edited: patch.edited, isNew: false });
    };

    const found: string[] = [];
    for (const i of c.items.reopened) {
      if (!chosen.reopened.has(i.key)) continue; // не выбрана — остаётся устранённой
      const rec = c.recordOf.get(i.key) as NodeRecord;
      const { values, manualFieldIds } = fromRow(rec, i.key);
      const after = { ...reopenedValues(vf, values), ...(reportOption ? { [vf.report.id]: reportOption } : {}) };
      const changes = await rewrite(rec, after, manualFieldIds, 'повторно обнаружена, открыта заново, срок пойдёт от передачи ИКТ', { reopened: true, cycle: rec.cycle + 1 });
      await tx.vulnRecord.update({
        where: { recordId: rec.id },
        data: { cycle: { increment: 1 }, reopenedAt: new Date(), deadlineScanId: null, lastScanId: scan.id, firstScanId: rec.first_scan_id ?? scan.id, version: { increment: 1 } },
      });
      seen.push({ recordId: rec.id, scanId: scan.id, outcome: 'reopened', cycle: rec.cycle + 1, changes });
    }
    for (const i of c.items.changed) {
      const rec = c.recordOf.get(i.key) as NodeRecord;
      found.push(rec.id);
      if (!chosen.changed.has(i.key)) {
        // Не выбрана: значения те же, но запись в этом скане встречалась.
        seen.push({ recordId: rec.id, scanId: scan.id, outcome: 'unchanged', cycle: rec.cycle });
        continue;
      }
      const { values, manualFieldIds } = fromRow(rec, i.key);
      seen.push({ recordId: rec.id, scanId: scan.id, outcome: 'changed', cycle: rec.cycle, changes: await rewrite(rec, values, manualFieldIds, 'обновлена по скану') });
    }
    for (const i of c.items.unchanged) {
      const rec = c.recordOf.get(i.key) as NodeRecord;
      found.push(rec.id);
      seen.push({ recordId: rec.id, scanId: scan.id, outcome: 'unchanged', cycle: rec.cycle });
    }
    if (found.length) {
      await tx.vulnRecord.updateMany({ where: { recordId: { in: found }, firstScanId: null }, data: { firstScanId: scan.id } });
      await tx.vulnRecord.updateMany({ where: { recordId: { in: found } }, data: { lastScanId: scan.id, version: { increment: 1 } } });
    }
    for (const g of c.gone) {
      if (!chosen.gone.has(g.key)) continue;
      const rec = c.recordOf.get(g.key) as NodeRecord;
      const changes = await rewrite(rec, { ...rec.values, [vf.status.id]: statusFixed }, rec.manual_field_ids, 'нет в скане, отмечена устранённой', { gone: true });
      await tx.vulnRecord.update({ where: { recordId: rec.id }, data: { version: { increment: 1 } } });
      seen.push({ recordId: rec.id, scanId: scan.id, outcome: 'fixed', cycle: rec.cycle, changes });
    }
    if (seen.length) await tx.vulnRecordScan.createMany({ data: seen });

    await tx.registerImport.update({ where: { id: importId }, data: { status: 'applied', appliedAt: new Date() } });
    const result = {
      scanId: scan.id, created: createdByKey.size, reopened: chosen.reopened.size, changed: chosen.changed.size,
      unchanged: c.items.unchanged.length, gone: chosen.gone.size, skipped: summary.errorRows,
    };
    await auditSettings(tx, actor, {
      action: 'vuln.scan.applied', entity: 'vuln_scan', entityId: scan.id,
      summary: `Уязвимости, «${nodeLabel(node)}»: загружен скан «${summary.fileName}» от ${formatDateRu(scanDate)} — новых ${result.created}, повторно ${result.reopened}, изменились ${result.changed}, без изменений ${result.unchanged}, отмечено устранёнными ${result.gone}, хостов ${payload.hosts.length}${mismatch ? `. Файл похож на профиль «${mismatch.detected?.label}», узел — «${mismatch.nodeType?.label}»: подтверждено, что файл относится к узлу` : ''}`,
      after: { nodeId: node.id, importId, fileId: payload.fileId, sha256: imp.fileSha256, scanDate, system: system?.label ?? null, ...result, hosts: payload.hosts.length, newOptions: createdOptions, profileMismatch: comparison.profileMismatch },
    });
    return result;
  });
}

// ---------------------------------------------------------------- отчёты прежнего реестра (1.1.0–1.4.0)

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
