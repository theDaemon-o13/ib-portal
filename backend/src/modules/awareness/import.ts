// Адаптер импорта отчёта INDIGO (релиз 1.8.0, docs/specs/awareness.md, раздел 4, ADR-0037): отчёт → лист с колонками по
// названиям полей «Результатов INDIGO» для общего конвейера импорта (предпросмотр, одна транзакция, проверка версий).
// Сопоставление с «Сотрудниками» по ФИО — ADR-0038: автоматически только точное полное ФИО с отчеством и ровно один
// работающий сотрудник; остальное — блок ручного выбора. «Нет в файле» не считается: каждый отчёт — свой период.
import ExcelJS from 'exceljs';
import type { Db } from '../../lib/db.js';
import { badRequest, conflict } from '../../lib/errors.js';
import type { Values } from '../../lib/register-values.js';
import { isOle, readSheets } from '../../lib/spreadsheetml.js';
import { loadRegister, normalizeImportKeys, type FieldMeta, type RegisterDef } from '../registers/definition.js';
import { IMPORT_MAX_ROWS, type ImportAdapter, type ImportBlock, type ImportChoiceRow } from '../registers/excel.service.js';
import { readPortalParam } from '../settings/portal-params.js';
import { AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY, RESULT_FIELDS } from './definition.js';
import { AWARENESS_GRADES_KEY, type GradeSettings } from './grades.js';
import { parseIndigoReport, type IndigoRow } from './indigo.js';
import { attemptKey, GRADE_LABELS, gradeOf, needsRetake, normalizeFio, pickBestOfDay } from './logic.js';

const BLOCK_ITEMS = 200;
/** Кандидатов в строке блока ручного выбора (однофамильцы); остальных находят поиском по реестру. */
const CANDIDATES_MAX = 10;

const field = (reg: RegisterDef, key: string): FieldMeta => {
  const f = reg.fields.find((x) => x.systemKey === key && !x.archived);
  if (!f) throw conflict('AWARENESS_FIELD_MISSING', `В реестре «${reg.name}» нет системного поля «${key}». Обратитесь к администратору`);
  return f;
};
const optionId = (f: FieldMeta, key: string) => {
  const o = f.options.find((x) => x.systemKey === key && !x.archived);
  if (!o) throw conflict('AWARENESS_FIELD_MISSING', `В поле «${f.label}» нет системного значения «${key}». Обратитесь к администратору`);
  return o;
};
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const pct = (n: number | null) => (n === null ? '—' : `${String(n).replace('.', ',')}%`);
const ruDate = (iso: string) => iso.split('-').reverse().join('.');

interface Employee { id: string; number: number; fio: string; dept: string; working: boolean }

/** Сотрудники по нормализованному ФИО (поле-заголовок «ФИО», не части), неудалённые. */
async function employeesByFio(db: Db, emp: RegisterDef): Promise<{ byFio: Map<string, Employee[]>; total: number }> {
  const fio = field(emp, 'fullName');
  const dept = field(emp, 'dept');
  const status = field(emp, 'status');
  const working = optionId(status, 'working').id;
  const rows = await db.registerRecord.findMany({ where: { registerId: emp.id, deletedAt: null, archivedAt: null }, select: { id: true, number: true, values: true } });
  const byFio = new Map<string, Employee[]>();
  for (const r of rows) {
    const v = r.values as Values;
    const name = str(v[fio.id]);
    if (!name) continue;
    const key = normalizeFio(name);
    byFio.set(key, [...(byFio.get(key) ?? []), { id: r.id, number: r.number, fio: name, dept: str(v[dept.id]), working: v[status.id] === working }]);
  }
  return { byFio, total: rows.length };
}

type Match = { kind: 'exact'; employee: Employee } | { kind: 'none'; reason: string; candidates: Employee[] };

/** ADR-0038: «Точно» — полное ФИО с отчеством совпало ровно с одним работающим. */
function matchRow(row: IndigoRow, byFio: Map<string, Employee[]>): Match {
  const same = byFio.get(normalizeFio(row.fio)) ?? [];
  const working = same.filter((e) => e.working);
  if (!row.hasMiddleName) return { kind: 'none', reason: 'нет отчества', candidates: working };
  if (working.length === 1 && working[0]) return { kind: 'exact', employee: working[0] };
  if (working.length > 1) return { kind: 'none', reason: `однофамильцы: ${working.length}`, candidates: working };
  if (same.length) return { kind: 'none', reason: 'найден только уволенный', candidates: [] };
  return { kind: 'none', reason: 'не найден', candidates: [] };
}

function block(code: string, title: string, items: string[], hint: string | null): ImportBlock {
  return { code, title, hint, items: items.slice(0, BLOCK_ITEMS), total: items.length, optional: false };
}

