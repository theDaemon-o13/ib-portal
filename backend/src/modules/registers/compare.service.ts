// Сравнение с реестром (релиз 1.1.0, задача 4, ADR-0017): какие открытые записи области есть в реестре,
// но нет в файле — выгрузке реестра или отчёте сканера. Файл берётся из предпросмотра импорта (та же sha256),
// хранится в files как доказательство (register_imports.file_id). Записи при сравнении не меняются.
// Сотрудник проставляет статус отсутствующим: предпросмотр → применение с expected (ADR-0016), пакетами,
// обычной правкой записи с историей; в журнале — id и sha256 файла.
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import type { FileStore } from '../../lib/file-store.js';
import { parseCell, type StoredValue, type Values } from '../../lib/register-values.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { uploadFile } from '../files/service.js';
import { norm as scanNorm, parseScanReport } from '../vulns/scan-parser.js';
import { assertNotArchived, isClosed, loadRegister, normalizeImportKeys, type FieldMeta, type RegisterDef } from './definition.js';
import { mapColumns, openRegisterSheet, readFileRows } from './excel.service.js';
import { lockErrors } from './record-rules.js';
import { updateRecord } from './records.service.js';

export const COMPARE_BATCH = 200;

/** Область: весь реестр (явный выбор) или значения поля-списка / справочника из настроек реестра. */
export type CompareScope = { all: true } | { fieldId: string; values: string[] };

export interface MissingRecord {
  id: string;
  number: number;
  title: string;
  /** Значение ключа, как в реестре: «CVE-2024-1 · openssl». */
  key: string;
  statusId: string | null;
}

export interface CompareResult {
  importId: string;
  file: { id: string; name: string; sha256: string };
  format: 'records' | 'scan';
  /** Поля ключа по порядку; пусто — по колонке ID. */
  key: { id: string; label: string }[];
  scope: { all: true; label: string } | { fieldId: string; label: string; values: { id: string; label: string }[] };
  /** Открытые записи области с заполненным ключом, которых нет в файле. */
  missing: MissingRecord[];
  /** Открытые записи области с пустым ключом — не сопоставляются, без действий. */
  noKey: number;
  /** Строки файла с другим значением поля области — не сравниваются. */
  outOfScopeRows: number;
  /** Строки файла, ключ которых не разобран (пусто или ошибка ячейки). */
  badKeyRows: number;
  /** Отчёт сканера: хосты прошлого отчёта, которых нет в листе «Хосты» этого. null — проверять не с чем. */
  incompleteScan: { previousReport: string; missingHosts: string[] } | null;
  /** Поле статуса и его значения — для простановки. */
  status: { fieldId: string; options: { id: string; label: string; isClosed: boolean }[] } | null;
}

const statusField = (reg: RegisterDef) => reg.fields.find((f) => f.isStatus && !f.archived);
const titleField = (reg: RegisterDef) => reg.fields.find((f) => f.isTitle && !f.archived);

/** Часть ключа из хранимого значения: текст — функцией БД register_import_key, остальное — как хранится. */
function partOf(f: FieldMeta, v: StoredValue | undefined, normText: Map<string, string | null>): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (f.type === 'text') return normText.get(String(v)) ?? null;
  return String(v);
}

/** Значение поля из текста ячейки отчёта сканера: список — по названию (и архивного значения), иначе — как при импорте. */
function storedFromText(f: FieldMeta, text: string | null): StoredValue | null {
  if (text === null || text.trim() === '') return null;
  if (f.type === 'select' || f.type === 'catalog') {
    const t = scanNorm(text);
    return f.options.find((o) => scanNorm(o.label) === t)?.id ?? null;
  }
  const r = parseCell(f, text, { users: [], linkTargets: new Map() });
  return r.ok ? r.value : null;
}

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
};

interface Computed extends CompareResult {
  missingIds: Set<string>;
  values: Map<string, { version: number; values: Values }>;
}

