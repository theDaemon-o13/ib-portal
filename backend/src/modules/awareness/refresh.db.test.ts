// «Обновить по сотрудникам» (релиз 1.8.0, docs/specs/awareness.md, раздел 5). Люди вымышленные. Каждый тест — в транзакции.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import type { Values } from '../../lib/register-values.js';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { loadRegister, type RegisterDef } from '../registers/definition.js';
import * as records from '../registers/records.service.js';
import { AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY } from './definition.js';
import { applyRefresh, previewRefresh } from './refresh.service.js';

const PASSWORD = 'Refresh-Test-Pass-2026';

async function setup(tx: Tx) {
  const user = await makeUser(tx, ['ib_staff'], { passwordHash: await argon2Hasher.hash(PASSWORD) });
  const actor = await actorFor(tx, user.id);
  const reg = async (key: string) => loadRegister(tx, must(await tx.register.findUnique({ where: { systemKey: key } })).id);
  const emp = await reg(AWARENESS_EMPLOYEES_KEY);
  const res = await reg(AWARENESS_RESULTS_KEY);
  const F = (r: RegisterDef, k: string) => must(r.fields.find((f) => f.systemKey === k), k).id;
  const O = (r: RegisterDef, k: string, key: string) => must(r.fields.find((f) => f.systemKey === k)?.options.find((o) => o.systemKey === key), key).id;
  const employee = async (fio: string, dept: string, status: 'working' | 'fired' = 'working') => (await records.createRecord(tx, actor, emp.id, {
    values: { [F(emp, 'fullName')]: fio, [F(emp, 'dept')]: dept, [F(emp, 'status')]: O(emp, 'status', status) },
  })).id;
  const result = async (fio: string, match: 'exact' | 'manual' | 'none', extra: Values = {}) => {
    const number = await records.nextNumbers(tx, res.id, 1);
    return (await tx.registerRecord.create({
      data: {
        registerId: res.id, number,
        values: { [F(res, 'attemptKey')]: `т | ${fio} | ${number}`, [F(res, 'fullName')]: fio, [F(res, 'test')]: 'Тест', [F(res, 'date')]: '2026-10-01', [F(res, 'dept')]: 'Группа INDIGO', [F(res, 'match')]: O(res, 'match', match), ...extra },
      },
    })).id;
  };
  const values = async (id: string) => (await tx.registerRecord.findUniqueOrThrow({ where: { id } })).values as Values;
  return { user, actor, emp, res, F, O, employee, result, values };
}

describe('«Обновить по сотрудникам»', () => {
  it('предлагает только «Не сопоставлен» с полным ФИО и одним работающим; «было → станет» по подразделению', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const ivanov = await s.employee('Иванов Иван Иванович', 'Отдел тестирования');
      await s.employee('Петров Пётр Петрович', 'Отдел А');
      await s.employee('Петров Пётр Петрович', 'Отдел Б');
      await s.employee('Сидоров Сергей Сергеевич', 'Отдел В', 'fired');
      const a = await s.result('Иванов Иван Иванович', 'none');
      await s.result('Иванов Иван Иванович', 'exact');
      await s.result('Иванов Иван Иванович', 'manual');
      await s.result('Иванов Иван', 'none');
      await s.result('Петров Пётр Петрович', 'none');
      await s.result('Сидоров Сергей Сергеевич', 'none');
      const p = await previewRefresh(tx, s.res.id);
      expect(p.total).toBe(1);
      expect(p.items[0]).toMatchObject({ recordId: a, fio: 'Иванов Иван Иванович', employee: { id: ivanov }, deptFrom: 'Группа INDIGO', deptTo: 'Отдел тестирования' });
    }));

  it('отмеченные — связь, «Точно», подразделение; снятые не меняются; журнал', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const ivanov = await s.employee('Иванов Иван Иванович', 'Отдел тестирования');
      await s.employee('Кузнецов Кирилл Тестович', 'Отдел проверки');
      const a = await s.result('Иванов Иван Иванович', 'none');
      const b = await s.result('Кузнецов Кирилл Тестович', 'none');
      const p = await previewRefresh(tx, s.res.id);
      expect(p.total).toBe(2);
      const r = await applyRefresh(tx, s.actor, s.res.id, { recordIds: [a], expected: 2 });
      expect(r).toEqual({ updated: 1, skipped: 1 });
      const va = await s.values(a);
      expect(va[s.F(s.res, 'employee')]).toEqual([ivanov]);
      expect(va[s.F(s.res, 'match')]).toBe(s.O(s.res, 'match', 'exact'));
      expect(va[s.F(s.res, 'dept')]).toBe('Отдел тестирования');
      expect((await s.values(b))[s.F(s.res, 'match')]).toBe(s.O(s.res, 'match', 'none'));
      const log = await tx.auditLog.findFirst({ where: { entity: 'register_record', entityId: a }, orderBy: { at: 'desc' } });
      expect(log?.diff).toMatchObject({ after: { via: 'awareness_refresh' } });
      expect(await tx.auditLog.count({ where: { action: 'awareness.refresh.applied', entityId: s.res.id } })).toBe(1);
      // Повтор — предлагать больше нечего, кроме снятой.
      expect((await previewRefresh(tx, s.res.id)).items.map((i) => i.recordId)).toEqual([b]);
    }));

  it('изменилось после предпросмотра — 409 BULK_CHANGED, ничего не меняется', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await s.employee('Иванов Иван Иванович', 'Отдел тестирования');
      const a = await s.result('Иванов Иван Иванович', 'none');
      const p = await previewRefresh(tx, s.res.id);
      await expectCode(applyRefresh(tx, s.actor, s.res.id, { recordIds: [a], expected: p.total + 1 }), 'BULK_CHANGED');
      // Появился однофамилец — запись больше не сопоставляется «Точно».
      await s.employee('Иванов Иван Иванович', 'Отдел Б');
      await expectCode(applyRefresh(tx, s.actor, s.res.id, { recordIds: [a], expected: p.total }), 'BULK_CHANGED');
      expect((await s.values(a))[s.F(s.res, 'match')]).toBe(s.O(s.res, 'match', 'none'));
    }));

  it('чужой реестр — 409; маршрут — records.edit, без права 403', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      await expectCode(previewRefresh(tx, s.emp.id), 'WRONG_REGISTER');
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash: await argon2Hasher.hash(PASSWORD) });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: false });
      const login = async (name: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const url = `/api/v1/registers/${s.res.id}/awareness/refresh/preview`;
      expect((await app.inject({ method: 'POST', url, headers: { cookie: await login(reader.login), origin: TEST_PORTAL_URL } })).statusCode).toBe(403);
      const ok = await app.inject({ method: 'POST', url, headers: { cookie: await login(s.user.login), origin: TEST_PORTAL_URL } });
      expect([ok.statusCode, ok.json<{ total: number }>().total]).toEqual([200, 0]);
    }));
});
