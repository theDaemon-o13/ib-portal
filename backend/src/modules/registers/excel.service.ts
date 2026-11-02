// Экспорт реестра в Excel и импорт обратно с обновлением по колонке ID (CLAUDE.md, раздел 7, п. 7).
// Импорт всегда в два шага: предпросмотр (ничего не меняет) → применение одной транзакцией.
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import ExcelJS from 'exceljs';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { textLimit } from '../../lib/field-settings.js';
import {
  cellPrimitive,
  displayValue,
  formatNumberRu,
  isWritable,
  linkKey,
  parseCell,
  sameValue,
  type StoredValue,
  type Values,
} from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { isVulnRegister } from '../vulns/definition.js';
import { applyDerived } from '../vulns/derive.js';
import {
  assertNotArchived,
  importKeyField,
  loadRegister,
  normalizeImportKeys,
  loadUsers,
  searchTextOf,
  toRecordDtos,
  userIdsIn,
  type FieldMeta,
  type RegisterDef,
} from './definition.js';
import { baseSql, closedSql, filterSql, type RecordFilter } from './filter.js';
import { linkIdsIn, linkLabels, loadLinkRefs } from './links.js';
import { applyDateDefaults, dateErrors, lockErrors } from './record-rules.js';
import { nextNumbers } from './records.service.js';

export const IMPORT_MAX_ROWS = 20_000;
export const IMPORT_TTL_MS = 30 * 60 * 1000;
export const MAP_SHEET = '_поля';
export const MAIN_SHEET = 'Реестр';
export const HELP_SHEET = 'Справка';
const MAP_MARK = 'ibportal-register';

const TYPE_HELP: Record<string, string> = {
  text: 'Любой текст.',
  number: 'Число. Дробная часть — через запятую или точку.',
  date: 'Дата в формате ДД.ММ.ГГГГ или ячейка с датой Excel.',
  select: 'Одно из значений списка (см. колонку «Допустимые значения»).',
  catalog: 'Одно из значений справочника (см. колонку «Допустимые значения»).',
  user: 'Сотрудник в виде «ФИО (логин)» — ищется по логину в скобках. Можно указать только ФИО, если такое имя у единственного сотрудника.',
  calc: 'Только для чтения: считается порталом, при импорте не меняется.',
  decision: 'Только для чтения: решение вносится на портале с документом-основанием.',
  file: 'Только для чтения: имена файлов. Файлы прикладываются в карточке записи на портале.',
  link: 'Записи связанного реестра через «;»: по ключу импорта или заголовку (например, имя хоста) либо «#номер».',
};
const TYPE_NAME: Record<string, string> = {
  text: 'Текст', number: 'Число', date: 'Дата', select: 'Список', user: 'Сотрудник', calc: 'Вычисляемое', decision: 'Решение другого отдела',
  catalog: 'Значение справочника', file: 'Файл', link: 'Связь с записью',
};

/**
 * Записи реестров, на которые ссылаются поля «Связь с записью»: ключ → id. Ключи — «#номер», заголовок
 * и значение ключа импорта (без регистра и лишних пробелов). Повтор ключа — несколько id (неоднозначно).
 */
export async function linkTargetsOf(db: Db, reg: RegisterDef): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>();
  const cache = new Map<string, Map<string, string[]>>();
  for (const f of reg.fields.filter((x) => x.type === 'link' && x.linkRegisterId)) {
    const targetId = f.linkRegisterId as string;
    let map = cache.get(targetId);
    if (!map) {
      const target = await loadRegister(db, targetId);
      const title = target.fields.find((x) => x.isTitle);
      const rows = await db.registerRecord.findMany({ where: { registerId: targetId, deletedAt: null }, select: { id: true, number: true, values: true, importKey: true } });
      map = new Map<string, string[]>();
      const add = (k: string | null | undefined, id: string) => {
        if (!k) return;
        const key = linkKey(k);
        const list = map?.get(key) ?? [];
        if (!list.includes(id)) map?.set(key, [...list, id]);
      };
      for (const r of rows) {
        add(`#${r.number}`, r.id);
        add(r.importKey, r.id);
        const t = title ? (r.values as Values)[title.id] : undefined;
        if (typeof t === 'string') add(t, r.id);
      }
      cache.set(targetId, map);
    }
    out.set(f.id, map);
  }
  return out;
}

/** derived — колонка портала без поля («Дней до срока»): при импорте пропускается молча. */
type ColKind = 'id' | 'value' | 'readonly' | 'doc' | 'derived';
const DAYS_LEFT_HEADER = 'Дней до срока';

// ---------------------------------------------------------------- экспорт

export interface ExportOptions {
  /** Отбор записей (SQL-часть фильтра): выгрузка для проверки — период по дате документа. */
  filter?: RecordFilter;
  /** С записями в архиве (истёкшие разрешения хранятся навсегда). */
  includeArchived?: boolean;
  /** Дополнительный лист книги (опись файлов архива). */
  extra?: (wb: ExcelJS.Workbook) => void;
}

const exportSelect = { id: true, number: true, values: true, version: true, archivedAt: true, createdAt: true, updatedAt: true } as const;

