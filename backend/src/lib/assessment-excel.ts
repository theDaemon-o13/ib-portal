// Самооценка (этап Д4, docs/self-assessment.md, раздел 9): разбор книги Excel без БД.
// 1) Исходный шаблон «Чек-лист оценки уровня кибербезопасности» — по содержимому, без адресов ячеек: в столбце E строки
//    «Дополнительный комментарий», ответ — строкой выше, комментарий — строкой ниже, раздел — ближайший код «N.N.» выше
//    в столбце C; скрытые строки пропускаются (в файле есть скрытый дубль «9.3»). Профиль — с листа «Общая информация»
//    по подписям строк. 2) Наша выгрузка — лист «Ответы», колонки «Код» и «Балл» выбранной оценки.
// Значения читаются через cellPrimitive: cell.text у объединённой ячейки с пустым основным значением бросает исключение.
import type ExcelJS from 'exceljs';
import type { Methodology } from './assessment-score.js';
import { sectionsOf } from './assessment-score.js';
import { cellPrimitive } from './register-values.js';

export const CHECKLIST_SHEET = 'Чек-лист';
export const INFO_SHEET = 'Общая информация';
export const ANSWERS_SHEET = 'Ответы';
const COMMENT_MARK = 'дополнительный комментарий';
const NO_ANSWER = 'выбрать ответ';
const COMMENT_MAX = 4000;

export interface ParsedAnswer { code: string; level: number | null; comment: string; row: number }
export interface ParseIssue { row: number | null; code: string | null; message: string }
export interface ParsedProfile { organization?: string; assessedOn?: string; respondent?: string; position?: string; employees?: number }
export interface ExportSource { id: string; title: string; date: string | null }
export interface ParsedBook {
  format: 'checklist' | 'answers';
  answers: ParsedAnswer[];
  /** Ошибки строк: применить такой файл нельзя. */
  errors: ParseIssue[];
  /** Пояснения, которые не мешают применению. */
  notes: string[];
  profile: ParsedProfile;
  /** Лист «Ответы»: какие оценки есть в файле и какая выбрана. */
  sources?: ExportSource[];
  sourceId?: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const text = (v: unknown): string => {
  const p = cellPrimitive(v);
  if (p === null) return '';
  if (p instanceof Date) return Number.isNaN(p.getTime()) ? '' : p.toISOString().slice(0, 10);
  return String(p).trim();
};
const value = (ws: ExcelJS.Worksheet, row: number, col: number) => cellPrimitive(ws.getRow(row).getCell(col).value);

/** Балл из ячейки: 1–4; «Выбрать ответ» и пусто — нет ответа; остальное — ошибка. */
export function parseLevel(v: unknown): { level: number | null } | { error: string } {
  const p = cellPrimitive(v);
  if (p === null) return { level: null };
  if (typeof p === 'number') return Number.isInteger(p) && p >= 1 && p <= 4 ? { level: p } : { error: `балл «${p}» вне 1–4` };
  const t = text(p);
  if (!t || norm(t) === NO_ANSWER) return { level: null };
  const m = /^([0-9]+)(?:\D|$)/.exec(t);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 4 ? { level: n } : { error: `балл «${t}» вне 1–4` };
}

/** Название раздела в файле совпадает с методикой: одно — начало другого (без регистра, знаков и «ё»). */
const sameName = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
};

function parseChecklist(ws: ExcelJS.Worksheet, m: Methodology, out: ParsedBook) {
  const sections = new Map(sectionsOf(m).map((s) => [s.code, s]));
  const seen = new Set<string>();
  let current: { code: string; name: string; row: number } | null = null;
  const last = ws.rowCount;
  for (let r = 1; r <= last; r++) {
    const row = ws.getRow(r);
    if (row.hidden) continue;
    const c = text(row.getCell(3).value);
    const code = /^(\d{1,2})\.(\d{1,2})\.?\s*(.*)$/s.exec(c);
    if (code && /^\d{1,2}\.\d{1,2}\./.test(c)) current = { code: `${Number(code[1])}.${Number(code[2])}`, name: (code[3] ?? '').trim(), row: r };
    if (norm(text(row.getCell(5).value)) !== COMMENT_MARK) continue;
    if (!current) {
      out.errors.push({ row: r, code: null, message: 'над строкой «Дополнительный комментарий» нет кода раздела' });
      continue;
    }
    const s = sections.get(current.code);
    if (!s) {
      out.errors.push({ row: r, code: current.code, message: `раздела ${current.code} нет в методике` });
      continue;
    }
    if (current.name && !sameName(current.name, s.name)) {
      out.errors.push({ row: current.row, code: current.code, message: `в файле раздел ${current.code} — «${current.name}», в методике — «${s.name}»` });
      continue;
    }
    if (seen.has(current.code)) {
      out.errors.push({ row: r, code: current.code, message: `раздел ${current.code} в файле встречается дважды` });
      continue;
    }
    seen.add(current.code);
    const lv = parseLevel(ws.getRow(r - 1).getCell(5).value);
    if ('error' in lv) {
      out.errors.push({ row: r - 1, code: current.code, message: lv.error });
      continue;
    }
    out.answers.push({ code: current.code, level: lv.level, comment: text(ws.getRow(r + 1).getCell(5).value).slice(0, COMMENT_MAX), row: r - 1 });
  }
}