async function compute(db: Db, reg: RegisterDef, imp: { id: string; kind: string }, buffer: Buffer, file: CompareResult['file'], scope: CompareScope): Promise<Computed> {
  const keyFields = reg.compareKeyFieldIds.map((id) => reg.fields.find((f) => f.id === id && !f.archived)).filter((f): f is FieldMeta => !!f);
  const byId = keyFields.length === 0;
  // Область: проверка по настройкам реестра.
  let scopeField: FieldMeta | undefined;
  let scopeValues = new Set<string>();
  if (!('all' in scope)) {
    if (!reg.compareScopeFieldIds.includes(scope.fieldId)) throw badRequest('BAD_SCOPE', 'Область выбирается по полям из настроек сравнения реестра');
    scopeField = reg.fields.find((f) => f.id === scope.fieldId && !f.archived);
    if (!scopeField) throw badRequest('BAD_SCOPE', 'Поле области не найдено. Обновите страницу');
    if (!scope.values.length) throw badRequest('BAD_SCOPE', 'Выберите значения области или «Весь реестр»');
    scopeValues = new Set(scope.values);
  }
  const inScope = (values: Values) => !scopeField || scopeValues.has(String(values[scopeField.id] ?? ''));

  // Строки файла → значения полей ключа и области.
  const fileRows: { values: Map<string, StoredValue | null>; number: number | null; badKey: boolean }[] = [];
  let incompleteScan: CompareResult['incompleteScan'] = null;
  const format: CompareResult['format'] = imp.kind === 'scan' ? 'scan' : 'records';
  if (format === 'scan') {
    if (byId) throw badRequest('NO_COMPARE_KEY', 'Отчёт сканера сравнивается по ключу из полей — задайте ключ сравнения в настройках реестра');
    const parsed = await parseScanReport(buffer, file.name);
    for (const r of parsed.rows) {
      const values = new Map<string, StoredValue | null>();
      for (const f of [...keyFields, ...(scopeField ? [scopeField] : [])]) {
        const col = f.systemKey as keyof typeof r | null | undefined;
        const raw = col && col in r ? r[col] : null;
        values.set(f.id, storedFromText(f, raw === null || raw === undefined ? null : String(raw)));
      }
      fileRows.push({ values, number: null, badKey: keyFields.some((f) => values.get(f.id) == null) });
    }
    incompleteScan = await scanCoverage(db, reg, parsed.department, parsed.hosts.map((h) => h.name), scopeField, scopeValues);
  } else {
    const { wb, ws } = await openRegisterSheet(buffer);
    const { cols } = mapColumns(wb, ws, reg, []);
    const idCol = [...cols.entries()].find(([, c]) => c.kind === 'id')?.[0];
    if (byId && idCol === undefined) throw badRequest('NO_ID_COLUMN', 'Ключ сравнения — ID, а в файле нет колонки ID. Задайте ключ сравнения в настройках реестра');
    const missingCols = keyFields.filter((f) => ![...cols.values()].some((c) => c.field?.id === f.id));
    if (missingCols.length) throw badRequest('NO_KEY_COLUMN', `В файле нет колонок ключа сравнения: ${missingCols.map((f) => `«${f.label}»`).join(', ')}`);
    for (const row of await readFileRows(db, reg, ws, cols)) {
      const values = new Map<string, StoredValue | null>(row.values.map((v) => [v.field.id, v.value]));
      const idText = idCol !== undefined ? String(row.row.getCell(idCol).value ?? '').trim() : '';
      const number = /^\d+$/.test(idText) ? Number(idText) : null;
      fileRows.push({ values, number, badKey: byId ? number === null : keyFields.some((f) => !values.has(f.id)) });
    }
  }

  // Записи реестра: открытые (не в архиве, не закрыты).
  const rows = await db.registerRecord.findMany({
    where: { registerId: reg.id, deletedAt: null, archivedAt: null },
    select: { id: true, number: true, version: true, values: true },
    orderBy: { number: 'asc' },
  });
  const textValues = [
    ...rows.flatMap((r) => keyFields.filter((f) => f.type === 'text').map((f) => (r.values as Values)[f.id])),
    ...fileRows.flatMap((r) => keyFields.filter((f) => f.type === 'text').map((f) => r.values.get(f.id))),
  ].filter((v): v is string => typeof v === 'string');
  const normText = await normalizeImportKeys(db, textValues);
  const keyOf = (get: (f: FieldMeta) => StoredValue | null | undefined): string | null => {
    const parts = keyFields.map((f) => partOf(f, get(f) ?? undefined, normText));
    return parts.some((p) => p === null) ? null : parts.join('\u0000');
  };

  const inFile = new Set<string>();
  let outOfScopeRows = 0;
  let badKeyRows = 0;
  for (const r of fileRows) {
    if (scopeField && r.values.has(scopeField.id)) {
      const v = r.values.get(scopeField.id);
      if (v != null && !scopeValues.has(String(v))) {
        outOfScopeRows++;
        continue;
      }
    }
    if (r.badKey) {
      badKeyRows++;
      continue;
    }
    const k = byId ? String(r.number) : keyOf((f) => r.values.get(f.id));
    if (k) inFile.add(k);
  }

  const title = titleField(reg);
  const missing: MissingRecord[] = [];
  const values = new Map<string, { version: number; values: Values }>();
  let noKey = 0;
  for (const r of rows) {
    const v = r.values as Values;
    if (isClosed(reg, v) || !inScope(v)) continue;
    const k = byId ? String(r.number) : keyOf((f) => v[f.id]);
    if (!k) {
      noKey++;
      continue;
    }
    if (inFile.has(k)) continue;
    const shown = keyFields.map((f) => (f.type === 'select' || f.type === 'catalog' ? f.options.find((o) => o.id === v[f.id])?.label ?? '' : String(v[f.id] ?? '')));
    const st = statusField(reg);
    missing.push({
      id: r.id, number: r.number, title: title && typeof v[title.id] === 'string' ? String(v[title.id]) : '',
      key: byId ? `#${r.number}` : shown.join(' · '), statusId: st ? (v[st.id] as string | undefined) ?? null : null,
    });
    values.set(r.id, { version: r.version, values: v });
  }

  const st = statusField(reg);
  return {
    importId: imp.id, file, format,
    key: keyFields.map((f) => ({ id: f.id, label: f.label })),
    scope: scopeField
      ? { fieldId: scopeField.id, label: scopeField.label, values: [...scopeValues].map((id) => ({ id, label: scopeField?.options.find((o) => o.id === id)?.label ?? '?' })) }
      : { all: true, label: 'Весь реестр' },
    missing, noKey, outOfScopeRows, badKeyRows, incompleteScan,
    status: st ? { fieldId: st.id, options: st.options.filter((o) => !o.archived).map((o) => ({ id: o.id, label: o.label, isClosed: o.isClosed })) } : null,
    missingIds: new Set(missing.map((m) => m.id)), values,
  };
}