/** Записи выгрузки по номеру: все действующие или по фильтру. */
export async function exportRows(db: Db, reg: RegisterDef, opts: ExportOptions = {}) {
  if (!opts.filter && !opts.includeArchived) {
    return db.registerRecord.findMany({ where: { registerId: reg.id, deletedAt: null, archivedAt: null }, select: exportSelect, orderBy: { number: 'asc' } });
  }
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT r.id::text FROM register_records r WHERE ${baseSql(reg.id, opts.includeArchived)} ${filterSql(reg, opts.filter ?? {})}`;
  return db.registerRecord.findMany({ where: { id: { in: ids.map((r) => r.id) } }, select: exportSelect, orderBy: { number: 'asc' } });
}

export async function exportRegister(db: Db, registerId: string, opts: ExportOptions = {}): Promise<{ fileName: string; buffer: Buffer }> {
  const reg = await loadRegister(db, registerId);
  const fields = reg.fields.filter((f) => !f.archived);
  const rows = await exportRows(db, reg, opts);
  const dtos = await toRecordDtos(db, reg, rows);
  const users = await loadUsers(db, userIdsIn(reg, rows.map((r) => r.values as Values)));
  // Связь — заголовками связанных записей («WS-BUH-014»): по ним импорт найдёт записи обратно.
  const refs = await loadLinkRefs(db, linkIdsIn(reg, rows.map((r) => r.values as Values)));
  const linkTitles = new Map([...refs.values()].map((r) => [r.id, r.title || `#${r.number}`]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Портал ИБ';
  wb.created = new Date();
  const ws = wb.addWorksheet(MAIN_SHEET, { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  const map = wb.addWorksheet(MAP_SHEET);
  map.state = 'veryHidden';
  map.addRow([MAP_MARK, reg.id]);

  const cols: { header: string; kind: ColKind; field?: FieldMeta }[] = [{ header: 'ID', kind: 'id' }];
  for (const f of fields) {
    if (f.type === 'calc' || f.type === 'file' || f.managed) cols.push({ header: f.label, kind: 'readonly', field: f });
    else if (f.type === 'decision') {
      cols.push({ header: f.label, kind: 'readonly', field: f });
      cols.push({ header: `${f.label}: документ`, kind: 'doc', field: f });
    } else cols.push({ header: f.label, kind: 'value', field: f });
  }
  // Контроль сроков: дни до срока на дату выгрузки; у закрытых записей пусто.
  const hasDeadline = dtos.some((d) => d.deadline !== null);
  if (hasDeadline) cols.push({ header: DAYS_LEFT_HEADER, kind: 'derived' });
  cols.forEach((c, i) => map.addRow([i + 1, c.field?.id ?? '', c.kind]));

  ws.columns = cols.map((c) => ({
    header: c.header,
    width: c.kind === 'id' ? 8 : c.field?.type === 'date' || c.field?.type === 'calc' ? 14 : Math.min(48, Math.max(14, c.header.length + 4)),
  }));
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
  // Многострочный текст — широкая колонка с переносом строк.
  cols.forEach((c, i) => {
    if (c.field?.settings.text?.multiline) {
      const col = ws.getColumn(i + 1);
      col.width = 60;
      col.alignment = { wrapText: true, vertical: 'top' };
    }
  });
  const grey = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFF4' } } as const;

  for (const [i, rec] of dtos.entries()) {
    const values = rows[i]?.values as Values;
    const row = ws.addRow(cols.map((c) => {
      if (c.kind === 'id') return rec.number;
      if (c.kind === 'derived') return rec.deadline?.state === 'closed' ? null : rec.deadline?.daysLeft ?? null;
      const f = c.field as FieldMeta;
      if (c.kind === 'doc') {
        const d = rec.decisions[f.id];
        return d ? `${d.documentTitle} № ${d.documentNumber} от ${d.documentDate.split('-').reverse().join('.')}` : '';
      }
      if (f.type === 'calc' && rec.basis[f.id]) return rec.display[f.id] ?? '';
      if (f.type === 'calc') {
        const v = rec.calc[f.id];
        // Оценка уязвимости — число, срок — дата.
        if (typeof v === 'number') return v;
        return typeof v === 'string' ? new Date(`${v}T00:00:00Z`) : null;
      }
      if (f.type === 'decision' || f.type === 'file') return rec.display[f.id] ?? '';
      const v = values[f.id];
      if (v === undefined) return null;
      if (f.type === 'number') return typeof v === 'number' ? v : Number(v);
      if (f.type === 'date') return new Date(`${String(v)}T00:00:00Z`);
      // Сотрудник — «ФИО (логин)»: по логину импорт найдёт его однозначно.
      return displayValue(f, v, { users, userWithLogin: true, links: linkTitles });
    }));
    cols.forEach((c, j) => {
      const cell = row.getCell(j + 1);
      if (c.field?.type === 'date' || (c.field?.type === 'calc' && cell.value instanceof Date)) cell.numFmt = 'dd.mm.yyyy';
      if (c.kind === 'readonly' || c.kind === 'doc' || c.kind === 'id' || c.kind === 'derived') cell.fill = grey;
    });
  }
  cols.forEach((c, j) => {
    if (c.kind === 'readonly' || c.kind === 'doc' || c.kind === 'derived') {
      const cell = header.getCell(j + 1);
      cell.fill = grey;
      cell.note = 'Только для чтения: при импорте не меняется';
    }
  });
  header.getCell(1).note = 'Номер записи. Не меняйте. Пустая ячейка — новая запись';

  const help = wb.addWorksheet(HELP_SHEET);
  help.columns = [{ header: 'Поле', width: 32 }, { header: 'Тип', width: 22 }, { header: 'Что вводить', width: 70 }, { header: 'Допустимые значения', width: 50 }];
  help.getRow(1).font = { bold: true };
  help.addRow(['ID', 'Номер записи', 'Не меняйте. Пустая ячейка ID — новая запись. Неизвестный ID — ошибка, запись не создаётся.', '']);
  for (const f of fields) {
    help.addRow([
      f.label,
      TYPE_NAME[f.type] ?? f.type,
      TYPE_HELP[f.type] ?? '',
      f.type === 'select' || f.type === 'catalog'
        ? f.options.filter((o) => !o.archived).map((o) => o.label).join('; ')
        : f.type === 'text' ? `До ${textLimit(f.settings)} символов${f.settings.text?.multiline ? ', можно с переносами строк' : ''}` : '',
    ]);
  }
  help.addRow([]);
  for (const line of [
    'Как работает импорт:',
    '1. Строки обновляют записи по колонке ID; пустой ID — новая запись.',
    '2. Пустая ячейка не меняет значение. Очистить поле можно в карточке записи на портале.',
    '3. Серые колонки — только для чтения: вычисляемые сроки, решения другого отдела и файлы при импорте не меняются.',
    '4. Сотрудник: «ФИО (логин)». Только ФИО — если такое имя у единственного сотрудника, иначе ошибка.',
    '5. Перед применением портал показывает предпросмотр: что добавится, что изменится, строки с ошибками.',
  ]) help.addRow([line]);
  const key = importKeyField(reg);
  if (key) help.addRow([`6. Без колонки ID строки сопоставляются по «${key.label}» (ключ импорта): найдена запись — обновление, нет — новая запись. Регистр и лишние пробелы не важны.`]);
  help.getColumn(3).alignment = { wrapText: true, vertical: 'top' };
  opts.extra?.(wb);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const date = new Date().toISOString().slice(0, 10);
  return { fileName: `${reg.name} ${date}.xlsx`, buffer };
}

// ---------------------------------------------------------------- импорт: предпросмотр

export interface ImportIssue {
  row: number;
  id: string | null;
  field: string | null;
  message: string;
}

/** Сопоставление строки файла с записью: по ID или по ключу импорта (этап 8). */
export interface ImportMatch {
  row: number;
  /** Значение ID или ключа из файла, как написано. */
  key: string;
  /** Номер найденной записи; null — новая запись или ошибка. */
  number: number | null;
  action: 'add' | 'update' | 'unchanged' | 'error';
}

/** Действующая запись, которой нет в файле (импорт по ключу): кандидат на «Выведено». Портал её не меняет. */
export interface ImportMissing {
  id: string;
  number: number;
  key: string;
  title: string;
}

export interface ImportSummary {
  fileName: string;
  rows: number;
  added: number;
  updated: number;
  unchanged: number;
  errorRows: number;
  fieldChanges: { fieldId: string; label: string; count: number }[];
  errors: ImportIssue[];
  warnings: string[];
  /** id — по колонке ID; key — по полю-ключу импорта. */
  matchBy: 'id' | 'key';
  keyField: { id: string; label: string } | null;
  matches: ImportMatch[];
  missing: ImportMissing[];
  missingTotal: number;
  /** Адаптер импорта (1.6.0, ADR-0032): сведения об источнике — тип отчёта, итог сводки, дубли. */
  source?: Record<string, unknown>;
  /** Блоки предпросмотра адаптера: что будет создано, дубли в источнике. optional — можно снять при применении. */
  blocks?: ImportBlock[];
}

export interface ImportBlock {
  code: string;
  title: string;
  hint: string | null;
  items: string[];
  total: number;
  optional: boolean;
}

/**
 * Адаптер импорта (релиз 1.6.0, ADR-0032): превращает чужой файл (отчёт KSC, реестр сервисов) в лист с колонками
 * по названиям полей и передаёт его этому же конвейеру — предпросмотр, применение одной транзакцией, проверка версий.
 */
export interface ImportAdapter {
  wb: ExcelJS.Workbook;
  ws: ExcelJS.Worksheet;
  /** Служебные поля, которые ставит этот адаптер. */
  managedWritable: string[];
  /** Поля, которые ставятся только у новой записи: у найденной не перезаписываются (имя, тип, источник). */
  createOnly: string[];
  /** «Нет в файле»: false — не считать; scope — только среди записей с этим значением списка. */
  missing: boolean | { fieldId: string; optionId: string };
  /** Значения списков, которых ещё нет: создаются при применении. В ячейке — метка, в значении — токен. */
  newOptions: { fieldId: string; label: string; token: string }[];
  /** Записи других реестров, которые создаются при применении до строк; на них ссылаются поля связи по токену. */
  newRecords: NewRecordGroup[];
  /** Ключ связи (как в ячейке) → токен новой записи, по полям связи. */
  linkTokens: Record<string, Record<string, string>>;
  source: Record<string, unknown>;
  warnings: string[];
  blocks: ImportBlock[];
}

export interface NewRecordGroup {
  /** Код блока предпросмотра: снятый блок не создаётся, ссылки на его записи убираются. */
  block: string;
  registerId: string;
  items: { token: string; values: Values }[];
}

interface ImportPayload {
  creates: { row: number; values: Values }[];
  updates: { row: number; recordId: string; number: number; version: number; changes: Values }[];
  fieldVersions: Record<string, number>;
  newOptions?: ImportAdapter['newOptions'];
  newRecords?: NewRecordGroup[];
}

/** Токен записи или значения списка, которые создаст применение. */
export const NEW_TOKEN = /^new:/;

const MAX_ISSUES = 500;
const MAX_MISSING = 2000;

export type ColMap = Map<number, { kind: ColKind; field?: FieldMeta }>;

export function mapColumns(
  wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, reg: RegisterDef, warnings: string[], managedWritable: readonly string[] = [],
): { cols: ColMap; matchBy: 'id' | 'key' } {
  const writable = (f: FieldMeta) => isWritable(f.type) && (!f.managed || managedWritable.includes(f.id));
  const cols: ColMap = new Map();
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(cellPrimitive(cell.value) ?? '').trim();
  });
  const map = wb.getWorksheet(MAP_SHEET);
  if (map && String(cellPrimitive(map.getCell('A1').value) ?? '') === MAP_MARK) {
    if (String(cellPrimitive(map.getCell('B1').value) ?? '') !== reg.id) {
      throw badRequest('WRONG_REGISTER', 'Файл выгружен из другого реестра');
    }
    // Колонки сопоставляются по id поля: импорт работает, даже если поле переименовали после выгрузки.
    map.eachRow((row, n) => {
      if (n === 1) return;
      const col = Number(cellPrimitive(row.getCell(1).value));
      const fieldId = String(cellPrimitive(row.getCell(2).value) ?? '');
      const kind = String(cellPrimitive(row.getCell(3).value) ?? '') as ColKind;
      if (!Number.isInteger(col) || kind === 'derived') return;
      if (kind === 'id') {
        cols.set(col, { kind });
        return;
      }
      const field = reg.fields.find((f) => f.id === fieldId);
      if (!field) {
        warnings.push(`Колонка «${headers[col] ?? col}»: поле удалено из реестра — колонка пропущена`);
        return;
      }
      if (field.archived) {
        warnings.push(`Колонка «${headers[col] ?? col}»: поле «${field.label}» в архиве — колонка пропущена`);
        return;
      }
      cols.set(col, { kind: isWritable(field.type) && !field.managed && kind === 'value' ? 'value' : kind === 'doc' ? 'doc' : 'readonly', field });
    });
  } else {
    // Файл без служебного листа: колонки по точному названию поля.
    headers.forEach((h, col) => {
      if (!h) return;
      if (h.toLowerCase() === 'id') {
        cols.set(col, { kind: 'id' });
        return;
      }
      if (h.toLowerCase() === DAYS_LEFT_HEADER.toLowerCase()) return;
      const field = reg.fields.find((f) => f.label.trim().toLowerCase() === h.toLowerCase());
      const docField = reg.fields.find((f) => f.type === 'decision' && `${f.label}: документ`.toLowerCase() === h.toLowerCase());
      if (docField) cols.set(col, { kind: 'doc', field: docField });
      else if (!field) warnings.push(`Колонка «${h}» не совпадает ни с одним полем реестра — пропущена`);
      else if (field.archived) warnings.push(`Колонка «${h}»: поле в архиве — пропущена`);
      else cols.set(col, { kind: writable(field) ? 'value' : 'readonly', field });
    });
  }
  if ([...cols.values()].some((c) => c.kind === 'id')) return { cols, matchBy: 'id' };
  // Без колонки ID — по ключу импорта, если он задан и его колонка есть в файле (выгрузка Device Monitor и т. п.).
  const key = importKeyField(reg);
  if (key && [...cols.values()].some((c) => c.kind === 'value' && c.field?.id === key.id)) return { cols, matchBy: 'key' };
  throw badRequest('NO_ID_COLUMN', key
    ? `В файле нет колонки ID и колонки ключа «${key.label}». Добавьте одну из них или выгрузите реестр кнопкой «Экспорт в Excel»`
    : 'В файле нет колонки ID. Выгрузите реестр кнопкой «Экспорт в Excel» и заполните этот файл');
}

