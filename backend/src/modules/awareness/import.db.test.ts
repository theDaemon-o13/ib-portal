// Импорт отчёта INDIGO (релиз 1.8.0, docs/specs/awareness.md, раздел 4, ADR-0037, ADR-0038). Отчёты генерирует код,
// люди и подразделения вымышленные. Каждый тест — в транзакции с откатом.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import type { Values } from '../../lib/register-values.js';
import { indigoXlsx, type IndigoPerson } from '../../test/awareness-files.js';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { loadRegister, type RegisterDef } from '../registers/definition.js';
import * as excel from '../registers/excel.service.js';
import * as records from '../registers/records.service.js';
import { AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY } from './definition.js';
import { AWARENESS_GRADES_KEY } from './grades.js';
import { indigoImportAdapter } from './import.js';

const PASSWORD = 'Indigo-Test-Pass-2026';

async function setup(tx: Tx) {
  const user = await makeUser(tx, ['ib_staff'], { passwordHash: await argon2Hasher.hash(PASSWORD) });
  const actor = await actorFor(tx, user.id);
  const reg = async (key: string) => loadRegister(tx, must(await tx.register.findUnique({ where: { systemKey: key } })).id);
  const emp = await reg(AWARENESS_EMPLOYEES_KEY);
  const res = await reg(AWARENESS_RESULTS_KEY);
  const F = (r: RegisterDef, k: string) => must(r.fields.find((f) => f.systemKey === k), k);
  const O = (r: RegisterDef, k: string, key: string) => must(F(r, k).options.find((o) => o.systemKey === key), `${k}.${key}`);
  const employee = async (fio: string, dept: string, status: 'working' | 'fired' = 'working') => (await records.createRecord(tx, actor, emp.id, {
    values: { [F(emp, 'fullName').id]: fio, [F(emp, 'dept').id]: dept, [F(emp, 'status').id]: O(emp, 'status', status).id },
  })).id;
  /** Предпросмотр и применение отчёта; choices — ручной выбор по строкам отчёта. */
  const load = async (people: IndigoPerson[], choices?: Record<string, string | null>, test?: string) => {
    const buf = await indigoXlsx({ people, test });
    const pre = await excel.previewImport(tx, actor, res.id, buf, 'отчёт.xlsx', await indigoImportAdapter(tx, res.id, buf));
    const applied = await excel.applyImport(tx, actor, pre.id, { choices });
    return { pre, applied };
  };
  const results = async () => (await tx.registerRecord.findMany({ where: { registerId: res.id, deletedAt: null }, orderBy: { number: 'asc' } }))
    .map((r) => ({ id: r.id, number: r.number, version: r.version, v: r.values as Values }));
  return { user, actor, emp, res, F, O, employee, load, results };
}

const p = (last: string, first: string, middle: string | undefined, percent: number, extra: Partial<IndigoPerson> = {}): IndigoPerson =>
  ({ last, first, middle, percent, group: 'Группа INDIGO 1', ...extra });