/**
 * «Неполный скан»: хосты прошлого отчёта, которых нет в новом. Прошлый отчёт — выбранный в области
 * «Отчёт сканирования» (одно значение), иначе последний отчёт того же отдела, не в архиве.
 */
async function scanCoverage(db: Db, reg: RegisterDef, department: string, hosts: string[], scopeField: FieldMeta | undefined, scopeValues: Set<string>) {
  let report = null;
  if (scopeField?.systemKey === 'report' && scopeValues.size === 1) {
    const label = scopeField.options.find((o) => scopeValues.has(o.id))?.label;
    if (label) report = await db.scanReport.findFirst({ where: { registerId: reg.id, label }, orderBy: { createdAt: 'desc' }, include: { hosts: true } });
  }
  if (!report) {
    const all = await db.scanReport.findMany({ where: { registerId: reg.id, archivedAt: null }, orderBy: { createdAt: 'desc' }, include: { hosts: true }, take: 50 });
    report = all.find((r) => scanNorm(r.department) === scanNorm(department)) ?? null;
  }
  if (!report) return null;
  const now = new Set(hosts.map(scanNorm));
  const missingHosts = report.hosts.filter((h) => !now.has(scanNorm(h.name))).map((h) => h.name);
  return missingHosts.length ? { previousReport: report.label, missingHosts } : null;
}

