// Сравнение с реестром (релиз 1.1.0, задача 4, ADR-0017): какие открытые записи области есть в реестре,
// но нет в файле — выгрузке реестра. Реестр уязвимостей сравнивается при импорте скана в узел (релиз 1.5.0, ADR-0029).
// Файл берётся из предпросмотра импорта (та же sha256),
// хранится в files как доказательство (register_imports.file_id). Записи при сравнении не меняются.
// Сотрудник проставляет статус отсутствующим: предпросмотр → применение с expected (ADR-0016), пакетами,
// обычной правкой записи с историей; в журнале — id и sha256 файла.
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import type { FileStore } from '../../lib/file-store.js';
import type { StoredValue, Values } from '../../lib/register-values.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { uploadFile } from '../files/service.js';
import { isVulnRegister } from '../vulns/definition.js';
import { assertNotArchived, isClosed, loadRegister, normalizeImportKeys, type FieldMeta, type RegisterDef } from './definition.js';
import { mapColumns, openRegisterSheet, readFileRows } from './excel.service.js';
import { lockErrors } from './record-rules.js';
import { updateRecord } from './records.service.js';

export const COMPARE_BATCH = 200;

/**
 * Область: весь реестр (явный выбор) или условия по полям из настроек реестра — все должны выполняться
 * (по умолчанию для отчёта сканера: отдел и система, этап Б.2). Прежний вид { fieldId, values } — одно условие.
 */
export type ScopeCondition = { fieldId: string; values: string[] };
export type CompareScope = { all: true } | { conditions: ScopeCondition[] } | ScopeCondition;

const conditionsOf = (scope: CompareScope): ScopeCondition[] | null =>
  'all' in scope ? null : 'conditions' in scope ? scope.conditions : [scope];

/** «отдел «Отдел платёжных карт», система «АБС»» — подпись области на экране сравнения и в журнале. */
export function scopeLabel(fields: { label: string; values: string[] }[]): string {
  return fields.map((c) => `${c.label.charAt(0).toLowerCase()}${c.label.slice(1)} ${c.values.map((v) => `«${v}»`).join(', ')}`).join(', ');
}

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
  /** Поля ключа по порядку; пусто — по колонке ID. */
  key: { id: string; label: string }[];
  scope: { all: true; label: string } | { conditions: { fieldId: string; label: string; values: { id: string; label: string }[] }[]; label: string };
  /** Открытые записи области с заполненным ключом, которых нет в файле. */
  missing: MissingRecord[];
  /** Открытые записи области с пустым ключом — не сопоставляются, без действий. */
  noKey: number;
  /** Строки файла с другим значением поля области — не сравниваются. */
  outOfScopeRows: number;
  /** Строки файла, ключ которых не разобран (пусто или ошибка ячейки). */
  badKeyRows: number;
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

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
};

interface Computed extends CompareResult {
  missingIds: Set<string>;
  values: Map<string, { version: number; values: Values }>;
}

async function compute(db: Db, reg: RegisterDef, imp: { id: string }, buffer: Buffer, file: CompareResult['file'], scope: CompareScope): Promise<Computed> {
  const keyFields = reg.compareKeyFieldIds.map((id) => reg.fields.find((f) => f.id === id && !f.archived)).filter((f): f is FieldMeta => !!f);
  const byId = keyFields.length === 0;
  // Область: проверка по настройкам реестра.
  const conds = conditionsOf(scope);
  if (conds && !conds.length) throw badRequest('BAD_SCOPE', 'Выберите область сравнения или «Весь реестр»');
  const where = (conds ?? []).map((c) => {
    if (!reg.compareScopeFieldIds.includes(c.fieldId)) throw badRequest('BAD_SCOPE', 'Область выбирается по полям из настроек сравнения реестра');
    const field = reg.fields.find((f) => f.id === c.fieldId && !f.archived);
    if (!field) throw badRequest('BAD_SCOPE', 'Поле области не найдено. Обновите страницу');
    if (!c.values.length) throw badRequest('BAD_SCOPE', `Выберите значения «${field.label}» или «Весь реестр»`);
    return { field, values: new Set(c.values) };
  });
  const inScope = (values: Values) => where.every((w) => w.values.has(String(values[w.field.id] ?? '')));

  // Строки файла → значения полей ключа и области.
  const fileRows: { values: Map<string, StoredValue | null>; number: number | null; badKey: boolean }[] = [];
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
    if (where.some((w) => r.values.has(w.field.id) && r.values.get(w.field.id) != null && !w.values.has(String(r.values.get(w.field.id))))) {
      outOfScopeRows++;
      continue;
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
    importId: imp.id, file,
    key: keyFields.map((f) => ({ id: f.id, label: f.label })),
    scope: where.length
      ? (() => {
        const conditions = where.map((w) => ({
          fieldId: w.field.id, label: w.field.label,
          values: [...w.values].map((id) => ({ id, label: w.field.options.find((o) => o.id === id)?.label ?? '?' })),
        }));
        return { conditions, label: scopeLabel(conditions.map((c) => ({ label: c.label, values: c.values.map((v) => v.label) }))) };
      })()
      : { all: true, label: 'Весь реестр' },
    missing, noKey, outOfScopeRows, badKeyRows,
    status: st ? { fieldId: st.id, options: st.options.filter((o) => !o.archived).map((o) => ({ id: o.id, label: o.label, isClosed: o.isClosed })) } : null,
    missingIds: new Set(missing.map((m) => m.id)), values,
  };
}