export async function readWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw badRequest('BAD_FILE', 'Не удалось прочитать файл. Нужна книга Excel (.xlsx)');
  }
  return wb;
}

/** Текст ячейки ключа или ID — как написано в файле. */
function cellText(v: ReturnType<typeof cellPrimitive>): string {
  if (v === null) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).trim();
}

const recordCols = { id: true, number: true, values: true, version: true, archivedAt: true, deletedAt: true, createdAt: true, updatedAt: true } as const;

/** Книга выгрузки реестра: лист с данными (основной или первый видимый), не больше IMPORT_MAX_ROWS строк. */
export async function openRegisterSheet(buffer: Buffer): Promise<{ wb: ExcelJS.Workbook; ws: ExcelJS.Worksheet }> {
  if (buffer.length === 0) throw badRequest('BAD_FILE', 'Файл пустой');
  const wb = await readWorkbook(buffer);
  const ws = wb.getWorksheet(MAIN_SHEET) ?? wb.worksheets.find((w) => w.name !== MAP_SHEET && w.name !== HELP_SHEET && w.state === 'visible');
  if (!ws) throw badRequest('BAD_FILE', 'В книге нет листа с данными');
  if (ws.rowCount - 1 > IMPORT_MAX_ROWS) throw badRequest('TOO_MANY_ROWS', `В файле больше ${IMPORT_MAX_ROWS} строк`);
  return { wb, ws };
}

