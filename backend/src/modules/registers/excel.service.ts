// Экспорт реестра в Excel и импорт обратно с обновлением по колонке ID (CLAUDE.md, раздел 7, п. 7).
// Импорт всегда в два шага: предпросмотр (ничего не меняет) → применение одной транзакцией.
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import {
  cellPrimitive,
  displayValue,
  formatNumberRu,
  isWritable,
  parseCell,
  sameValue,
  type StoredValue,
  type Values,
} from '../../lib/register-values.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { applyDerived } from '../vulns/derive.js';
import {
  assertNotArchived,
  loadRegister,
  loadUsers,
  searchTextOf,
  toRecordDtos,
  userIdsIn,
  type FieldMeta,
  type RegisterDef,
} from './definition.js';
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
  user: 'Сотрудник в виде «ФИО (логин)» — ищется по логину в скобках. Можно указать только ФИО, если такое имя у единственного сотрудника.',
  calc: 'Только для чтения: считается порталом, при импорте не меняется.',
  decision: 'Только для чтения: решение вносится на портале с документом-основанием.',
};
const TYPE_NAME: Record<string, string> = {
  text: 'Текст', number: 'Число', date: 'Дата', select: 'Список', user: 'Сотрудник', calc: 'Вычисляемое', decision: 'Решение другого отдела',
};

/** derived — колонка портала без поля («Дней до срока»): при импорте пропускается молча. */
type ColKind = 'id' | 'value' | 'readonly' | 'doc' | 'derived';
const DAYS_LEFT_HEADER = 'Дней до срока';

// ---------------------------------------------------------------- экспорт

export async function exportRegister(db: Db, registerId: string): Promise<{ fileName: string; buffer: Buffer }> {
  const reg = await loadRegister(db, registerId);
  const fields = reg.fields.filter((f) => !f.archived);
  const rows = await db.registerRecord.findMany({
    where: { registerId, deletedAt: null, archivedAt: null },
    select: { id: true, number: true, values: true, version: true, archivedAt: true, createdAt: true, updatedAt: true },
    orderBy: { number: 'asc' },
  });
  const dtos = await toRecordDtos(db, reg, rows);
  const users = await loadUsers(db, userIdsIn(reg, rows.map((r) => r.values as Values)));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Портал ИБ';
  wb.created = new Date();
  const ws = wb.addWorksheet(MAIN_SHEET, { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  const map = wb.addWorksheet(MAP_SHEET);
  map.state = 'veryHidden';
  map.addRow([MAP_MARK, reg.id]);

  const cols: { header: string; kind: ColKind; field?: FieldMeta }[] = [{ header: 'ID', kind: 'id' }];
  for (const f of fields) {
    if (f.type === 'calc') cols.push({ header: f.label, kind: 'readonly', field: f });
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
      if (f.type === 'calc') {
        const v = rec.calc[f.id];
        // Оценка уязвимости — число, срок — дата.
        if (typeof v === 'number') return v;
        return v ? new Date(`${v}T00:00:00Z`) : null;
      }
      if (f.type === 'decision') return rec.display[f.id] ?? '';
      const v = values[f.id];
      if (v === undefined) return null;
      if (f.type === 'number') return typeof v === 'number' ? v : Number(v);
      if (f.type === 'date') return new Date(`${String(v)}T00:00:00Z`);
      // Сотрудник — «ФИО (логин)»: по логину импорт найдёт его однозначно.
      return displayValue(f, v, { users, userWithLogin: true });
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
      f.type === 'select' ? f.options.filter((o) => !o.archived).map((o) => o.label).join('; ') : '',
    ]);
  }
  help.addRow([]);
  for (const line of [
    'Как работает импорт:',
    '1. Строки обновляют записи по колонке ID; пустой ID — новая запись.',
    '2. Пустая ячейка не меняет значение. Очистить поле можно в карточке записи на портале.',
    '3. Серые колонки — только для чтения: вычисляемые сроки и решения другого отдела при импорте не меняются.',
    '4. Сотрудник: «ФИО (логин)». Только ФИО — если такое имя у единственного сотрудника, иначе ошибка.',
    '5. Перед применением портал показывает предпросмотр: что добавится, что изменится, строки с ошибками.',
  ]) help.addRow([line]);
  help.getColumn(3).alignment = { wrapText: true, vertical: 'top' };

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
}