describe('импорт отчёта INDIGO', () => {
  it('точное ФИО с отчеством и один работающий — «Точно», подразделение сотрудника; оценка и пересдача по порогам', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const ivanov = await s.employee('Семёнов Иван Иванович', 'Отдел тестирования');
      const { pre, applied } = await s.load([p('Семенов', 'Иван', 'Иванович', 89.9), p('Петров', 'Пётр', 'Петрович', 40)]);
      expect(pre.summary.errors).toEqual([]);
      expect(applied.added).toBe(2);
      expect(pre.summary.source).toMatchObject({ adapter: 'indigo', rows: 2, complete: true, matchedExact: 1, unmatched: 1, sameDayRepeats: 0 });
      const [a, b] = await s.results();
      expect(a?.v[s.F(s.res, 'employee').id]).toEqual([ivanov]);
      expect(a?.v[s.F(s.res, 'match').id]).toBe(s.O(s.res, 'match', 'exact').id);
      expect(a?.v[s.F(s.res, 'dept').id]).toBe('Отдел тестирования');
      expect(a?.v[s.F(s.res, 'indigoGroup').id]).toBe('Группа INDIGO 1');
      expect(a?.v[s.F(s.res, 'grade').id]).toBe(s.O(s.res, 'grade', 'good').id);
      expect(a?.v[s.F(s.res, 'retake').id]).toBe(s.O(s.res, 'retake', 'no').id);
      expect(a?.v[s.F(s.res, 'date').id]).toBe('2026-10-01');
      expect(b?.v[s.F(s.res, 'match').id]).toBe(s.O(s.res, 'match', 'none').id);
      expect(b?.v[s.F(s.res, 'dept').id]).toBe('Группа INDIGO 1');
      expect(b?.v[s.F(s.res, 'grade').id]).toBe(s.O(s.res, 'grade', 'fail').id);
      expect(b?.v[s.F(s.res, 'retake').id]).toBe(s.O(s.res, 'retake', 'yes').id);
    }));

  it('однофамильцы, нет отчества, только уволенный — не сопоставляются; причины и кандидаты в блоке', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const twin1 = await s.employee('Иванов Иван Иванович', 'Отдел А');
      const twin2 = await s.employee('Иванов Иван Иванович', 'Отдел Б');
      await s.employee('Петров Пётр Петрович', 'Отдел В', 'fired');
      const buf = await indigoXlsx({ people: [p('Иванов', 'Иван', 'Иванович', 70), p('Сидоров', 'Сергей', undefined, 70), p('Петров', 'Пётр', 'Петрович', 70), p('Кузнецов', 'Кирилл', 'Тестович', 70)] });
      const pre = await excel.previewImport(tx, s.actor, s.res.id, buf, 'отчёт.xlsx', await indigoImportAdapter(tx, s.res.id, buf));
      const rows = must(pre.summary.choices).rows;
      expect(rows.map((r) => [r.title, r.reason])).toEqual([
        ['Иванов Иван Иванович', 'однофамильцы: 2'], ['Сидоров Сергей', 'нет отчества'], ['Петров Пётр Петрович', 'найден только уволенный'], ['Кузнецов Кирилл Тестович', 'не найден'],
      ]);
      expect(rows[0]?.candidates.map((c) => c.id).sort()).toEqual([twin1, twin2].sort());
      expect(rows[2]?.candidates).toEqual([]);
      // Ручной выбор: однофамилец — «Вручную», подразделение выбранного.
      await excel.applyImport(tx, s.actor, pre.id, { choices: { [String(rows[0]?.row)]: twin2 } });
      const [a] = await s.results();
      expect(a?.v[s.F(s.res, 'employee').id]).toEqual([twin2]);
      expect(a?.v[s.F(s.res, 'match').id]).toBe(s.O(s.res, 'match', 'manual').id);
      expect(a?.v[s.F(s.res, 'dept').id]).toBe('Отдел Б');
    }));

  it('повторный импорт того же отчёта ничего не меняет — и после ручного сопоставления и смены порогов', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const e = await s.employee('Иванов Иван Иванович', 'Отдел А');
      await s.employee('Иванов Иван Иванович', 'Отдел Б');
      const people = [p('Иванов', 'Иван', 'Иванович', 75), p('Петров', 'Пётр', 'Петрович', 45)];
      const first = await s.load(people);
      const row = must(first.pre.summary.choices).rows[0]?.row;
      expect(row).toBeDefined();
      // Ручное сопоставление уже после загрузки — в карточке.
      const [rec] = await s.results();
      await records.updateRecord(tx, s.actor, must(rec).id, { version: must(rec).version, values: { [s.F(s.res, 'employee').id]: [e] } });
      await tx.appSetting.update({ where: { key: AWARENESS_GRADES_KEY }, data: { value: { excellent: 95, good: 80, satisfactory: 60, retakeBelow: 60 } } });
      const before = await s.results();
      const again = await s.load(people);
      expect([again.pre.summary.added, again.pre.summary.updated, again.pre.summary.unchanged]).toEqual([0, 0, 2]);
      expect(await s.results()).toEqual(before);
    }));

  it('смена порогов меняет оценку у новых импортов; пересдача — по своему порогу', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await tx.appSetting.update({ where: { key: AWARENESS_GRADES_KEY }, data: { value: { excellent: 95, good: 80, satisfactory: 60, retakeBelow: 75 } } });
      await s.load([p('Иванов', 'Иван', 'Иванович', 74)]);
      const [a] = await s.results();
      expect(a?.v[s.F(s.res, 'grade').id]).toBe(s.O(s.res, 'grade', 'satisfactory').id);
      expect(a?.v[s.F(s.res, 'retake').id]).toBe(s.O(s.res, 'retake', 'yes').id);
    }));

  it('повторы в один день — загружена лучшая, при равном — первая; другой день — отдельная запись', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const { pre } = await s.load([
        p('Иванов', 'Иван', 'Иванович', 40), p('Иванов', 'Иван', 'Иванович', 90), p('ИВАНОВ', 'Иван', 'Иванович', 90),
        p('Иванов', 'Иван', 'Иванович', 30, { date: '02.10.2026' }),
      ]);
      expect(pre.summary.source).toMatchObject({ sameDayRepeats: 2 });
      expect(pre.summary.blocks?.find((b) => b.code === 'indigo_repeats')?.items).toEqual([
        'строка 12: Иванов Иван Иванович, 40% — загружена строка 13 с 90%',
        'строка 14: ИВАНОВ Иван Иванович, 90% — загружена строка 13 с 90%',
      ]);
      const recs = await s.results();
      expect(recs.map((r) => [r.v[s.F(s.res, 'date').id], r.v[s.F(s.res, 'percent').id]])).toEqual([['2026-10-01', 90], ['2026-10-02', 30]]);
    }));

  it('ошибки строк — номером строки отчёта, остальные загружаются; пустые «Сотрудники» — подсказка', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const { pre, applied } = await s.load([p('Иванов', 'Иван', 'Иванович', 70), p('Петров', 'Пётр', 'Петрович', 70, { date: '31.02.2026' })]);
      expect(applied.added).toBe(1);
      expect(pre.summary.errorRows).toBe(1);
      expect(pre.summary.errors.every((e) => e.row === 13)).toBe(true);
      expect(pre.summary.blocks?.find((b) => b.code === 'indigo_errors')?.items).toEqual(['строка 13: Петров Пётр Петрович — Дата «31.02.2026» не распознана']);
      expect(pre.summary.warnings).toContain('Реестр «Сотрудники» пуст — сначала загрузите выгрузку HR, иначе все результаты будут без связи');
    }));

  it('результат уволенного остаётся и показывается с меткой «(уволен)»', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const e = await s.employee('Иванов Иван Иванович', 'Отдел А');
      await s.load([p('Иванов', 'Иван', 'Иванович', 70)]);
      const cur = await tx.registerRecord.findUniqueOrThrow({ where: { id: e } });
      await records.updateRecord(tx, s.actor, e, { version: cur.version, values: { [s.F(s.emp, 'status').id]: s.O(s.emp, 'status', 'fired').id } });
      const [r] = await s.results();
      const dto = await records.getRecord(tx, must(r).id);
      expect(dto.display[s.F(s.res, 'employee').id]).toMatch(/^#\d+ Иванов Иван Иванович \(уволен\)$/);
    }));

  it('адаптер не к своему реестру — 409; двоичный .xls — 400 OLD_EXCEL_FORMAT', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const buf = await indigoXlsx({ people: [p('Иванов', 'Иван', 'Иванович', 70)] });
      await expectCode(indigoImportAdapter(tx, s.emp.id, buf), 'WRONG_ADAPTER');
      await expectCode(indigoImportAdapter(tx, s.res.id, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), 'OLD_EXCEL_FORMAT');
      await expectCode(indigoImportAdapter(tx, s.res.id, Buffer.from('просто текст')), 'BAD_FILE');
    }));

  it('маршрут ?adapter=indigo: records.edit; без права — 403; выбор передаётся при применении', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash: await argon2Hasher.hash(PASSWORD) });
      const e = await s.employee('Иванов Иван Иванович', 'Отдел А');
      await s.employee('Иванов Иван Иванович', 'Отдел Б');
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: false });
      const login = async (name: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const body = await indigoXlsx({ people: [p('Иванов', 'Иван', 'Иванович', 70)] });
      const upload = (cookie: string) => app.inject({
        method: 'POST', url: `/api/v1/registers/${s.res.id}/imports?adapter=indigo`, payload: body,
        headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('отчёт.xlsx'), origin: TEST_PORTAL_URL },
      });
      expect((await upload(await login(reader.login))).statusCode).toBe(403);
      const S = await login(s.user.login);
      const pre = await upload(S);
      expect(pre.statusCode).toBe(201);
      const preview = pre.json<{ id: string; summary: { choices: { rows: { row: number }[] } } }>();
      const row = must(preview.summary.choices.rows[0]).row;
      const applied = await app.inject({ method: 'POST', url: `/api/v1/register-imports/${preview.id}/apply`, payload: { choices: { [row]: e } }, headers: { cookie: S, origin: TEST_PORTAL_URL } });
      expect(applied.statusCode).toBe(200);
      const [r] = await s.results();
      expect(r?.v[s.F(s.res, 'employee').id]).toEqual([e]);
    }));
});