/** Строка файла: значения вводимых колонок, разобранные как при импорте (пустая ячейка — нет значения). */
export interface FileRow {
  rowNumber: number;
  row: ExcelJS.Row;
  values: { field: FieldMeta; value: StoredValue }[];
  cellErrors: { field: string; message: string }[];
}

/**
 * Строки с данными и разбор ячеек — один код для импорта и сравнения с реестром (релиз 1.1.0):
 * значения в файле читаются одинаково (parseCell: списки по значению, сотрудник по логину, даты и числа).
 */
export async function readFileRows(
  db: Db, reg: RegisterDef, ws: ExcelJS.Worksheet, cols: ColMap, linkTokens: ImportAdapter['linkTokens'] = {},
): Promise<FileRow[]> {
  const allUsers = await db.user.findMany({ select: { id: true, login: true, fullName: true, isActive: true } });
  const linkTargets = await linkTargetsOf(db, reg);
  // Записи, которые создаст применение: ключ в ячейке → токен.
  for (const [fieldId, tokens] of Object.entries(linkTokens)) {
    const map = new Map(linkTargets.get(fieldId) ?? []);
    for (const [k, token] of Object.entries(tokens)) if (!map.has(linkKey(k))) map.set(linkKey(k), [token]);
    linkTargets.set(fieldId, map);
  }
  const out: FileRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    if ([...cols.keys()].every((c) => cellPrimitive(row.getCell(c).value) === null)) return;
    const values: FileRow['values'] = [];
    const cellErrors: FileRow['cellErrors'] = [];
    for (const [col, c] of cols) {
      if (c.kind !== 'value' || !c.field) continue; // ID и «только для чтения» не импортируются
      const r = parseCell(c.field, row.getCell(col).value, { users: allUsers, linkTargets });
      if (!r.ok) cellErrors.push({ field: c.field.label, message: r.error });
      else if (r.value !== null) values.push({ field: c.field, value: r.value });
    }
    out.push({ rowNumber, row, values, cellErrors });
  });
  return out;
}

