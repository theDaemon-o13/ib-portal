// Самооценка (этап Д4): импорт исходного Excel и выгрузка таблиц для анализа. БД — транзакция с откатом.
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { exportAssessments, importAssessment } from './excel.js';
import * as svc from './service.js';

const FIXTURE = readFileSync(new URL('../../../test/fixtures/cyber-checklist-2025.xlsx', import.meta.url));
const ETALON = [2, 1, 2, 1, 2, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 2, 2, 2, 1];

async function fixture(tx: Tx) {
  const owner = await makeUser(tx, ['assessment'], { fullName: 'Владелец самооценки' });
  await tx.assessment.updateMany({ where: { status: 'draft' }, data: { status: 'archived', archivedAt: new Date() } });
  const as = async () => actorFor(tx, owner.id);
  const create = async (title = 'Экспресс-оценка 2025') => svc.createAssessment(tx, await as(), { title, assessedOn: '2026-10-30' });
  const version = async (id: string) => (await tx.assessment.findUniqueOrThrow({ where: { id } })).version;
  const levels = async (id: string) => (await svc.getAssessment(tx, id)).answers;
  return { owner, as, create, version, levels };
}

/** Эталон с правками: ячейка ответа раздела → value, комментарий раздела → comment. */
async function editedFixture(edit: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(FIXTURE as unknown as ExcelJS.Buffer);
  edit(wb.getWorksheet('Чек-лист') as ExcelJS.Worksheet);
  // exceljs не записывает обратно условное форматирование эталона (падает в CfRuleXform) — для копии оно не нужно.
  for (const ws of wb.worksheets) ws.removeConditionalFormatting(undefined);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
// Строки эталона: ответ 1.1 — E25, комментарий 1.1 — E27; ответ 5.3 — E153.
const ANSWER_1_1 = 25;
const COMMENT_1_1 = 27;
const ANSWER_5_3 = 153;

describe('самооценка: импорт Excel', () => {
  it('эталон: предпросмотр ничего не пишет; применение — 24 раздела, 34 балла, профиль, журнал без текста комментариев', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const file = await editedFixture((ws) => { ws.getRow(COMMENT_1_1).getCell(5).value = 'Секрет импорта'; });
      const v = await x.version(id);
      const preview = await importAssessment(tx, await x.as(), id, file, { dryRun: true });
      expect(preview).toMatchObject({ format: 'checklist', version: v, found: 24, answered: 24, errors: [], total: 34, level: { name: 'Цифровая гигиена' }, applied: false });
      expect(preview.changes).toHaveLength(24);
      expect(preview.changes[0]).toEqual({ code: '1.1', name: 'Стратегия', from: null, to: 2, comment: true });
      expect(preview.profile.map((p) => p.label)).toEqual(['Организация', 'Дата проведения', 'Респондент', 'Должность', 'Численность сотрудников']);
      expect((await x.levels(id)).every((a) => a.level === null)).toBe(true);
      expect(await x.version(id)).toBe(v);

      const res = await importAssessment(tx, await x.as(), id, file, { dryRun: false, version: v });
      expect(res).toMatchObject({ applied: true, version: v + 1 });
      const d = await svc.getAssessment(tx, id);
      expect(d).toMatchObject({ total: 34, answered: 24, preliminary: false, assessedOn: '2025-07-07', profile: { organization: 'ЗАО МДО "Хумо"', employees: 1800 } });
      expect(d.score.domains.map((s) => s.sum)).toEqual([5, 4, 5, 2, 3, 5, 1, 2, 6, 1]);
      expect(d.answers.find((a) => a.code === '1.1')?.comment).toBe('Секрет импорта');
      const log = await tx.auditLog.findMany({ where: { entity: 'assessment', entityId: id, action: 'assessment.imported' } });
      expect(log).toHaveLength(1);
      expect(JSON.stringify(log[0]?.diff)).not.toContain('Секрет импорта');
      expect((log[0]?.diff as { summary: string }).summary).toMatch(/импорт из Excel — разделов изменено 24, профиль обновлён; итог 34 из 96$/);
    }));

  it('пустой ответ не стирает выставленный балл; «Выбрать ответ» — нет ответа', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const a = must((await x.levels(id)).find((s) => s.code === '1.1'));
      await svc.saveAnswer(tx, await x.as(), id, '1.1', { version: a.version, level: 4 });
      const file = await editedFixture((ws) => { ws.getRow(ANSWER_1_1).getCell(5).value = 'Выбрать ответ'; });
      const preview = await importAssessment(tx, await x.as(), id, file, { dryRun: true });
      expect(preview.answered).toBe(23);
      expect(preview.changes.find((c) => c.code === '1.1')).toBeUndefined();
    }));

  it('балл 5 — ошибка строки, применить нельзя; ничего не записано', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const file = await editedFixture((ws) => { ws.getRow(ANSWER_5_3).getCell(5).value = 5; });
      const v = await x.version(id);
      const preview = await importAssessment(tx, await x.as(), id, file, { dryRun: true });
      expect(preview.errors).toEqual([{ row: ANSWER_5_3, code: '5.3', message: 'балл «5» вне 1–4' }]);
      await expectCode(importAssessment(tx, await x.as(), id, file, { dryRun: false, version: v }), 'IMPORT_ERRORS');
      expect((await x.levels(id)).every((s) => s.level === null)).toBe(true);
    }));

  it('оценку изменили после предпросмотра — 409, ничего не записано; не черновик — 409', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const { version } = await importAssessment(tx, await x.as(), id, FIXTURE, { dryRun: true });
      const a = must((await x.levels(id)).find((s) => s.code === '7.1'));
      await svc.saveAnswer(tx, await x.as(), id, '7.1', { version: a.version, level: 3 });
      await expectCode(importAssessment(tx, await x.as(), id, FIXTURE, { dryRun: false, version }), 'VERSION_CONFLICT');
      expect((await x.levels(id)).filter((s) => s.level !== null).map((s) => s.code)).toEqual(['7.1']);
      await expectCode(importAssessment(tx, await x.as(), id, FIXTURE, { dryRun: false }), 'VERSION_CONFLICT');

      await importAssessment(tx, await x.as(), id, FIXTURE, { dryRun: false, version: await x.version(id) });
      await svc.finalizeAssessment(tx, await x.as(), id, { version: await x.version(id) });
      await expectCode(importAssessment(tx, await x.as(), id, FIXTURE, { dryRun: true }), 'NOT_DRAFT');
      await expectCode(importAssessment(tx, await x.as(), id, Buffer.from('не excel'), { dryRun: true }), 'BAD_FILE');
    }));
});

