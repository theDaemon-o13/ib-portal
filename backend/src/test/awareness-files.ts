// Тестовые файлы «Осведомлённости» (релиз 1.8.0, docs/specs/awareness.md, раздел 9): отчёт INDIGO «Статистика по баллам»
// и выгрузка HR. Генерируются кодом по описанию форматов; люди и подразделения вымышленные («Иванов Иван Иванович»,
// «Отдел тестирования»). Файлов с данными в git нет.
import ExcelJS from 'exceljs';
import type { SheetCell, SheetData } from '../lib/spreadsheetml.js';

export interface IndigoPerson {
  last: string;
  first: string;
  middle?: string;
  group?: string;
  /** ДД.ММ.ГГГГ текстом, ячейка-дата или мусор — как в файле. */
  date?: SheetCell;
  spent?: SheetCell;
  /** Итоговый «Результат, %». Текст — как есть (для проверки ошибок строки). */
  percent: number | string;
}

export interface IndigoOptions {
  test?: string;
  people: IndigoPerson[];
  /** Пустых колонок слева: «сдвинутые колонки». */
  shift?: number;
  /** Без сводки над таблицей. */
  noSummary?: boolean;
  /** Без строки подписей групп («Обычные вопросы» / «Мультивыбор вопросы»). */
  noGroupHeader?: boolean;
  /** «Всего» итога в сводке считается на столько строк, а не на фактические (неполный отчёт). */
  summaryRows?: number;
  /** После пустой строки — ещё строки данных (не должны загрузиться). */
  after?: IndigoPerson[];
}

/** Максимальные баллы групп: обычные, мультивыбор, итог. */
export const INDIGO_MAX = { regular: 6, multi: 4, total: 10 } as const;

const pctNum = (p: IndigoPerson) => (typeof p.percent === 'number' ? p.percent : 0);

/**
 * Лист отчёта. Раскладка (s — сдвиг): строка 1 — название теста; строка 2 — подписи групп; строки 3–10 — сводка с метками
 * в колонке s+1; строка 11 — заголовки: № Фамилия Имя Отчество Группа Дата Затрачено, пустая, тройки «Б М (пусто) %»,
 * «Б М %», «Б М %» — с пустыми колонками внутри и между тройками.
 */