export async function previewImport(db: Db, actor: Actor, registerId: string, buffer: Buffer, fileName: string, adapter?: ImportAdapter) {
  const loaded = await loadRegister(db, registerId);
  assertNotArchived(loaded);
  const { wb, ws } = adapter ?? await openRegisterSheet(buffer);
  // Новые значения списков адаптера — варианты с токенами вместо id: строки разбираются как обычно.
  const reg: RegisterDef = adapter?.newOptions.length
    ? {
      ...loaded,
      fields: loaded.fields.map((f) => {
        const extra = adapter.newOptions.filter((o) => o.fieldId === f.id);
        return extra.length
          ? { ...f, options: [...f.options, ...extra.map((o) => ({ id: o.token, label: o.label, isClosed: false, archived: false, sortOrder: 0, version: 0, systemKey: null }))] }
          : f;
      }),
    }
    : loaded;

  const warnings: string[] = [...(adapter?.warnings ?? [])];
  const { cols, matchBy } = mapColumns(wb, ws, reg, warnings, adapter?.managedWritable);
  const keyField = importKeyField(reg) ?? null;
  const idCol = [...cols.entries()].find(([, c]) => c.kind === 'id')?.[0];
  const keyCol = keyField ? [...cols.entries()].find(([, c]) => c.kind === 'value' && c.field?.id === keyField.id)?.[0] : undefined;
  const matchCol = (matchBy === 'id' ? idCol : keyCol) as number;
  const today = todayIso();

  // Первый проход: что в файле в колонке сопоставления.
  const dataRows = await readFileRows(db, reg, ws, cols, adapter?.linkTokens);
  const rawMatch = dataRows.map((d) => cellText(cellPrimitive(d.row.getCell(matchCol).value)));
  // Значения ключа после правок строки (в обоих режимах): проверка уникальности ключа до применения.
  const rawKeys = keyCol ? dataRows.map((d) => cellText(cellPrimitive(d.row.getCell(keyCol).value))) : [];
  const norm = await normalizeImportKeys(db, [...rawKeys, ...(matchBy === 'key' ? rawMatch : [])]);

  type Existing = { id: string; number: number; values: Prisma.JsonValue; version: number; archivedAt: Date | null; deletedAt: Date | null; createdAt: Date; updatedAt: Date };
  let existing: Existing[];
  if (matchBy === 'id') {
    const numbers = rawMatch.filter((v) => /^\d+$/.test(v)).map(Number).filter((n) => n > 0 && Number.isSafeInteger(n));
    existing = await db.registerRecord.findMany({ where: { registerId, number: { in: numbers } }, select: recordCols });
  } else {
    const keys = [...new Set(rawMatch.map((v) => norm.get(v)).filter((k): k is string => !!k))];
    existing = await db.registerRecord.findMany({ where: { registerId, deletedAt: null, importKey: { in: keys } }, select: { ...recordCols, importKey: true } });
  }
  const byNumber = new Map(existing.map((r) => [r.number, r]));
  const byKey = new Map(matchBy === 'key' ? (existing as (Existing & { importKey: string | null })[]).map((r) => [r.importKey as string, r]) : []);
  // Ключ импорта у других записей реестра: новые значения ключа не должны с ними совпасть.
  const keyOwners = new Map<string, { id: string; number: number }>();
  if (keyField) {
    const wanted = [...new Set(rawKeys.map((v) => norm.get(v)).filter((k): k is string => !!k))];
    if (wanted.length) {
      for (const r of await db.registerRecord.findMany({ where: { registerId, deletedAt: null, importKey: { in: wanted } }, select: { id: true, number: true, importKey: true } })) {
        keyOwners.set(r.importKey as string, { id: r.id, number: r.number });
      }
    }
  }
  // Отображаемые значения «только для чтения» (вычисляемый срок, решение) — для предупреждения об изменениях.
  const shownByNumber = new Map(
    (await toRecordDtos(db, reg, existing.filter((r) => !r.deletedAt))).map((d) => [d.number, d.display]),
  );
  const titleField = reg.fields.find((f) => f.isTitle && !f.archived);

  // Повторы в колонке сопоставления: по ID — ошибка в повторе; по ключу — во всех строках с этим ключом
  // (непонятно, какая из них верная).
  const seen = new Map<string, number[]>();
  rawMatch.forEach((v, i) => {
    const k = matchBy === 'key' ? norm.get(v) : /^\d+$/.test(v) ? String(Number(v)) : null;
    if (k) seen.set(k, [...(seen.get(k) ?? []), dataRows[i]?.rowNumber ?? 0]);
  });

  const errors: ImportIssue[] = [];
  const matches: ImportMatch[] = [];
  let errorRows = 0;
  let unchanged = 0;
  let readonlyChanged = 0;
  const fieldCounts = new Map<string, number>();
  const payload: ImportPayload = {
    creates: [],
    updates: [],
    // Архивные поля не участвуют: иначе применение считало бы их «изменившимися» и импорт в реестр с архивным полем не проходил.
    fieldVersions: Object.fromEntries(loaded.fields.filter((f) => !f.archived).map((f) => [f.id, f.version])),
    ...(adapter ? { newOptions: adapter.newOptions, newRecords: adapter.newRecords } : {}),
  };
  const issue = (i: ImportIssue) => {
    if (errors.length < MAX_ISSUES) errors.push(i);
  };
  // Новый ключ → строка, которая его получит (повторы ключа среди изменений файла).
  const keyClaims = new Map<string, number>();

  for (const [i, { row, rowNumber, values: parsed, cellErrors }] of dataRows.entries()) {
    const rowErrors: ImportIssue[] = [];
    const matchRaw = rawMatch[i] ?? '';
    let rec: Existing | undefined;
    if (matchBy === 'id') {
      if (matchRaw !== '') {
        const num = /^\d+$/.test(matchRaw) ? Number(matchRaw) : NaN;
        if (!Number.isInteger(num) || num <= 0) {
          rowErrors.push({ row: rowNumber, id: matchRaw, field: 'ID', message: 'ID — номер записи (целое число)' });
        } else {
          const rows = seen.get(String(num)) ?? [];
          if (rows[0] !== rowNumber) rowErrors.push({ row: rowNumber, id: String(num), field: 'ID', message: `ID ${num} уже встречается в строке ${rows[0]}` });
          rec = byNumber.get(num);
          if (!rec) rowErrors.push({ row: rowNumber, id: String(num), field: 'ID', message: `Записи с ID ${num} нет в реестре — новая запись так не создаётся. Для новой оставьте ID пустым` });
          else if (rec.deletedAt) rowErrors.push({ row: rowNumber, id: String(num), field: 'ID', message: `Запись ${num} удалена` });
          else if (rec.archivedAt) rowErrors.push({ row: rowNumber, id: String(num), field: 'ID', message: `Запись ${num} в архиве — верните её на портале` });
        }
      }
    } else {
      const key = norm.get(matchRaw) ?? null;
      const label = (keyField as FieldMeta).label;
      if (!key) {
        rowErrors.push({ row: rowNumber, id: null, field: label, message: `Заполните «${label}»: по нему строка сопоставляется с записью` });
      } else {
        const rows = seen.get(key) ?? [];
        if (rows.length > 1) {
          rowErrors.push({ row: rowNumber, id: matchRaw, field: label, message: `«${matchRaw}» встречается в строках ${rows.join(', ')} — оставьте одну` });
        }
        rec = byKey.get(key);
        if (rec?.archivedAt) rowErrors.push({ row: rowNumber, id: matchRaw, field: label, message: `Запись #${rec.number} с «${matchRaw}» в архиве — верните её на портале` });
      }
    }
    const current = (rec?.values ?? {}) as Values;
    const changes: Values = {};
    for (const e of cellErrors) rowErrors.push({ row: rowNumber, id: matchRaw || null, field: e.field, message: e.message });
    for (const { field: f, value } of parsed) {
      if (rec && adapter?.createOnly.includes(f.id)) continue;
      if (!sameValue(current[f.id], value)) changes[f.id] = value;
    }
    if (rec) {
      // Изменения в колонках «только чтение» — считаем для предупреждения.
      const shownNow = shownByNumber.get(rec.number) ?? {};
      for (const [col, c] of cols) {
        if (c.kind !== 'readonly' || !c.field) continue;
        const v = cellPrimitive(row.getCell(col).value);
        const inFile = v === null ? ''
          : v instanceof Date ? (Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10).split('-').reverse().join('.'))
          : typeof v === 'number' ? formatNumberRu(v)
          : String(v).trim();
        if (inFile !== (shownNow[c.field.id] ?? '')) readonlyChanged++;
      }
    }
    if (!rec && rowErrors.length === 0 && titleField && changes[titleField.id] === undefined) {
      rowErrors.push({ row: rowNumber, id: null, field: titleField.label, message: `Для новой записи заполните «${titleField.label}»` });
    }
    // Фиксация статусом (этап 8б): зафиксированное и «с причиной» импорт не меняет — только карточка записи.
    // Ограничение «не позже 31.12 года поля N» — по значениям после строки (с датами по умолчанию у новой записи).
    if (rowErrors.length === 0) {
      const merged: Values = { ...current, ...changes };
      const changedIds = Object.keys(changes);
      if (!rec) changedIds.push(...applyDateDefaults(reg, merged, today));
      const label = (fid: string | null) => reg.fields.find((f) => f.id === fid)?.label ?? null;
      for (const e of [...(rec ? lockErrors(reg, current, merged, changedIds, null) : []), ...dateErrors(reg, merged, changedIds)]) {
        const msg = e.code === 'REASON_REQUIRED' ? `${e.message} — измените его в карточке записи` : e.message;
        rowErrors.push({ row: rowNumber, id: matchRaw || null, field: label(e.fieldId), message: msg });
      }
    }
    // Ключ импорта уникален: новое значение не должно принадлежать другой записи или другой строке файла.
    if (keyField && rowErrors.length === 0 && typeof changes[keyField.id] === 'string') {
      const newKey = norm.get(String(changes[keyField.id]).trim()) ?? null;
      const owner = newKey ? keyOwners.get(newKey) : undefined;
      const claimed = newKey ? keyClaims.get(newKey) : undefined;
      if (owner && owner.id !== rec?.id) {
        rowErrors.push({ row: rowNumber, id: matchRaw || null, field: keyField.label, message: `«${changes[keyField.id]}» уже есть в записи #${owner.number}` });
      } else if (newKey && claimed !== undefined) {
        rowErrors.push({ row: rowNumber, id: matchRaw || null, field: keyField.label, message: `«${changes[keyField.id]}» уже встречается в строке ${claimed}` });
      } else if (newKey) {
        keyClaims.set(newKey, rowNumber);
      }
    }
    if (rowErrors.length) {
      errorRows++;
      rowErrors.forEach(issue);
      matches.push({ row: rowNumber, key: matchRaw, number: rec?.number ?? null, action: 'error' });
      continue;
    }
    for (const fid of Object.keys(changes)) fieldCounts.set(fid, (fieldCounts.get(fid) ?? 0) + 1);
    if (rec) {
      if (Object.keys(changes).length === 0) {
        unchanged++;
        matches.push({ row: rowNumber, key: matchRaw, number: rec.number, action: 'unchanged' });
      } else {
        payload.updates.push({ row: rowNumber, recordId: rec.id, number: rec.number, version: rec.version, changes });
        matches.push({ row: rowNumber, key: matchRaw, number: rec.number, action: 'update' });
      }
    } else if (isVulnRegister(reg)) {
      // Записи уязвимостей появляются из сканов и переносом (ADR-0029): без узла запись потеряется.
      errorRows++;
      issue({ row: rowNumber, id: '', field: 'ID', message: 'Новые записи реестра уязвимостей появляются из сканов — пустой ID здесь не создаёт запись' });
      matches.push({ row: rowNumber, key: matchRaw, number: null, action: 'error' });
    } else {
      payload.creates.push({ row: rowNumber, values: changes });
      matches.push({ row: rowNumber, key: matchRaw, number: null, action: 'add' });
    }
  }

  // Импорт по ключу: действующие незакрытые записи, которых нет в файле, — кандидаты на «Выведено».
  let missing: ImportMissing[] = [];
  let missingTotal = 0;
  if (matchBy === 'key' && keyField && adapter?.missing !== false) {
    const inFile = new Set(rawMatch.map((v) => norm.get(v)).filter((k): k is string => !!k));
    const active = await db.$queryRaw<{ id: string; number: number; values: Values; import_key: string | null }[]>`
      SELECT r.id, r.number, r."values", r.import_key FROM register_records r
      WHERE ${baseSql(reg.id)} AND NOT ${closedSql(reg)}
      ORDER BY r.number`;
    // Область адаптера: отчёт о развёртывании KSC сравнивается только с хостами «В KSC = Да».
    const scope = typeof adapter?.missing === 'object' ? adapter.missing : null;
    const absent = active.filter((r) => (!scope || r.values[scope.fieldId] === scope.optionId) && (!r.import_key || !inFile.has(r.import_key)));
    missingTotal = absent.length;
    missing = absent.slice(0, MAX_MISSING).map((r) => ({
      id: r.id,
      number: r.number,
      key: typeof r.values[keyField.id] === 'string' ? String(r.values[keyField.id]) : '',
      title: titleField && typeof r.values[titleField.id] === 'string' ? String(r.values[titleField.id]) : '',
    }));
    if (missingTotal > missing.length) warnings.push(`Нет в файле: показаны первые ${missing.length} из ${missingTotal}`);
  }

  if (readonlyChanged) warnings.push(`В колонках «только для чтения» изменено значений: ${readonlyChanged}. Они не импортируются`);
  if (errorRows > errors.length) warnings.push(`Показаны первые ${errors.length} ошибок`);

  const summary: ImportSummary = {
    fileName,
    rows: dataRows.length,
    added: payload.creates.length,
    updated: payload.updates.length,
    unchanged,
    errorRows,
    fieldChanges: reg.fields.filter((f) => fieldCounts.has(f.id)).map((f) => ({ fieldId: f.id, label: f.label, count: fieldCounts.get(f.id) ?? 0 })),
    errors,
    warnings,
    matchBy,
    keyField: keyField ? { id: keyField.id, label: keyField.label } : null,
    matches,
    missing,
    missingTotal,
    ...(adapter ? { source: adapter.source, blocks: adapter.blocks } : {}),
  };
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const imp = await withTx(db, async (tx) => {
    const created = await tx.registerImport.create({
      data: {
        registerId,
        fileName: fileName.slice(0, 255),
        fileSha256: sha256,
        summary: summary as unknown as Prisma.InputJsonValue,
        payload: payload as unknown as Prisma.InputJsonValue,
        createdBy: actor.id,
        expiresAt: new Date(Date.now() + IMPORT_TTL_MS),
      },
    });
    await auditSettings(tx, actor, {
      action: 'register.import.previewed', entity: 'register_import', entityId: created.id,
      summary: `«${reg.name}»: предпросмотр импорта «${fileName}»${matchBy === 'key' ? ` по ключу «${keyField?.label}»` : ''} — добавится ${summary.added}, изменится ${summary.updated}, строк с ошибками ${summary.errorRows}${matchBy === 'key' ? `, нет в файле ${missingTotal}` : ''}`,
      after: { fileName, sha256, matchBy, added: summary.added, updated: summary.updated, errorRows: summary.errorRows, ...(matchBy === 'key' ? { missing: missingTotal } : {}) },
    });
    return created;
  });
  return { id: imp.id, status: imp.status, expiresAt: imp.expiresAt.toISOString(), summary };
}