describe('самооценка: выгрузка для анализа', () => {
  it('листы, заголовки, типы, закреплённая строка и автофильтр; архивные — только по ids', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await importAssessment(tx, await x.as(), id, FIXTURE, { dryRun: false, version: await x.version(id) });
      await svc.finalizeAssessment(tx, await x.as(), id, { version: await x.version(id) });
      const { fileName, buffer } = await exportAssessments(tx, await x.as(), [id]);
      expect(fileName).toMatch(/^Самооценка_КБ_\d{4}-\d{2}-\d{2}\.xlsx$/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      expect(wb.worksheets.map((w) => w.name)).toEqual(['Оценки', 'Ответы', 'Домены', 'Задачи', 'Методика']);
      const header = (name: string) => (wb.getWorksheet(name)?.getRow(1).values as unknown[]).slice(1);
      expect(header('Оценки')).toEqual(['ID оценки', 'Оценка', 'Дата', 'Статус', 'Итог', 'Максимум', 'Заполнено разделов', 'Уровень КБ', 'Итог предварительный', 'Дата фиксации']);
      expect(header('Ответы')).toEqual(['ID оценки', 'Оценка', 'Дата', 'Домен №', 'Домен', 'Код', 'Раздел', 'Ключевой', 'Балл', 'Уровень', 'Целевой балл', 'Разрыв', 'Комментарий', 'Задач', 'Задач выполнено']);
      expect(header('Домены')).toEqual(['ID оценки', 'Оценка', 'Дата', 'Домен №', 'Домен', 'Разделов', 'Отвечено', 'Сумма', 'Максимум', 'Средний балл', 'Средний целевой']);
      expect(header('Задачи')).toEqual(['ID оценки', 'Оценка', 'Код', 'Раздел', 'Задача', 'Исполнитель', 'Срок', 'Статус']);
      expect(header('Методика')).toEqual(['Домен №', 'Домен', 'Код', 'Раздел', 'Ключевой', 'Целевое состояние', '1 Базовый', '2 Средний', '3 Высокий', '4 Продвинутый']);
      for (const ws of wb.worksheets) {
        expect(ws.autoFilter, ws.name).toBeTruthy();
        expect(ws.views[0], ws.name).toMatchObject({ state: 'frozen', ySplit: 1 });
      }
      const row = wb.getWorksheet('Оценки')?.getRow(2);
      expect(row?.getCell(3).value).toBeInstanceOf(Date);
      expect(row?.getCell(5).value).toBe(34);
      expect(row?.getCell(8).value).toBe('Цифровая гигиена');
      expect(wb.getWorksheet('Ответы')?.rowCount).toBe(25);
      expect(wb.getWorksheet('Домены')?.rowCount).toBe(11);
      expect(wb.getWorksheet('Ответы')?.getRow(2).getCell(9).value).toBe(2);
      expect(await tx.auditLog.count({ where: { action: 'assessment.exported', userId: x.owner.id } })).toBe(1);

      // Без ids — все, кроме архивных.
      await svc.archiveAssessment(tx, await x.as(), id, { version: await x.version(id) });
      const all = new ExcelJS.Workbook();
      await all.xlsx.load((await exportAssessments(tx, await x.as())).buffer as unknown as ExcelJS.Buffer);
      const ids = (all.getWorksheet('Оценки')?.getColumn(1).values as unknown[]).slice(2);
      expect(ids).not.toContain(id);
    }));

  it('выгрузка → импорт листа «Ответы» в новую оценку даёт те же баллы', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const first = await x.create('Экспресс-оценка 2025');
      await importAssessment(tx, await x.as(), first, FIXTURE, { dryRun: false, version: await x.version(first) });
      await svc.finalizeAssessment(tx, await x.as(), first, { version: await x.version(first) });
      const { buffer } = await exportAssessments(tx, await x.as(), [first]);

      const second = await x.create('Экспресс-оценка 2026');
      const preview = await importAssessment(tx, await x.as(), second, buffer, { dryRun: true });
      expect(preview).toMatchObject({ format: 'answers', found: 24, errors: [], sourceId: first, total: 34 });
      // Дата — из «Общей информации» эталона: импорт переносит и её.
      expect(preview.sources).toEqual([{ id: first, title: 'Экспресс-оценка 2025', date: '2025-07-07' }]);
      await importAssessment(tx, await x.as(), second, buffer, { dryRun: false, version: preview.version });
      const [a, b] = await Promise.all([x.levels(first), x.levels(second)]);
      expect(b.map((s) => [s.code, s.level])).toEqual(a.map((s) => [s.code, s.level]));
      expect(a.find((s) => s.code === '1.1')?.level).toBe(ETALON[0]);
    }));
});