export async function indigoImportAdapter(db: Db, registerId: string, buffer: Buffer): Promise<ImportAdapter> {
  const res = await loadRegister(db, registerId);
  if (res.systemKey !== AWARENESS_RESULTS_KEY) throw conflict('WRONG_ADAPTER', 'Отчёт INDIGO загружается в реестр «Результаты INDIGO»');
  if (isOle(buffer)) {
    throw badRequest('OLD_EXCEL_FORMAT', 'Это файл старого формата Excel. Откройте его в Excel и сохраните как .xlsx, затем загрузите снова');
  }
  const report = parseIndigoReport(await readSheets(buffer, IMPORT_MAX_ROWS + 20));
  const grades = await readPortalParam<GradeSettings>(db, AWARENESS_GRADES_KEY);
  const empRow = await db.register.findUnique({ where: { systemKey: AWARENESS_EMPLOYEES_KEY }, select: { id: true } });
  if (!empRow) throw conflict('AWARENESS_FIELD_MISSING', 'Нет системного реестра «Сотрудники». Обратитесь к администратору');
  const emp = await loadRegister(db, empRow.id);
  const { byFio, total: employeesTotal } = await employeesByFio(db, emp);

  const R = (key: string) => field(res, key);
  const cols = RESULT_FIELDS.map((f) => R(f.key));
  const col = new Map(cols.map((f, i) => [f.systemKey as string, i]));
  const gradeF = R('grade');
  const retakeF = R('retake');
  const matchF = R('match');
  const label = (f: FieldMeta, key: string) => optionId(f, key).label;

  // Повторы в один день (решение 3): строки без ошибок; лучшая попытка дня — в лист, остальные — в блок.
  const keyed = report.rows.map((r) => ({ row: r, key: r.date ? attemptKey(report.test, r.fio, r.date) : '', percent: r.percent ?? -1 }));
  const ok = keyed.filter((k) => !k.row.errors.length);
  const { kept, repeats } = pickBestOfDay(ok);
  const keptLines = new Set(kept.map((k) => k.row.line));
  const bestOf = new Map(kept.map((k) => [k.key.toLowerCase(), k.row]));

  // Существующие записи с теми же ключами: оценка у них не пересчитывается, если процент тот же (раздел 3.2).
  const norm = await normalizeImportKeys(db, kept.map((k) => k.key));
  const existing = await db.registerRecord.findMany({
    where: { registerId: res.id, deletedAt: null, importKey: { in: [...new Set([...norm.values()].filter((k): k is string => !!k))] } },
    select: { importKey: true, values: true },
  });
  const byKey = new Map(existing.map((e) => [e.importKey as string, e.values as Values]));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Результаты INDIGO');
  ws.addRow(cols.map((f) => f.label));
  const choiceRows: ImportChoiceRow[] = [];
  let exact = 0;
  for (const { row: r, key } of keyed) {
    // Строки — под своими номерами из отчёта: ошибки конвейера называют строку отчёта.
    if (!r.errors.length && !keptLines.has(r.line)) continue;
    const cells: (string | number | null)[] = cols.map(() => null);
    const put = (k: string, v: string | number | null) => { cells[col.get(k) as number] = v === '' ? null : v; };
    put('attemptKey', key || `${report.test} | ${normalizeFio(r.fio)} | ?`);
    put('fullName', r.fio);
    put('test', report.test);
    put('indigoGroup', r.group);
    put('spent', r.spent);
    put('score', r.score);
    put('maxScore', r.maxScore);
    put('regularPct', r.regularPct);
    put('multiPct', r.multiPct);
    if (r.errors.length) {
      // Ошибочную строку конвейер отклонит по самой ячейке: дата и процент — как в отчёте.
      put('date', r.date ?? '(не распознана)');
      put('percent', r.percent ?? '(не число)');
    } else {
      put('date', r.date);
      put('percent', r.percent);
      const before = byKey.get(norm.get(key) ?? '');
      const p = r.percent as number;
      // Тот же процент у существующей записи — прежние оценка и «На пересдачу»: повторная загрузка ничего не меняет.
      const same = before && before[R('percent').id] === p;
      const prevGrade = same ? gradeF.options.find((o) => o.id === before[gradeF.id])?.label : undefined;
      const prevRetake = same ? retakeF.options.find((o) => o.id === before[retakeF.id])?.label : undefined;
      put('grade', prevGrade ?? GRADE_LABELS[gradeOf(p, grades)]);
      put('retake', prevRetake ?? label(retakeF, needsRetake(p, grades) ? 'yes' : 'no'));
      const m = matchRow(r, byFio);
      if (m.kind === 'exact') {
        exact++;
        put('employee', `#${m.employee.number}`);
        put('match', label(matchF, 'exact'));
        put('dept', m.employee.dept || r.group);
      } else {
        put('match', label(matchF, 'none'));
        put('dept', r.group);
        choiceRows.push({
          row: r.line, title: r.fio, detail: [r.group, r.date ? ruDate(r.date) : '', pct(r.percent)].filter(Boolean).join(' · '), reason: m.reason,
          candidates: m.candidates.slice(0, CANDIDATES_MAX).map((e) => ({ id: e.id, label: `#${e.number} ${e.fio}${e.dept ? ` — ${e.dept}` : ''}` })),
        });
      }
    }
    const xr = ws.getRow(r.line);
    cells.forEach((v, i) => { if (v !== null) xr.getCell(i + 1).value = v; });
    xr.commit();
  }

  const c = report.completeness;
  const warnings = [...report.warnings];
  if (c.percentMismatch) warnings.push(`Средний процент по сводке ${pct(c.summaryPercent)}, по строкам ${pct(c.rowsPercent)} — расходятся больше чем на 0,5 п. п.`);
  const spentWarn = report.rows.filter((r) => r.warnings.length && keptLines.has(r.line)).map((r) => r.line);
  if (spentWarn.length) warnings.push(`Затраченное время не в формате ЧЧ:ММ:СС — сохранено как есть: ${spentWarn.length} строк (${spentWarn.slice(0, 20).join(', ')}${spentWarn.length > 20 ? '…' : ''})`);
  if (!employeesTotal) warnings.push('Реестр «Сотрудники» пуст — сначала загрузите выгрузку HR, иначе все результаты будут без связи');

  const info = [
    `Тест: ${report.test}`,
    `Строк в таблице: ${c.rows}${c.errorRows ? `, с ошибками: ${c.errorRows}` : ''}`,
    `Средний процент: по сводке ${pct(c.summaryPercent)}, по строкам ${pct(c.rowsPercent)}`,
    c.complete === null ? 'Полнота не проверена' : c.complete ? `Полнота: сошлось — ${c.rows} строк × МаксБалл ${c.summaryMax} = Всего ${c.summaryTotal}` : 'Полнота: не сошлось — отчёт может быть неполным',
  ];
  const blocks = [block('indigo_info', 'Сведения об отчёте', info, null)];
  const repeatItems = repeats.map((k) => {
    const best = bestOf.get(k.key.toLowerCase());
    return `строка ${k.row.line}: ${k.row.fio}, ${pct(k.row.percent)} — загружена строка ${best?.line ?? '?'} с ${pct(best?.percent ?? null)}`;
  });
  if (repeatItems.length) blocks.push(block('indigo_repeats', `Повторы в один день: ${repeatItems.length}`, repeatItems, 'Загружается попытка с большим «Результатом, %», при равном — первая по порядку в файле'));
  const parseErrors = report.rows.filter((r) => r.errors.length).map((r) => `строка ${r.line}: ${r.fio || '(без ФИО)'} — ${r.errors.join('; ')}`);
  if (parseErrors.length) blocks.push(block('indigo_errors', `Строки с ошибками разбора: ${parseErrors.length}`, parseErrors, 'Эти строки не загружаются; остальные загружаются'));

  const status = field(emp, 'status');
  return {
    wb, ws,
    managedWritable: res.fields.filter((f) => f.managed).map((f) => f.id),
    // Связь, «Сопоставление» и подразделение — только у новой записи: повторный импорт не снимает ручное сопоставление.
    createOnly: [R('employee').id, R('match').id, R('dept').id],
    missing: false,
    newOptions: [], newRecords: [], linkTokens: {},
    source: {
      adapter: 'indigo', test: report.test, sheet: report.sheet, rows: c.rows, errorRows: c.errorRows,
      summaryTotal: c.summaryTotal, summaryMax: c.summaryMax, summaryPercent: c.summaryPercent, rowsPercent: c.rowsPercent,
      complete: c.complete, percentMismatch: c.percentMismatch,
      matchedExact: exact, matchedManual: 0, unmatched: choiceRows.length, sameDayRepeats: repeats.length,
    },
    warnings,
    blocks,
    choices: {
      code: 'indigo_manual', title: `Требуют ручного сопоставления: ${choiceRows.length}`,
      hint: 'Выберите сотрудника или пропустите строку — она останется «Не сопоставлен». Поиск — среди работающих',
      fieldId: R('employee').id, registerId: emp.id,
      scope: { fieldId: status.id, optionId: optionId(status, 'working').id },
      rows: choiceRows,
      set: { [matchF.id]: optionId(matchF, 'manual').id },
      copy: { [R('dept').id]: field(emp, 'dept').id },
    },
  };
}