export async function getImport(db: Db, id: string) {
  const imp = await db.registerImport.findUnique({ where: { id } });
  if (!imp || imp.kind !== 'records') throw notFound('Импорт');
  const status = imp.status === 'preview' && imp.expiresAt < new Date() ? 'expired' : imp.status;
  // Предпросмотры до этапа 8 — без сопоставления по ключу.
  const summary = { matchBy: 'id', keyField: null, matches: [], missing: [], missingTotal: 0, ...(imp.summary as object) } as unknown as ImportSummary;
  return { id: imp.id, registerId: imp.registerId, status, expiresAt: imp.expiresAt.toISOString(), summary };
}

// ---------------------------------------------------------------- импорт: применение

/** Новые записи импорта: номера, статус по умолчанию, производные поля, журнал. */
async function insertRecords(tx: Db, actor: Actor, reg: RegisterDef, list: Values[], fileName: string, importId: string): Promise<string[]> {
  if (!list.length) return [];
  const users = await loadUsers(tx, userIdsIn(reg, list));
  const links = linkLabels(await loadLinkRefs(tx, linkIdsIn(reg, list)));
  const today = todayIso();
  const status = reg.fields.find((f) => f.isStatus && !f.archived);
  const firstStatus = status?.options.find((o) => !o.archived);
  let number = await nextNumbers(tx, reg.id, list.length);
  const ids: string[] = [];
  for (const input of list) {
    const { values, manualFieldIds } = applyDerived(reg, { before: {}, after: { ...input }, manual: [], edited: Object.keys(input), isNew: true });
    if (status && firstStatus && values[status.id] === undefined) values[status.id] = firstStatus.id;
    applyDateDefaults(reg, values, today);
    const rec = await tx.registerRecord.create({
      data: { registerId: reg.id, number, values: values as Prisma.InputJsonValue, manualFieldIds, searchText: searchTextOf(reg, number, values, users, links) },
    });
    const changes = Object.keys(values).map((fid) => {
      const f = reg.fields.find((x) => x.id === fid) as FieldMeta;
      return { fieldId: fid, label: f.label, from: '', to: displayValue(f, values[fid], { users, links }) };
    });
    await auditSettings(tx, actor, {
      action: 'register_record.created', entity: 'register_record', entityId: rec.id,
      summary: `«${reg.name}»: создана запись #${number} импортом из Excel «${fileName}»`,
      after: { registerId: reg.id, number, changes, via: 'import', importId },
    });
    ids.push(rec.id);
    number++;
  }
  return ids;
}