async function loadImport(db: Db, importId: string) {
  const imp = await db.registerImport.findUnique({ where: { id: importId }, include: { file: true } });
  if (!imp || (imp.kind !== 'records' && imp.kind !== 'scan')) throw notFound('Импорт');
  return imp;
}

const toResult = (c: Computed): CompareResult => ({
  importId: c.importId, file: c.file, format: c.format, key: c.key, scope: c.scope, missing: c.missing,
  noKey: c.noKey, outOfScopeRows: c.outOfScopeRows, badKeyRows: c.badKeyRows, incompleteScan: c.incompleteScan, status: c.status,
});

/** Сравнение: файл из окна импорта (sha256 = предпросмотр), область — обязательно. Записи не меняются. */
export async function compareWithRegister(db: Db, store: FileStore, actor: Actor, importId: string, buffer: Buffer, scope: CompareScope): Promise<CompareResult> {
  const imp = await loadImport(db, importId);
  const reg = await loadRegister(db, imp.registerId);
  assertNotArchived(reg);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== imp.fileSha256) throw badRequest('FILE_MISMATCH', 'Это не тот файл, что в предпросмотре импорта. Загрузите его снова');
  // Файл — доказательство: в хранилище один раз на предпросмотр импорта.
  let file = imp.file && imp.file.sha256 === sha256 && !imp.file.deletedAt ? { id: imp.file.id, name: imp.file.originalName, sha256 } : null;
  if (!file) {
    const up = await uploadFile(db, store, actor, imp.fileName, buffer);
    await db.registerImport.update({ where: { id: imp.id }, data: { fileId: up.id } });
    file = { id: up.id, name: up.name, sha256 };
  }
  const c = await compute(db, reg, imp, buffer, file, scope);
  await auditSettings(db, actor, {
    action: 'register.compare.run', entity: 'register', entityId: reg.id,
    summary: `«${reg.name}»: сравнение с файлом «${file.name}» (${c.scope.label}${'values' in c.scope ? `: ${c.scope.values.map((v) => v.label).join(', ')}` : ''}) — нет в файле ${c.missing.length}${c.incompleteScan ? `; неполный скан: нет хостов ${c.incompleteScan.missingHosts.length}` : ''}`,
    after: { importId, fileId: file.id, sha256, key: c.key.map((k) => k.id), scope, missing: c.missing.length, noKey: c.noKey, incompleteScan: c.incompleteScan },
  });
  return toResult(c);
}

export interface StatusChange {
  recordId: string;
  optionId: string;
}

export interface StatusPreview {
  total: number;
  willChange: number;
  skipped: { number: number | null; reason: string }[];
  incompleteScan: CompareResult['incompleteScan'];
}