/** «Общая информация»: значение в столбце E строки с подписью в столбцах A–D. */
function parseInfo(ws: ExcelJS.Worksheet, out: ParsedBook) {
  const labels: [keyof ParsedProfile, RegExp][] = [
    ['organization', /^организация/], ['assessedOn', /^дата проведения/], ['respondent', /^респондент/],
    ['position', /^должность/], ['employees', /^количество сотрудников/],
  ];
  for (let r = 1; r <= ws.rowCount; r++) {
    const label = norm([1, 2, 3, 4].map((c) => text(ws.getRow(r).getCell(c).value)).find(Boolean) ?? '');
    const hit = labels.find(([, re]) => re.test(label));
    if (!hit || out.profile[hit[0]] !== undefined) continue;
    const v = value(ws, r, 5);
    if (v === null) continue;
    if (hit[0] === 'assessedOn') {
      if (v instanceof Date && !Number.isNaN(v.getTime())) out.profile.assessedOn = v.toISOString().slice(0, 10);
      else {
        const d = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text(v));
        if (d) out.profile.assessedOn = `${d[3]}-${d[2]}-${d[1]}`;
      }
    } else if (hit[0] === 'employees') {
      const n = typeof v === 'number' ? v : Number(text(v).replace(/\s/g, ''));
      if (Number.isInteger(n) && n >= 0) out.profile.employees = n;
    } else {
      const t = text(v).slice(0, 300);
      if (t) out.profile[hit[0]] = t;
    }
  }
}

/** Лист «Ответы» нашей выгрузки: колонки «ID оценки», «Оценка», «Дата», «Код», «Балл». */
function parseAnswersSheet(ws: ExcelJS.Worksheet, m: Methodology, sourceId: string | null, targetId: string, out: ParsedBook) {
  const head = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => head.set(norm(text(cell.value)), col));
  const col = (name: string) => head.get(norm(name));
  const codeCol = col('Код');
  const levelCol = col('Балл');
  if (!codeCol || !levelCol) {
    out.errors.push({ row: 1, code: null, message: 'на листе «Ответы» нет колонок «Код» и «Балл»' });
    return;
  }
  const idCol = col('ID оценки');
  const titleCol = col('Оценка');
  const dateCol = col('Дата');
  const rows: { r: number; id: string }[] = [];
  const sources = new Map<string, ExportSource>();
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (!text(row.getCell(codeCol).value)) continue;
    const id = idCol ? text(row.getCell(idCol).value) : '';
    rows.push({ r, id });
    if (!sources.has(id)) {
      const d = dateCol ? cellPrimitive(row.getCell(dateCol).value) : null;
      sources.set(id, { id, title: titleCol ? text(row.getCell(titleCol).value) : '', date: d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d) : null });
    }
  }
  out.sources = [...sources.values()];
  // Какая оценка из файла: выбранная, иначе та же оценка, иначе единственная, иначе самая поздняя.
  const pick = (sourceId && sources.has(sourceId) ? sourceId : null)
    ?? (sources.has(targetId) ? targetId : null)
    ?? (sources.size === 1 ? [...sources.keys()][0] : null)
    ?? [...sources.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0]?.id
    ?? null;
  out.sourceId = pick;
  if (sources.size > 1) out.notes.push(`В файле ${sources.size} оценок — взяты баллы «${sources.get(pick ?? '')?.title || pick}»`);
  const sections = new Set(sectionsOf(m).map((s) => s.code));
  const seen = new Set<string>();
  for (const { r, id } of rows) {
    if (id !== (pick ?? '')) continue;
    const row = ws.getRow(r);
    const raw = cellPrimitive(row.getCell(codeCol).value);
    // «1.1» могло стать числом после пересохранения: 1.1 → «1.1».
    const code = typeof raw === 'number' ? String(raw) : text(raw);
    if (!sections.has(code)) {
      out.errors.push({ row: r, code, message: `раздела ${code} нет в методике` });
      continue;
    }
    if (seen.has(code)) {
      out.errors.push({ row: r, code, message: `раздел ${code} встречается дважды` });
      continue;
    }
    seen.add(code);
    const lv = parseLevel(row.getCell(levelCol).value);
    if ('error' in lv) out.errors.push({ row: r, code, message: lv.error });
    else out.answers.push({ code, level: lv.level, comment: '', row: r });
  }
}

/** Разбор книги по методике оценки. Нет листа «Чек-лист» — лист «Ответы» нашей выгрузки. */
export function parseAssessmentBook(wb: ExcelJS.Workbook, m: Methodology, opts: { targetId: string; sourceId?: string | null }): ParsedBook {
  const checklist = wb.getWorksheet(CHECKLIST_SHEET);
  const answers = wb.getWorksheet(ANSWERS_SHEET);
  const out: ParsedBook = { format: checklist ? 'checklist' : 'answers', answers: [], errors: [], notes: [], profile: {} };
  if (checklist) {
    parseChecklist(checklist, m, out);
    const info = wb.getWorksheet(INFO_SHEET);
    if (info) parseInfo(info, out);
    const hidden = checklist.getRows(1, checklist.rowCount)?.filter((r) => r.hidden).length ?? 0;
    if (hidden) out.notes.push(`Скрытые строки пропущены: ${hidden}`);
  } else if (answers) {
    parseAnswersSheet(answers, m, opts.sourceId ?? null, opts.targetId, out);
  } else {
    out.errors.push({ row: null, code: null, message: 'В книге нет листа «Чек-лист» (исходный шаблон) или «Ответы» (выгрузка портала)' });
    return out;
  }
  const found = new Set(out.answers.map((a) => a.code));
  const missing = sectionsOf(m).filter((s) => !found.has(s.code) && !out.errors.some((e) => e.code === s.code)).map((s) => s.code);
  if (missing.length) out.notes.push(`Нет в файле: ${missing.join(', ')} — эти разделы не меняются`);
  return out;
}
