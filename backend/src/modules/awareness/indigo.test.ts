// Разбор отчёта INDIGO (релиз 1.8.0, docs/specs/awareness.md, разделы 4.2–4.4). Отчёт генерирует код, люди вымышленные.
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { readSheets, type SheetCell } from '../../lib/spreadsheetml.js';
import { fictitiousPeople, indigoRows, indigoSheet, indigoXlsx, type IndigoOptions } from '../../test/awareness-files.js';
import { completenessOf, findHeader, findSummary, parseIndigoReport } from './indigo.js';

const people = fictitiousPeople(4, (i) => [95, 80, 60, 30][i] ?? 50);
const parse = (o: IndigoOptions) => parseIndigoReport([indigoSheet(o)]);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
  return undefined;
}

describe('заголовки и тройки «Б, М, %»', () => {
  it('находит колонки по тексту, тройки слева направо с пустыми колонками между ними', () => {
    const h = findHeader(indigoRows({ people }));
    expect(h.row).toBe(10);
    expect([h.no, h.last, h.first, h.middle, h.group, h.date, h.spent]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(h.triples).toEqual([{ b: 8, m: 9, p: 11 }, { b: 12, m: 13, p: 14 }, { b: 15, m: 16, p: 17 }]);
  });
  it('сдвинутые колонки — тот же разбор', () => {
    const plain = parse({ people });
    const shifted = parse({ people, shift: 3 });
    expect(shifted.rows.map((r) => [r.fio, r.percent, r.regularPct, r.multiPct, r.score, r.maxScore]))
      .toEqual(plain.rows.map((r) => [r.fio, r.percent, r.regularPct, r.multiPct, r.score, r.maxScore]));
    expect(shifted.completeness).toEqual(plain.completeness);
  });
  it('нет «№» и «Фамилии» — строка заголовков не найдена', () => {
    expect(codeOf(() => findHeader([['Фамилия', 'Имя'], ['x']]))).toBe('INDIGO_NO_HEADER');
  });
  it('нет итоговой тройки или «Даты» — ошибка называет, чего нет', () => {
    const rows = indigoRows({ people });
    const header = [...(rows[10] ?? [])];
    header[15] = null; // итоговое «Б»
    header[5] = 'Когда';
    try {
      findHeader([...rows.slice(0, 10), header]);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('INDIGO_NO_COLUMNS');
      expect((e as AppError).message).toContain('«Дата»');
      expect((e as AppError).message).toContain('найдено: 2');
    }
  });
});

describe('сводка по меткам', () => {
  it('метки без регистра, пробелов и «:», числа по группам', () => {
    const s = findSummary(indigoRows({ people }), 10);
    expect(s.всего).toEqual({ regular: 24, multi: 16, total: 40 });
    expect(s.максбалл).toEqual({ regular: 6, multi: 4, total: 10 });
    expect(s.среднийбалл).toEqual({ regular: 5, multi: 3, total: 8 });
    expect(s.процент?.total).toBe(66.3);
  });
  it('без строки подписей групп — числа слева направо', () => {
    const s = findSummary(indigoRows({ people, noGroupHeader: true }), 10);
    expect(s.всего).toEqual({ regular: 24, multi: 16, total: 40 });
  });
  it('по подписям групп: пустая ячейка в группе не сдвигает остальные', () => {
    const rows: SheetCell[][] = [
      ['Тест'],
      [null, null, 'Обычные вопросы', null, 'Мультивыбор вопросы', null, 'Итого'],
      [null, 'Всего', null, null, 16, null, 40],
      ['№', 'Фамилия'],
    ];
    expect(findSummary(rows, 3).всего).toEqual({ regular: null, multi: 16, total: 40 });
  });
  it('нет сводки — пусто', () => {
    expect(findSummary(indigoRows({ people, noSummary: true }), 10)).toEqual({});
  });
});

describe('строки', () => {
  it('ФИО, группа, дата, время, проценты, баллы', () => {
    const [first] = parse({ people }).rows;
    expect(first).toMatchObject({
      line: 12, fio: 'Иванов Иван Иванович', hasMiddleName: true, group: 'Отдел проверки', date: '2026-10-01', spent: '00:12:34',
      percent: 95, regularPct: 95, multiPct: 95, score: 10, maxScore: 10, errors: [], warnings: [],
    });
  });
  it('без отчества — отмечено; неразбираемая дата и не число в «%» — ошибки строки, остальные строки загружаются', () => {
    const r = parse({
      people: [
        { last: 'Иванов', first: 'Иван', percent: 70 },
        { last: 'Петров', first: 'Пётр', middle: 'Петрович', date: '31.02.2026', percent: 70 },
        { last: 'Сидоров', first: 'Сергей', middle: 'Сергеевич', percent: 'н/д' },
        { last: '', first: '', percent: 70 },
        { last: 'Попов', first: 'Андрей', middle: 'Андреевич', date: new Date(Date.UTC(2026, 9, 2)), spent: 754 / 86_400, percent: 55 },
      ],
    }).rows;
    expect(r[0]).toMatchObject({ fio: 'Иванов Иван', hasMiddleName: false, errors: [] });
    expect(r[1]?.errors).toEqual(['Дата «31.02.2026» не распознана']);
    expect(r[2]?.errors).toEqual(['«Результат, %» не число: «н/д»']);
    expect(r[3]?.errors).toContain('Нет ФИО');
    expect(r[4]).toMatchObject({ date: '2026-10-02', spent: '00:12:34', errors: [] });
  });
  it('время не ЧЧ:ММ:СС — предупреждение строки, значение как есть', () => {
    const [row] = parse({ people: [{ last: 'Иванов', first: 'Иван', middle: 'Иванович', spent: '12 мин', percent: 70 }] }).rows;
    expect(row?.spent).toBe('12 мин');
    expect(row?.warnings[0]).toContain('«12 мин»');
    expect(row?.errors).toEqual([]);
  });
  it('строки после пустой не читаются — предупреждение', () => {
    const r = parse({ people, after: fictitiousPeople(2) });
    expect(r.rows).toHaveLength(4);
    expect(r.warnings).toContain('После пустой строки 16 есть ещё данные — они не загружены');
  });
});

describe('полнота', () => {
  it('сошлось: строки × МаксБалл = Всего; средние сводки и строк рядом', () => {
    const c = parse({ people }).completeness;
    expect(c).toEqual({
      rows: 4, summaryTotal: 40, summaryMax: 10, summaryPercent: 66.3, rowsPercent: 66.3, errorRows: 0, complete: true, percentMismatch: false,
    });
  });
  it('не сошлось — предупреждение, импорт не блокируется', () => {
    const r = parse({ people, summaryRows: 6 });
    expect(r.completeness.complete).toBe(false);
    expect(r.warnings).toContain('Отчёт может быть неполным: по сводке 60 ответов (это 6 попыток), в таблице 4 строк');
  });
  it('нет сводки — сверка не выполнена', () => {
    const r = parse({ people, noSummary: true });
    expect(r.completeness.complete).toBeNull();
    expect(r.warnings).toContain('Сводка не найдена — полнота не проверена');
  });
  it('МаксБалл 0 — сверка не выполнена', () => {
    const rows = parse({ people }).rows;
    const c = completenessOf(rows, { всего: { regular: 0, multi: 0, total: 0 }, максбалл: { regular: 0, multi: 0, total: 0 } });
    expect(c.completeness.complete).toBeNull();
    expect(c.warnings).toEqual(['В сводке «МаксБалл» равен 0 — полнота не проверена']);
  });
  it('строки с ошибками не входят в средний процент; расхождение больше 0,5 п. п. отмечено', () => {
    const rows = parse({ people: [...people, { last: 'Ошибкин', first: 'Тест', middle: 'Тестович', percent: 'x' }] }).rows;
    const c = completenessOf(rows, { процент: { regular: null, multi: null, total: 70 } }).completeness;
    expect(c.errorRows).toBe(1);
    expect(c.rowsPercent).toBe(66.3);
    expect(c.percentMismatch).toBe(true);
  });
});

describe('книга целиком', () => {
  it('лист по названию без регистра; единственный лист с другим названием — он же', () => {
    expect(parseIndigoReport([{ name: 'Сводка', rows: [] }, indigoSheet({ people }, ' статистика  по баллам ')]).rows).toHaveLength(4);
    expect(parseIndigoReport([indigoSheet({ people }, 'Лист1')]).rows).toHaveLength(4);
    expect(codeOf(() => parseIndigoReport([{ name: 'A', rows: [] }, { name: 'B', rows: [] }]))).toBe('INDIGO_NO_SHEET');
  });
  it('нет названия теста или строк — ошибка', () => {
    expect(codeOf(() => parse({ people, test: '' }))).toBe('INDIGO_NO_TEST');
    expect(codeOf(() => parse({ people: [] }))).toBe('INDIGO_NO_ROWS');
  });
  it('.xlsx с объединёнными ячейками: тест из A1, двуязычное название как есть', async () => {
    const buf = await indigoXlsx({ people, shift: 2 });
    const r = parseIndigoReport(await readSheets(buf, 20_000));
    expect(r.test).toBe('Тест по информационной безопасности | Information security test');
    expect(r.rows.map((x) => x.percent)).toEqual([95, 80, 60, 30]);
    expect(r.completeness.complete).toBe(true);
  });
  it('450 строк — разбор и полнота', () => {
    const r = parse({ people: fictitiousPeople(450) });
    expect(r.rows).toHaveLength(450);
    expect(r.completeness.complete).toBe(true);
  });
});