async function planStatus(db: Db, store: FileStore, importId: string, scope: CompareScope, changes: StatusChange[], reason: string | null) {
  const imp = await loadImport(db, importId);
  if (!imp.file || imp.file.deletedAt) throw conflict('COMPARE_FILE_MISSING', 'Сначала выполните сравнение с реестром');
  const reg = await loadRegister(db, imp.registerId);
  assertNotArchived(reg);
  const st = statusField(reg);
  if (!st) throw badRequest('NO_STATUS', 'В реестре нет поля статуса');
  const buffer = await readAll(store.open(imp.file.storageKey));
  const file = { id: imp.file.id, name: imp.file.originalName, sha256: imp.file.sha256 };
  // Сравнение заново: изменить можно только то, чего по-прежнему нет в файле.
  const c = await compute(db, reg, imp, buffer, file, scope);
  const apply: (StatusChange & { version: number; number: number })[] = [];
  const skipped: StatusPreview['skipped'] = [];
  const seen = new Set<string>();
  for (const ch of changes) {
    if (seen.has(ch.recordId)) continue;
    seen.add(ch.recordId);
    const m = c.missing.find((x) => x.id === ch.recordId);
    const rec = c.values.get(ch.recordId);
    if (!m || !rec) {
      skipped.push({ number: null, reason: 'запись нашлась в файле, закрыта, в архиве или вне области' });
      continue;
    }
    if (!st.options.some((o) => o.id === ch.optionId && !o.archived)) throw badRequest('BAD_STATUS', 'Нет такого значения статуса. Обновите страницу');
    if (rec.values[st.id] === ch.optionId) {
      skipped.push({ number: m.number, reason: 'уже этот статус' });
      continue;
    }
    const after = { ...rec.values, [st.id]: ch.optionId };
    const blocked = lockErrors(reg, rec.values, after, [st.id], reason);
    if (blocked.length) {
      skipped.push({ number: m.number, reason: blocked[0]?.message ?? 'зафиксировано статусом записи' });
      continue;
    }
    apply.push({ ...ch, version: rec.version, number: m.number });
  }
  return { reg, imp, c, st, apply, skipped };
}

export async function previewCompareStatus(db: Db, store: FileStore, importId: string, scope: CompareScope, changes: StatusChange[], reason: string | null): Promise<StatusPreview> {
  const p = await planStatus(db, store, importId, scope, changes, reason);
  return { total: changes.length, willChange: p.apply.length, skipped: p.skipped, incompleteScan: p.c.incompleteScan };
}

export async function applyCompareStatus(
  db: Db, store: FileStore, actor: Actor, importId: string, scope: CompareScope, changes: StatusChange[],
  opts: { expected: { willChange: number }; reason: string | null; acknowledgeIncompleteScan: boolean },
): Promise<{ changed: number; skipped: number }> {
  const p = await planStatus(db, store, importId, scope, changes, opts.reason);
  if (p.apply.length !== opts.expected.willChange) {
    throw new AppError(409, 'BULK_CHANGED', 'Записи изменились после предпросмотра — проверьте числа и подтвердите ещё раз', {
      preview: { total: changes.length, willChange: p.apply.length, skipped: p.skipped, incompleteScan: p.c.incompleteScan },
    });
  }
  if (p.c.incompleteScan && !opts.acknowledgeIncompleteScan) {
    throw conflict('INCOMPLETE_SCAN', `Неполный скан: в отчёте нет хостов ${p.c.incompleteScan.missingHosts.join(', ')}. Подтвердите, что понимаете это`);
  }
  const meta = { via: 'compare', importId, fileId: p.c.file.id, sha256: p.c.file.sha256, fileName: p.c.file.name };
  let changed = 0;
  for (let i = 0; i < p.apply.length; i += COMPARE_BATCH) {
    for (const ch of p.apply.slice(i, i + COMPARE_BATCH)) {
      await updateRecord(db, actor, ch.recordId, { version: ch.version, values: { [p.st.id]: ch.optionId }, reason: opts.reason }, meta);
      changed++;
    }
  }
  const label = (id: string) => p.st.options.find((o) => o.id === id)?.label ?? '?';
  await auditSettings(db, actor, {
    action: 'register_records.compare_status', entity: 'register', entityId: p.reg.id,
    summary: `«${p.reg.name}»: по сравнению с файлом «${p.c.file.name}» статус изменён у ${changed} записей${p.skipped.length ? `, пропущено ${p.skipped.length}` : ''}${p.c.incompleteScan ? ' (неполный скан подтверждён)' : ''}`,
    after: {
      ...meta, scope, changed, skipped: p.skipped.length,
      changes: p.apply.map((a) => ({ recordId: a.recordId, number: a.number, status: label(a.optionId) })),
      incompleteScan: p.c.incompleteScan,
    },
  });
  return { changed, skipped: p.skipped.length };
}