async function loadImport(db: Db, importId: string) {
  const imp = await db.registerImport.findUnique({ where: { id: importId }, include: { file: true } });
  if (!imp || imp.kind !== 'records') throw notFound('Импорт');
  return imp;
}

/** Реестр уязвимостей сравнивается при импорте скана в узел: записи принадлежат узлам, а не всему реестру. */
function assertNotVulns(reg: RegisterDef) {
  if (isVulnRegister(reg)) throw conflict('VULN_COMPARE_IN_NODE', 'Реестр уязвимостей сравнивается при импорте скана: откройте узел в разделе «Уязвимости»');
}

const toResult = (c: Computed): CompareResult => ({
  importId: c.importId, file: c.file, key: c.key, scope: c.scope, missing: c.missing,
  noKey: c.noKey, outOfScopeRows: c.outOfScopeRows, badKeyRows: c.badKeyRows, status: c.status,
});

/** Сравнение: файл из окна импорта (sha256 = предпросмотр), область — обязательно. Записи не меняются. */
export async function compareWithRegister(db: Db, store: FileStore, actor: Actor, importId: string, buffer: Buffer, scope: CompareScope): Promise<CompareResult> {
  const imp = await loadImport(db, importId);
  const reg = await loadRegister(db, imp.registerId);
  assertNotArchived(reg);
  assertNotVulns(reg);
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
    summary: `«${reg.name}»: сравнение с файлом «${file.name}» (${c.scope.label}) — нет в файле ${c.missing.length}`,
    after: { importId, fileId: file.id, sha256, key: c.key.map((k) => k.id), scope, missing: c.missing.length, noKey: c.noKey },
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
}

async function planStatus(db: Db, store: FileStore, importId: string, scope: CompareScope, changes: StatusChange[], reason: string | null) {
  const imp = await loadImport(db, importId);
  if (!imp.file || imp.file.deletedAt) throw conflict('COMPARE_FILE_MISSING', 'Сначала выполните сравнение с реестром');
  const reg = await loadRegister(db, imp.registerId);
  assertNotArchived(reg);
  assertNotVulns(reg);
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
  return { total: changes.length, willChange: p.apply.length, skipped: p.skipped };
}

export async function applyCompareStatus(
  db: Db, store: FileStore, actor: Actor, importId: string, scope: CompareScope, changes: StatusChange[],
  opts: { expected: { willChange: number }; reason: string | null },
): Promise<{ changed: number; skipped: number }> {
  const p = await planStatus(db, store, importId, scope, changes, opts.reason);
  if (p.apply.length !== opts.expected.willChange) {
    throw new AppError(409, 'BULK_CHANGED', 'Записи изменились после предпросмотра — проверьте числа и подтвердите ещё раз', {
      preview: { total: changes.length, willChange: p.apply.length, skipped: p.skipped },
    });
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
    summary: `«${p.reg.name}»: по сравнению с файлом «${p.c.file.name}» статус изменён у ${changed} записей${p.skipped.length ? `, пропущено ${p.skipped.length}` : ''}`,
    after: {
      ...meta, scope, changed, skipped: p.skipped.length,
      changes: p.apply.map((a) => ({ recordId: a.recordId, number: a.number, status: label(a.optionId) })),
    },
  });
  return { changed, skipped: p.skipped.length };
}