interface ImportPayload {
  creates: { row: number; values: Values }[];
  updates: { row: number; recordId: string; number: number; version: number; changes: Values }[];
  fieldVersions: Record<string, number>;
}

const MAX_ISSUES = 500;

function mapColumns(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, reg: RegisterDef, warnings: string[]) {
  const cols = new Map<number, { kind: ColKind; field?: FieldMeta }>();
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
      cols.set(col, { kind: isWritable(field.type) && kind === 'value' ? 'value' : kind === 'doc' ? 'doc' : 'readonly', field });
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
      else cols.set(col, { kind: isWritable(field.type) ? 'value' : 'readonly', field });
    });
  }
  if (![...cols.values()].some((c) => c.kind === 'id')) {
    throw badRequest('NO_ID_COLUMN', 'В файле нет колонки ID. Выгрузите реестр кнопкой «Экспорт в Excel» и заполните этот файл');
  }
  return cols;
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

export async function previewImport(db: Db, actor: Actor, registerId: string, buffer: Buffer, fileName: string) {
  const reg = await loadRegister(db, registerId);
  assertNotArchived(reg);
  if (buffer.length === 0) throw badRequest('BAD_FILE', 'Файл пустой');
  const wb = await readWorkbook(buffer);
  const ws = wb.getWorksheet(MAIN_SHEET) ?? wb.worksheets.find((w) => w.name !== MAP_SHEET && w.name !== HELP_SHEET && w.state === 'visible');
  if (!ws) throw badRequest('BAD_FILE', 'В книге нет листа с данными');
  if (ws.rowCount - 1 > IMPORT_MAX_ROWS) throw badRequest('TOO_MANY_ROWS', `В файле больше ${IMPORT_MAX_ROWS} строк`);

  const warnings: string[] = [];
  const cols = mapColumns(wb, ws, reg, warnings);
  const idCol = [...cols.entries()].find(([, c]) => c.kind === 'id')?.[0] as number;
  const allUsers = await db.user.findMany({ select: { id: true, login: true, fullName: true, isActive: true } });

  // Записи, на которые ссылается файл.
  const numbers: number[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = cellPrimitive(row.getCell(idCol).value);
    const num = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
    if (Number.isInteger(num) && num > 0) numbers.push(num);
  });
  const existing = await db.registerRecord.findMany({
    where: { registerId, number: { in: numbers } },
    select: { id: true, number: true, values: true, version: true, archivedAt: true, deletedAt: true, createdAt: true, updatedAt: true },
  });
  const byNumber = new Map(existing.map((r) => [r.number, r]));
  // Отображаемые значения «только для чтения» (вычисляемый срок, решение) — для предупреждения об изменениях.
  const shownByNumber = new Map(
    (await toRecordDtos(db, reg, existing.filter((r) => !r.deletedAt))).map((d) => [d.number, d.display]),
  );
  const titleField = reg.fields.find((f) => f.isTitle && !f.archived);

  const errors: ImportIssue[] = [];
  let errorRows = 0;
  let unchanged = 0;
  let readonlyChanged = 0;
  let rowsTotal = 0;
  const fieldCounts = new Map<string, number>();
  const payload: ImportPayload = {
    creates: [],
    updates: [],
    fieldVersions: Object.fromEntries(reg.fields.map((f) => [f.id, f.version])),
  };
  const seen = new Map<number, number>();
  const issue = (i: ImportIssue) => {
    if (errors.length < MAX_ISSUES) errors.push(i);
  };

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells = [...cols.keys()].map((c) => cellPrimitive(row.getCell(c).value));
    if (cells.every((c) => c === null)) return;
    rowsTotal++;
    const rowErrors: ImportIssue[] = [];
    const idRaw = cellPrimitive(row.getCell(idCol).value);
    let rec: (typeof existing)[number] | undefined;
    let num: number | null = null;
    if (idRaw !== null) {
      num = typeof idRaw === 'number' ? idRaw : typeof idRaw === 'string' && /^\s*\d+\s*$/.test(idRaw) ? Number(idRaw) : NaN;
      if (!Number.isInteger(num) || num <= 0) {
        rowErrors.push({ row: rowNumber, id: String(idRaw), field: 'ID', message: 'ID — номер записи (целое число)' });
      } else {
        const dup = seen.get(num);
        if (dup !== undefined) rowErrors.push({ row: rowNumber, id: String(num), field: 'ID', message: `ID ${num} уже встречается в строке ${dup}` });
        else seen.set(num, rowNumber);
        rec = byNumber.get(num);
        if (!rec) rowErrors.push({ row: rowNumber, id: String(num), field: 'ID', message: `Записи с ID ${num} нет в реестре — новая запись так не создаётся. Для новой оставьте ID пустым` });
        else if (rec.deletedAt) rowErrors.push({ row: rowNumber, id: String(num), field: 'ID', message: `Запись ${num} удалена` });
        else if (rec.archivedAt) rowErrors.push({ row: rowNumber, id: String(num), field: 'ID', message: `Запись ${num} в архиве — верните её на портале` });
      }
    }
    const current = (rec?.values ?? {}) as Values;
    const changes: Values = {};
    for (const [col, c] of cols) {
      if (c.kind === 'id' || !c.field) continue;
      const f = c.field;
      if (c.kind === 'readonly' || c.kind === 'doc') {
        // Только чтение: не меняется; если в файле другое значение — предупреждение.
        continue;
      }
      const r = parseCell(f, row.getCell(col).value, { users: allUsers });
      if (!r.ok) {
        rowErrors.push({ row: rowNumber, id: num !== null ? String(num) : null, field: f.label, message: r.error });
        continue;
      }
      if (r.value === null) continue; // пустая ячейка не меняет значение
      if (!sameValue(current[f.id], r.value)) changes[f.id] = r.value;
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
    if (rowErrors.length) {
      errorRows++;
      rowErrors.forEach(issue);
      return;
    }
    for (const fid of Object.keys(changes)) fieldCounts.set(fid, (fieldCounts.get(fid) ?? 0) + 1);
    if (rec) {
      if (Object.keys(changes).length === 0) unchanged++;
      else payload.updates.push({ row: rowNumber, recordId: rec.id, number: rec.number, version: rec.version, changes });
    } else {
      payload.creates.push({ row: rowNumber, values: changes });
    }
  });

  if (readonlyChanged) warnings.push(`В колонках «только для чтения» изменено значений: ${readonlyChanged}. Они не импортируются`);
  if (errorRows > errors.length) warnings.push(`Показаны первые ${errors.length} ошибок`);

  const summary: ImportSummary = {
    fileName,
    rows: rowsTotal,
    added: payload.creates.length,
    updated: payload.updates.length,
    unchanged,
    errorRows,
    fieldChanges: reg.fields.filter((f) => fieldCounts.has(f.id)).map((f) => ({ fieldId: f.id, label: f.label, count: fieldCounts.get(f.id) ?? 0 })),
    errors,
    warnings,
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
      summary: `«${reg.name}»: предпросмотр импорта «${fileName}» — добавится ${summary.added}, изменится ${summary.updated}, строк с ошибками ${summary.errorRows}`,
      after: { fileName, sha256, added: summary.added, updated: summary.updated, errorRows: summary.errorRows },
    });
    return created;
  });
  return { id: imp.id, status: imp.status, expiresAt: imp.expiresAt.toISOString(), summary };
}