/**
 * Значения списков и записи других реестров, которые адаптер запланировал в предпросмотре (ADR-0032).
 * Снятые блоки не создаются. Возвращает токен → id; токены снятых блоков — null (ссылка убирается).
 */
async function createPlanned(tx: Db, actor: Actor, payload: ImportPayload, skip: ReadonlySet<string>, fileName: string, importId: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const used = new Set<string>();
  const collect = (v: StoredValue) => (Array.isArray(v) ? v : [v]).forEach((x) => typeof x === 'string' && NEW_TOKEN.test(x) && used.add(x));
  for (const c of payload.creates) Object.values(c.values).forEach(collect);
  for (const u of payload.updates) Object.values(u.changes).forEach(collect);
  for (const g of payload.newRecords ?? []) for (const it of g.items) Object.values(it.values).forEach(collect);

  for (const o of payload.newOptions ?? []) {
    if (!used.has(o.token)) continue;
    const hit = await tx.registerFieldOption.findFirst({ where: { fieldId: o.fieldId, deletedAt: null, label: { equals: o.label, mode: 'insensitive' } } });
    if (hit) {
      out.set(o.token, hit.id);
      continue;
    }
    const max = await tx.registerFieldOption.aggregate({ where: { fieldId: o.fieldId }, _max: { sortOrder: true } });
    const created = await tx.registerFieldOption.create({ data: { fieldId: o.fieldId, label: o.label, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
    out.set(o.token, created.id);
    await auditSettings(tx, actor, {
      action: 'register_field.option_added', entity: 'register_field', entityId: o.fieldId,
      summary: `Импорт «${fileName}»: добавлено значение списка «${o.label}»`, after: { optionId: created.id, label: o.label, importId },
    });
  }
  for (const g of payload.newRecords ?? []) {
    if (skip.has(g.block)) {
      for (const it of g.items) out.set(it.token, null);
      continue;
    }
    const target = await loadRegister(tx, g.registerId);
    assertNotArchived(target);
    // Ключ импорта у целевого реестра: если запись с тем же ключом появилась после предпросмотра — ничего не применяем.
    const key = importKeyField(target);
    if (key) {
      const raw = g.items.map((it) => it.values[key.id]).filter((v): v is string => typeof v === 'string');
      const keys = [...new Set([...(await normalizeImportKeys(tx, raw)).values()].filter((k): k is string => !!k))];
      const taken = keys.length ? await tx.registerRecord.count({ where: { registerId: target.id, deletedAt: null, importKey: { in: keys } } }) : 0;
      if (taken) throw conflict('IMPORT_STALE', `После предпросмотра в реестре «${target.name}» появились записи, которые импорт собирался создать. Повторите предпросмотр`);
    }
    const sub = (values: Values) => substituteTokens(values, out);
    const ids = await insertRecords(tx, actor, target, g.items.map((it) => sub(it.values)), fileName, importId);
    g.items.forEach((it, i) => out.set(it.token, ids[i] ?? null));
  }
  return out;
}

/** Токены → id; токен снятого блока убирается из связи, пустая связь — из значений. */
export function substituteTokens(values: Values, tokens: ReadonlyMap<string, string | null>): Values {
  const out: Values = {};
  for (const [k, v] of Object.entries(values)) {
    if (Array.isArray(v)) {
      const list = v.flatMap((x) => (NEW_TOKEN.test(x) ? (tokens.get(x) ? [tokens.get(x) as string] : []) : [x]));
      if (list.length) out[k] = list;
    } else if (typeof v === 'string' && NEW_TOKEN.test(v)) {
      const id = tokens.get(v);
      if (id) out[k] = id;
    } else out[k] = v;
  }
  return out;
}

/** Применение одной транзакцией. Если что-то изменилось после предпросмотра — ничего не применяется. */
export async function applyImport(db: Db, actor: Actor, importId: string, opts: { skip?: string[] } = {}) {
  return withTx(db, async (tx) => {
    // Блокировка строки импорта: повторное «Применить» не выполнится дважды.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM register_imports WHERE id = ${importId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound('Импорт');
    const imp = await tx.registerImport.findUniqueOrThrow({ where: { id: importId } });
    if (imp.kind !== 'records') throw notFound('Импорт');
    if (imp.createdBy !== actor.id) throw new AppError(403, 'IMPORT_OTHER_USER', 'Применить импорт может только тот, кто загрузил файл');
    if (imp.status !== 'preview') throw conflict('IMPORT_NOT_PENDING', 'Этот импорт уже применён или отменён');
    if (imp.expiresAt < new Date()) {
      await tx.registerImport.update({ where: { id: importId }, data: { status: 'expired' } });
      throw conflict('IMPORT_EXPIRED', 'Предпросмотр устарел (30 минут). Загрузите файл снова');
    }
    let reg = await loadRegister(tx, imp.registerId);
    assertNotArchived(reg);
    const payload = imp.payload as unknown as ImportPayload;
    const summary = imp.summary as unknown as ImportSummary;
    const skip = new Set((opts.skip ?? []).filter((b) => summary.blocks?.some((x) => x.code === b && x.optional)));

    // Структура реестра не должна была измениться после предпросмотра.
    for (const [fieldId, version] of Object.entries(payload.fieldVersions)) {
      const f = reg.fields.find((x) => x.id === fieldId);
      if (!f || f.version !== version || f.archived) throw conflict('IMPORT_STALE', 'После предпросмотра изменились поля реестра. Повторите предпросмотр');
    }
    // Запланированное адаптером создаётся первым; дальше строки — как у обычного импорта.
    if (payload.newOptions?.length || payload.newRecords?.length) {
      const tokens = await createPlanned(tx, actor, payload, skip, summary.fileName, importId);
      for (const c of payload.creates) c.values = substituteTokens(c.values, tokens);
      for (const u of payload.updates) u.changes = substituteTokens(u.changes, tokens);
      payload.updates = payload.updates.filter((u) => Object.keys(u.changes).length);
      reg = await loadRegister(tx, imp.registerId);
    }
    const optionOk = (f: FieldMeta, v: StoredValue) => (f.type !== 'select' && f.type !== 'catalog') || f.options.some((o) => o.id === v);
    const usersNeeded = new Set<string>();

    // Записи не должны были измениться после предпросмотра.
    const ids = payload.updates.map((u) => u.recordId);
    const current = ids.length
      ? await tx.$queryRaw<{
          id: string; number: number; values: Values; version: number; manual_field_ids: string[]; archived_at: Date | null; deleted_at: Date | null;
        }[]>`
          SELECT id, number, "values", version, manual_field_ids, archived_at, deleted_at FROM register_records
          WHERE id = ANY(${ids}::uuid[]) FOR UPDATE`
      : [];
    const byId = new Map(current.map((r) => [r.id, r]));
    const stale = payload.updates.filter((u) => {
      const r = byId.get(u.recordId);
      return !r || r.version !== u.version || r.deleted_at !== null || r.archived_at !== null;
    });
    if (stale.length) {
      throw conflict('IMPORT_STALE', `После предпросмотра изменились записи (${stale.map((s) => s.number).slice(0, 10).join(', ')}${stale.length > 10 ? '…' : ''}). Повторите предпросмотр`);
    }
    for (const u of payload.updates) for (const [fid, v] of Object.entries(u.changes)) {
      const f = reg.fields.find((x) => x.id === fid);
      if (!f || !optionOk(f, v)) throw conflict('IMPORT_STALE', 'После предпросмотра изменились значения списков. Повторите предпросмотр');
      if (f.type === 'user') usersNeeded.add(String(v));
    }
    for (const c of payload.creates) for (const [fid, v] of Object.entries(c.values)) {
      const f = reg.fields.find((x) => x.id === fid);
      if (!f || !optionOk(f, v)) throw conflict('IMPORT_STALE', 'После предпросмотра изменились значения списков. Повторите предпросмотр');
      if (f.type === 'user') usersNeeded.add(String(v));
    }
    // Ключ импорта: если после предпросмотра кто-то завёл запись с тем же ключом — не применяем ничего.
    const keyField = importKeyField(reg);
    if (keyField) {
      const newKeys = [...payload.creates.map((c) => c.values[keyField.id]), ...payload.updates.map((u) => u.changes[keyField.id])]
        .filter((v): v is string => typeof v === 'string');
      const norm = await normalizeImportKeys(tx, newKeys);
      const keys = [...new Set([...norm.values()].filter((k): k is string => !!k))];
      if (keys.length) {
        const updating = new Set(payload.updates.map((u) => u.recordId));
        const taken = await tx.registerRecord.findMany({
          where: { registerId: reg.id, deletedAt: null, importKey: { in: keys } },
          select: { id: true, number: true, importKey: true },
        });
        const createKeys = new Set(payload.creates.map((c) => norm.get(String(c.values[keyField.id] ?? ''))).filter(Boolean));
        const clash = taken.filter((t) => !updating.has(t.id) || createKeys.has(t.importKey));
        if (clash.length) {
          throw conflict('IMPORT_STALE', `После предпросмотра появились записи с тем же «${keyField.label}» (${clash.slice(0, 10).map((c) => `#${c.number}`).join(', ')}). Повторите предпросмотр`);
        }
      }
    }
    const users = await loadUsers(tx, [...usersNeeded, ...userIdsIn(reg, current.map((r) => r.values))]);
    const allValues = [...current.map((r) => ({ ...r.values, ...(payload.updates.find((u) => u.recordId === r.id)?.changes ?? {}) })), ...payload.creates.map((c) => c.values)];
    const links = linkLabels(await loadLinkRefs(tx, linkIdsIn(reg, allValues)));

    for (const u of payload.updates) {
      const r = byId.get(u.recordId);
      if (!r) continue;
      // Вычисляемые поля и решения импорт не трогает; критичность уязвимости пересчитывается, если не правлена вручную.
      const { values, manualFieldIds, derived } = applyDerived(reg, {
        before: r.values, after: { ...r.values, ...u.changes }, manual: r.manual_field_ids, edited: Object.keys(u.changes), isNew: false,
      });
      await tx.registerRecord.update({
        where: { id: r.id },
        data: { values: values as Prisma.InputJsonValue, manualFieldIds, searchText: searchTextOf(reg, r.number, values, users, links), version: { increment: 1 } },
      });
      const changes = [...new Set([...Object.keys(u.changes), ...derived])].filter((fid) => !sameValue(r.values[fid], values[fid])).map((fid) => {
        const f = reg.fields.find((x) => x.id === fid) as FieldMeta;
        return { fieldId: fid, label: f.label, from: displayValue(f, r.values[fid], { users, links }), to: displayValue(f, values[fid], { users, links }) };
      });
      await auditSettings(tx, actor, {
        action: 'register_record.updated', entity: 'register_record', entityId: r.id,
        summary: `«${reg.name}», запись #${r.number}: импорт из Excel «${summary.fileName}»`,
        after: { changes, via: 'import', importId },
      });
    }

    await insertRecords(tx, actor, reg, payload.creates.map((c) => c.values), summary.fileName, importId);

    await tx.registerImport.update({ where: { id: importId }, data: { status: 'applied', appliedAt: new Date() } });
    await auditSettings(tx, actor, {
      action: 'register.import.applied', entity: 'register_import', entityId: importId,
      summary: `«${reg.name}»: применён импорт «${summary.fileName}» — добавлено ${payload.creates.length}, изменено ${payload.updates.length}, пропущено строк с ошибками ${summary.errorRows}`,
      after: {
        fileName: summary.fileName, sha256: imp.fileSha256, added: payload.creates.length, updated: payload.updates.length, errorRows: summary.errorRows,
        ...(summary.source ? { source: summary.source } : {}), ...(skip.size ? { skipped: [...skip] } : {}),
      },
    });
    return { added: payload.creates.length, updated: payload.updates.length, skipped: summary.errorRows };
  });
}

export async function cancelImport(db: Db, actor: Actor, importId: string) {
  await withTx(db, async (tx) => {
    const imp = await tx.registerImport.findUnique({ where: { id: importId } });
    if (!imp) throw notFound('Импорт');
    if (imp.status !== 'preview') return;
    await tx.registerImport.update({ where: { id: importId }, data: { status: 'cancelled' } });
    await auditSettings(tx, actor, {
      action: 'register.import.cancelled', entity: 'register_import', entityId: importId,
      summary: `Импорт «${(imp.summary as unknown as ImportSummary).fileName}» отменён`,
    });
  });
}
