import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseAssessmentBook, parseLevel } from './assessment-excel.js';
import { score, type AnswerInput, type Methodology } from './assessment-score.js';

const m = JSON.parse(readFileSync(new URL('../../prisma/seed/assessment-methodology.json', import.meta.url), 'utf8')) as Methodology;
const FIXTURE = new URL('../../test/fixtures/cyber-checklist-2025.xlsx', import.meta.url);
const ETALON = [2, 1, 2, 1, 2, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 2, 2, 2, 1];

async function book() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(FIXTURE) as unknown as ExcelJS.Buffer);
  return wb;
}

describe('самооценка: разбор исходного Excel (спецификация, раздел 9)', () => {
  it('эталон: 24 раздела, 34 балла, «Цифровая гигиена», домены 5/4/5/2/3/5/1/2/6/1; скрытый дубль 9.3 пропущен', async () => {
    const p = parseAssessmentBook(await book(), m, { targetId: 'x' });
    expect(p.format).toBe('checklist');
    expect(p.errors).toEqual([]);
    expect(p.answers.map((a) => a.code)).toEqual(m.domains.flatMap((d) => d.sections.map((s) => s.code)));
    expect(p.answers.map((a) => a.level)).toEqual(ETALON);
    // 9.3 — «Безопасность приложений» (строка 246), а не скрытый «Технологическая устойчивость» (строка 240).
    expect(p.answers.find((a) => a.code === '9.3')?.row).toBe(246);
    expect(p.notes.some((n) => n.startsWith('Скрытые строки пропущены'))).toBe(true);
    const s = score(m, new Map<string, AnswerInput>(p.answers.map((a) => [a.code, { level: a.level, target: null }])));
    expect(s).toMatchObject({ total: 34, answered: 24, level: { name: 'Цифровая гигиена' } });
    expect(s.domains.map((d) => d.sum)).toEqual([5, 4, 5, 2, 3, 5, 1, 2, 6, 1]);
  });

  it('профиль с листа «Общая информация»: организация, дата, респондент, должность, численность', async () => {
    const p = parseAssessmentBook(await book(), m, { targetId: 'x' });
    expect(p.profile).toEqual({
      organization: 'ЗАО МДО "Хумо"', assessedOn: '2025-07-07', respondent: 'Березин Сергей',
      position: 'Руководитель отдела по информационной безопасности', employees: 1800,
    });
  });

  it('объединённые ячейки (C140–C144 «5.1») не роняют разбор: значения читаются без cell.text', async () => {
    const wb = await book();
    const ws = wb.getWorksheet('Чек-лист');
    const merged = ws?.getRow(141).getCell(3);
    expect(merged?.isMerged).toBe(true);
    expect(() => parseAssessmentBook(wb, m, { targetId: 'x' })).not.toThrow();
  });

  it('«Выбрать ответ» — нет ответа; балл 5 — ошибка строки; комментарий — строкой ниже', async () => {
    const wb = await book();
    const ws = wb.getWorksheet('Чек-лист') as ExcelJS.Worksheet;
    const first = parseAssessmentBook(wb, m, { targetId: 'x' });
    const row = (code: string) => first.answers.find((a) => a.code === code)?.row as number;
    ws.getRow(row('1.1')).getCell(5).value = 'Выбрать ответ';
    ws.getRow(row('5.3')).getCell(5).value = 5;
    ws.getRow(row('2.1') + 2).getCell(5).value = 'Инвентаризация в работе';
    const p = parseAssessmentBook(wb, m, { targetId: 'x' });
    expect(p.answers.find((a) => a.code === '1.1')?.level).toBeNull();
    expect(p.answers.find((a) => a.code === '2.1')?.comment).toBe('Инвентаризация в работе');
    expect(p.errors).toEqual([{ row: row('5.3'), code: '5.3', message: 'балл «5» вне 1–4' }]);
  });

  it('балл: числа 1–4 и текст «3 Высокий»; пусто — нет ответа; остальное — ошибка', () => {
    expect([parseLevel(1), parseLevel('3 Высокий'), parseLevel(null), parseLevel('  '), parseLevel('Выбрать ответ')]).toEqual([
      { level: 1 }, { level: 3 }, { level: null }, { level: null }, { level: null },
    ]);
    expect(parseLevel(0)).toEqual({ error: 'балл «0» вне 1–4' });
    expect(parseLevel(2.5)).toEqual({ error: 'балл «2.5» вне 1–4' });
    expect(parseLevel('много')).toEqual({ error: 'балл «много» вне 1–4' });
  });

  it('эталон в методике v2 (1.13.10): 24 раздела, домен 11 «Контроль ИИ» в файле отсутствует — одной строкой, без перечня 11.x', async () => {
    const m2 = JSON.parse(readFileSync(new URL('../../prisma/seed/assessment-methodology-v2.json', import.meta.url), 'utf8')) as Methodology;
    const p = parseAssessmentBook(await book(), m2, { targetId: 'x' });
    expect(p.errors).toEqual([]);
    expect(p.answers).toHaveLength(24);
    expect(p.notes).toContain('Домен 11 «Контроль ИИ» в файле отсутствует — его разделы остаются пустыми');
    expect(p.notes.some((n) => n.startsWith('Нет в файле'))).toBe(false);
    const s = score(m2, new Map<string, AnswerInput>(p.answers.map((a) => [a.code, { level: a.level, target: null }])));
    expect(s).toMatchObject({ total: 34, max: 96, answered: 24, sections: 28, preliminary: true, level: { name: 'Цифровая гигиена' } });
  });

  it('книга без «Чек-листа» и «Ответов» — ошибка', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Лист1');
    expect(parseAssessmentBook(wb, m, { targetId: 'x' }).errors[0]?.message).toMatch(/нет листа «Чек-лист»/);
  });
});