export async function getImport(db: Db, id: string) {
  const imp = await db.registerImport.findUnique({ where: { id } });
  if (!imp || imp.kind !== 'records') throw notFound('Импорт');
  const status = imp.status === 'preview' && imp.expiresAt < new Date() ? 'expired' : imp.status;
  return { id: imp.id, registerId: imp.registerId, status, expiresAt: imp.expiresAt.toISOString(), summary: imp.summary as unknown as ImportSummary };
}

// ---------------------------------------------------------------- импорт: применение

/** Применение одной транзакцией. Если что-то изменилось после предпросмотра — ничего не применяется. */
export async function applyImport(db: Db, actor: Actor, importId: string) {
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
    const reg = await loadRegister(tx, imp.registerId);
    assertNotArchived(reg);
    const payload = imp.payload as unknown as ImportPayload;
    const summary = imp.summary as unknown as ImportSummary;

    // Структура реестра не должна была измениться после предпросмотра.
    for (const [fieldId, version] of Object.entries(payload.fieldVersions)) {
      const f = reg.fields.find((x) => x.id === fieldId);
      if (!f || f.version !== version || f.archived) throw conflict('IMPORT_STALE', 'После предпросмотра изменились поля реестра. Повторите предпросмотр');
    }
    const optionOk = (f: FieldMeta, v: StoredValue) => f.type !== 'select' || f.options.some((o) => o.id === v);
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
    const users = await loadUsers(tx, [...usersNeeded, ...userIdsIn(reg, current.map((r) => r.values))]);

    for (const u of payload.updates) {
      const r = byId.get(u.recordId);
      if (!r) continue;
      // Вычисляемые поля и решения импорт не трогает; критичность уязвимости пересчитывается, если не правлена вручную.
      const { values, manualFieldIds, derived } = applyDerived(reg, {
        before: r.values, after: { ...r.values, ...u.changes }, manual: r.manual_field_ids, edited: Object.keys(u.changes), isNew: false,
      });
      await tx.registerRecord.update({
        where: { id: r.id },
        data: { values: values as Prisma.InputJsonValue, manualFieldIds, searchText: searchTextOf(reg, r.number, values, users), version: { increment: 1 } },
      });
      const changes = [...new Set([...Object.keys(u.changes), ...derived])].filter((fid) => !sameValue(r.values[fid], values[fid])).map((fid) => {
        const f = reg.fields.find((x) => x.id === fid) as FieldMeta;
        return { fieldId: fid, label: f.label, from: displayValue(f, r.values[fid], { users }), to: displayValue(f, values[fid], { users }) };
      });
      await auditSettings(tx, actor, {
        action: 'register_record.updated', entity: 'register_record', entityId: r.id,
        summary: `«${reg.name}», запись #${r.number}: импорт из Excel «${summary.fileName}»`,
        after: { changes, via: 'import', importId },
      });
    }

    // Статус по умолчанию для новых записей.
    const status = reg.fields.find((f) => f.isStatus && !f.archived);
    const firstStatus = status?.options.find((o) => !o.archived);
    let number = payload.creates.length ? await nextNumbers(tx, reg.id, payload.creates.length) : 0;
    for (const c of payload.creates) {
      const { values, manualFieldIds } = applyDerived(reg, { before: {}, after: { ...c.values }, manual: [], edited: Object.keys(c.values), isNew: true });
      if (status && firstStatus && values[status.id] === undefined) values[status.id] = firstStatus.id;
      const rec = await tx.registerRecord.create({
        data: { registerId: reg.id, number, values: values as Prisma.InputJsonValue, manualFieldIds, searchText: searchTextOf(reg, number, values, users) },
      });
      const changes = Object.keys(values).map((fid) => {
        const f = reg.fields.find((x) => x.id === fid) as FieldMeta;
        return { fieldId: fid, label: f.label, from: '', to: displayValue(f, values[fid], { users }) };
      });
      await auditSettings(tx, actor, {
        action: 'register_record.created', entity: 'register_record', entityId: rec.id,
        summary: `«${reg.name}»: создана запись #${number} импортом из Excel «${summary.fileName}»`,
        after: { registerId: reg.id, number, changes, via: 'import', importId },
      });
      number++;
    }

    await tx.registerImport.update({ where: { id: importId }, data: { status: 'applied', appliedAt: new Date() } });
    await auditSettings(tx, actor, {
      action: 'register.import.applied', entity: 'register_import', entityId: importId,
      summary: `«${reg.name}»: применён импорт «${summary.fileName}» — добавлено ${payload.creates.length}, изменено ${payload.updates.length}, пропущено строк с ошибками ${summary.errorRows}`,
      after: { fileName: summary.fileName, sha256: imp.fileSha256, added: payload.creates.length, updated: payload.updates.length, errorRows: summary.errorRows },
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
