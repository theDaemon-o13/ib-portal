// Системные виджеты «Осведомлённости» (релиз 1.8.0, docs/specs/awareness.md, раздел 6): «На пересдачу» без уволенных
// и «Средний результат по подразделениям». Числа виджета = total списка по его ссылке. Люди вымышленные.
import { describe, expect, it } from 'vitest';
import type { Values } from '../../lib/register-values.js';
import { actorFor, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY } from '../awareness/definition.js';
import { loadRegister, type RegisterDef } from '../registers/definition.js';
import { parseRecordFilter, RecordFilterQuery } from '../registers/filter.js';
import * as records from '../registers/records.service.js';
import { AWARENESS_DEPT_WIDGET, AWARENESS_RETAKE_WIDGET } from './awareness-widgets.js';
import { listWidgets, widgetData } from './service.js';

async function setup(tx: Tx) {
  const actor = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
  const reg = async (key: string) => loadRegister(tx, must(await tx.register.findUnique({ where: { systemKey: key } })).id);
  const emp = await reg(AWARENESS_EMPLOYEES_KEY);
  const res = await reg(AWARENESS_RESULTS_KEY);
  const F = (r: RegisterDef, k: string) => must(r.fields.find((f) => f.systemKey === k), k).id;
  const O = (r: RegisterDef, k: string, key: string) => must(r.fields.find((f) => f.systemKey === k)?.options.find((o) => o.systemKey === key), key).id;
  const employee = async (fio: string, status: 'working' | 'fired') => (await records.createRecord(tx, actor, emp.id, {
    values: { [F(emp, 'fullName')]: fio, [F(emp, 'status')]: O(emp, 'status', status) },
  })).id;
  const result = async (fio: string, percent: number, dept: string, opts: { employee?: string; date?: string } = {}) => {
    const number = await records.nextNumbers(tx, res.id, 1);
    const values: Values = {
      [F(res, 'attemptKey')]: `т | ${fio} | ${number}`, [F(res, 'fullName')]: fio, [F(res, 'test')]: 'Тест ИБ', [F(res, 'date')]: opts.date ?? '2026-10-01',
      [F(res, 'percent')]: percent, [F(res, 'dept')]: dept, [F(res, 'retake')]: O(res, 'retake', percent < 50 ? 'yes' : 'no'),
      ...(opts.employee ? { [F(res, 'employee')]: [opts.employee] } : {}),
    };
    return (await tx.registerRecord.create({ data: { registerId: res.id, number, values } })).id;
  };
  /** Число по ссылке виджета — тем же кодом, что total списка. */
  const total = async (link: string) => {
    const params = Object.fromEntries(new URLSearchParams(link.slice(link.indexOf('?') + 1, link.indexOf('#'))));
    return (await records.listRecords(tx, res.id, { limit: 500, filter: parseRecordFilter(res, RecordFilterQuery.parse(params)) })).total;
  };
  return { res, employee, result, total };
}

describe('виджеты «Осведомлённости»', () => {
  it('в списке виджетов — оба системных, у реестра «Результаты INDIGO»', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const keys = (await listWidgets(tx)).filter((w) => w.registerId === s.res.id).map((w) => [w.key, w.kind]);
      expect(keys).toEqual(expect.arrayContaining([[AWARENESS_RETAKE_WIDGET, 'list'], [AWARENESS_DEPT_WIDGET, 'bars']]));
    }));

  it('«На пересдачу»: без уволенных, несопоставленные считаются; число = total списка по ссылке; до 6 последних', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const working = await s.employee('Иванов Иван Иванович', 'working');
      const fired = await s.employee('Петров Пётр Петрович', 'fired');
      await s.result('Иванов Иван Иванович', 30, 'Отдел А', { employee: working, date: '2026-10-03' });
      await s.result('Петров Пётр Петрович', 20, 'Отдел Б', { employee: fired });
      await s.result('Сидоров Сергей', 40, 'Отдел Б', { date: '2026-10-02' });
      await s.result('Кузнецов Кирилл Тестович', 90, 'Отдел А');
      for (let i = 0; i < 6; i++) await s.result(`Тестов Т${i}`, 10, 'Отдел В', { date: `2026-09-0${i + 1}` });
      const w = await widgetData(tx, AWARENESS_RETAKE_WIDGET);
      expect(w.total).toBe(8);
      expect(await s.total(must(w.link))).toBe(8);
      expect(w.items).toHaveLength(6);
      expect(w.items.map((i) => i.title).slice(0, 2)).toEqual(['Иванов Иван Иванович', 'Сидоров Сергей']);
      expect(w.items.some((i) => i.title.startsWith('Петров'))).toBe(false);
      expect(w.items[0]?.link).toMatch(/^\/registers\?record=[0-9a-f-]+#[0-9a-f-]+\/records$/);
    }));

  it('«Средний по подразделениям»: все, от худшего к лучшему, по нормализованному названию; полоса = список по ссылке', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.result('А1', 90, 'Отдел А');
      await s.result('А2', 70, 'отдел  а');
      await s.result('Б1', 40, 'Отдел Б');
      for (let i = 0; i < 14; i++) await s.result(`В${i}`, 50 + i, `Отдел ${String(i).padStart(2, '0')}`);
      const w = await widgetData(tx, AWARENESS_DEPT_WIDGET);
      expect(w.rows).toHaveLength(16);
      expect(w.rows[0]).toMatchObject({ label: 'Отдел Б', count: 40 });
      // Два написания по разу — подпись первая по алфавиту; группа одна.
      const a = must(w.rows.find((r) => r.label.toLowerCase() === 'отдел а'));
      expect(a.count).toBe(80);
      expect(await s.total(must(a.link))).toBe(2);
      expect(w.rows.map((r) => r.count)).toEqual([...w.rows.map((r) => r.count)].sort((x, y) => x - y));
      expect(w.stats[0]?.value).toBe(Math.round(((90 + 70 + 40 + [...Array(14).keys()].reduce((x, i) => x + 50 + i, 0)) / 17) * 10) / 10);
    }));
});