export function indigoRows(o: IndigoOptions): SheetCell[][] {
  const s = o.shift ?? 0;
  const at = (cells: [number, SheetCell][], width = s + 18): SheetCell[] => {
    const row: SheetCell[] = Array.from({ length: width }, () => null);
    for (const [i, v] of cells) row[s + i] = v;
    return row;
  };
  const C = { reg: 8, multi: 12, total: 15 };
  const n = o.summaryRows ?? o.people.length;
  const avg = o.people.length ? Math.round((o.people.reduce((a, p) => a + pctNum(p), 0) / o.people.length) * 10) / 10 : 0;
  const summaryLine = (label: string, reg: number, multi: number, total: number) => at([[1, label], [C.reg, reg], [C.multi, multi], [C.total, total]]);
  const rows: SheetCell[][] = [
    at([[0, o.test ?? 'Тест по информационной безопасности | Information security test']]),
    o.noGroupHeader ? [] : at([[C.reg, 'Обычные вопросы'], [C.multi, 'Мультивыбор вопросы'], [C.total, 'Итого']]),
  ];
  if (o.noSummary) {
    for (let i = 0; i < 8; i++) rows.push([]);
  } else {
    rows.push(
      summaryLine('Всего:', n * INDIGO_MAX.regular, n * INDIGO_MAX.multi, n * INDIGO_MAX.total),
      summaryLine('Верно', 1, 1, 2),
      summaryLine('Частично', 0, 0, 0),
      summaryLine('Неверно', 1, 1, 2),
      summaryLine('Пропущено', 0, 0, 0),
      summaryLine('Средний балл', 5, 3, 8),
      summaryLine('МаксБалл', INDIGO_MAX.regular, INDIGO_MAX.multi, INDIGO_MAX.total),
      summaryLine('Процент', avg, avg, avg),
    );
  }
  rows.push(at([
    [0, '№'], [1, 'Фамилия'], [2, 'Имя'], [3, 'Отчество'], [4, 'Группа'], [5, 'Дата'], [6, 'Затрачено'],
    [C.reg, 'Б'], [C.reg + 1, 'М'], [C.reg + 3, '%'], [C.multi, 'Б'], [C.multi + 1, 'М'], [C.multi + 2, '%'], [C.total, 'Б'], [C.total + 1, 'М'], [C.total + 2, '%'],
  ]));
  const person = (p: IndigoPerson, i: number) => {
    const pc = pctNum(p);
    return at([
      [0, i + 1], [1, p.last], [2, p.first], [3, p.middle ?? null], [4, p.group ?? 'Отдел тестирования'],
      [5, p.date === undefined ? '01.10.2026' : p.date], [6, p.spent === undefined ? '00:12:34' : p.spent],
      [C.reg, Math.round((pc / 100) * INDIGO_MAX.regular)], [C.reg + 1, INDIGO_MAX.regular], [C.reg + 3, pc],
      [C.multi, Math.round((pc / 100) * INDIGO_MAX.multi)], [C.multi + 1, INDIGO_MAX.multi], [C.multi + 2, pc],
      [C.total, Math.round((pc / 100) * INDIGO_MAX.total)], [C.total + 1, INDIGO_MAX.total], [C.total + 2, p.percent],
    ]);
  };
  o.people.forEach((p, i) => rows.push(person(p, i)));
  if (o.after?.length) {
    rows.push([]);
    o.after.forEach((p, i) => rows.push(person(p, o.people.length + i)));
  }
  return rows;
}

export const indigoSheet = (o: IndigoOptions, name = 'Статистика по баллам'): SheetData => ({ name, rows: indigoRows(o) });

/** Отчёт .xlsx, как после пересохранения из Excel: название теста в объединённой A1, подписи групп объединены. */
export async function indigoXlsx(o: IndigoOptions, sheetName = 'Статистика по баллам'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  indigoRows(o).forEach((r, i) => {
    const row = ws.getRow(i + 1);
    r.forEach((v, c) => { if (v !== null) row.getCell(c + 1).value = v; });
  });
  const s = o.shift ?? 0;
  ws.mergeCells(1, s + 1, 1, s + 8);
  if (!o.noGroupHeader) {
    ws.mergeCells(2, s + 9, 2, s + 12);
    ws.mergeCells(2, s + 13, 2, s + 15);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const SURNAMES = ['Иванов', 'Петров', 'Сидоров', 'Кузнецов', 'Смирнов', 'Попов', 'Васильев', 'Новиков', 'Морозов', 'Волков'];
const NAMES = ['Иван', 'Пётр', 'Сергей', 'Андрей', 'Алексей'];
const PATRONYMICS = ['Иванович', 'Петрович', 'Сергеевич', 'Андреевич', 'Алексеевич', 'Тестович'];

/** N вымышленных людей с разными ФИО (фамилии с номером, чтобы не повторялись при большом N). */
export function fictitiousPeople(n: number, percent = (i: number) => 40 + (i * 7) % 61): IndigoPerson[] {
  return Array.from({ length: n }, (_, i) => ({
    last: `${SURNAMES[i % SURNAMES.length]}${i >= SURNAMES.length ? `-${Math.floor(i / SURNAMES.length)}` : ''}`,
    first: NAMES[i % NAMES.length] ?? 'Иван',
    middle: PATRONYMICS[i % PATRONYMICS.length] ?? 'Иванович',
    group: i % 2 ? 'Отдел тестирования' : 'Отдел проверки',
    percent: percent(i),
  }));
}
