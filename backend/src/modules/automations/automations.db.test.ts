import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import type { Values } from '../../lib/register-values.js';
import { TEST_SECRET } from '../../test/helpers.js';
import { expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { makeRegister } from '../../test/registers-fixture.js';
import { SAMPLE, SAMPLE_NAME, sampleBook, toBuffer, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as excel from '../registers/excel.service.js';
import * as records from '../registers/records.service.js';
import { XLSX_TYPE } from '../registers/routes.js';
import * as svc from './service.js';

/** 01.12.2026, 11:00 по Душанбе — вторник. */
const DEC_1 = new Date('2026-12-01T06:00:00Z');
const DEC_2 = new Date('2026-12-02T06:00:00Z');

async function vuln(tx: Tx, x: VulnFixture, cve: string, notified: string, crit: string, extra: Values = {}) {
  return records.createRecord(tx, x.actor, x.reg.id, {
    values: { [x.vf.cve.id]: cve, [x.vf.notified.id]: notified, [x.vf.crit.id]: x.opt('crit', crit), ...extra },
  });
}

async function eventsOf(tx: Tx, x: VulnFixture) {
  const rows = await tx.automationEvent.findMany({
    where: { registerId: x.reg.id },
    include: { automation: { select: { systemKey: true } }, record: { select: { values: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((e) => ({
    cve: (e.record.values as Values)[x.vf.cve.id],
    rule: e.automation.systemKey,
    key: e.triggerKey,
    type: e.eventType,
    recipients: e.recipients,
    id: e.id,
  }));
}

const pick = (list: Awaited<ReturnType<typeof eventsOf>>) => list.map((e) => `${String(e.cve)}:${e.rule}:${e.key}`).sort();

describe('правила п. 7.4 по расписанию', () => {
  it('просрочка → уведомить ДИКТ и владельца; 10 рабочих дней без мер → эскалация; повторный прогон дублей не создаёт', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Фарход Ответственный' });
      await vuln(tx, x, 'A', '2026-10-01', 'critical'); // срок 15.10 — давно просрочен
      await vuln(tx, x, 'B', '2026-10-01', 'critical', { [x.vf.measures.id]: 'Порт закрыт на МСЭ' }); // меры есть — без эскалации
      await vuln(tx, x, 'C', '2026-10-01', 'critical', { [x.vf.status.id]: x.opt('status', 'fixed') }); // закрыта
      await vuln(tx, x, 'D', '2026-11-16', 'critical'); // срок 30.11 — просрочен на 1 день
      await vuln(tx, x, 'E', '2026-11-03', 'high', { [x.vf.owner.id]: owner.id }); // срок 03.12 — через 2 дня
      // Срок в день праздника: 23.10 + 14 = 06.11 (День Конституции) → 07–08 выходные → 09.11.
      const f = await vuln(tx, x, 'F', '2026-10-23', 'critical');
      expect(f.calc[x.vf.due.id]).toBe('2026-11-09');
      // Срок 18.11: к 01.12 прошло 9 рабочих дней, к 02.12 — 10.
      await vuln(tx, x, 'G', '2026-11-04', 'critical');

      const first = await svc.runAutomations(tx, { now: DEC_1, registerId: x.reg.id });
      expect(first).toMatchObject({ ran: true, today: '2026-12-01', rules: 3, checked: 6, created: 8 });
      expect(pick(await eventsOf(tx, x))).toEqual([
        'A:vuln.overdue_escalate:2026-10-15', 'A:vuln.overdue_notify:2026-10-15',
        'B:vuln.overdue_notify:2026-10-15',
        'D:vuln.overdue_notify:2026-11-30',
        'E:vuln.remind_before_due:2026-12-03',
        'F:vuln.overdue_escalate:2026-11-09', 'F:vuln.overdue_notify:2026-11-09',
        'G:vuln.overdue_notify:2026-11-18',
      ]);
      const events = await eventsOf(tx, x);
      expect(events.find((e) => e.cve === 'A' && e.rule === 'vuln.overdue_notify')?.recipients).toEqual([
        { kind: 'label', label: 'Руководитель ДИКТ' }, { kind: 'label', label: 'Владелец системы' },
      ]);
      expect(events.find((e) => e.cve === 'E')?.recipients).toEqual([
        { kind: 'user', userId: owner.id, name: 'Фарход Ответственный' }, { kind: 'label', label: 'Руководитель ДИКТ' },
      ]);

      // Повторный прогон в тот же день (через час, после перезапуска) — ничего нового.
      expect((await svc.runAutomations(tx, { now: DEC_1, registerId: x.reg.id })).created).toBe(0);
      expect((await svc.runAutomations(tx, { now: DEC_1 })).created).toBe(0);
      // На следующий день: у G наступил 10-й рабочий день — только его эскалация.
      expect((await svc.runAutomations(tx, { now: DEC_2, registerId: x.reg.id })).created).toBe(1);
      expect(pick(await eventsOf(tx, x))).toContain('G:vuln.overdue_escalate:2026-11-18');
      expect(await tx.automationEvent.count({ where: { registerId: x.reg.id } })).toBe(9);
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: 'automation.run' }, orderBy: { id: 'desc' } })).userId).toBeNull();
    }));

  it('перенос срока даёт новое событие; выключенное правило молчит; событие отмечается обработанным', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const a = await vuln(tx, x, 'A', '2026-10-01', 'critical');
      await svc.runAutomations(tx, { now: DEC_1, registerId: x.reg.id });
      expect(await tx.automationEvent.count({ where: { recordId: a.id } })).toBe(2);
      // П. 7.3: меры и новый срок ИБ — срок сдвинулся на 20.11, эскалации по мерам больше нет.
      const upd = await records.updateRecord(tx, x.actor, a.id, {
        version: a.version, values: { [x.vf.measures.id]: 'Временное правило WAF', [x.vf.newDue.id]: '2026-11-20' },
      });
      expect(upd.calc[x.vf.due.id]).toBe('2026-11-20');
      expect((await svc.runAutomations(tx, { now: DEC_1, registerId: x.reg.id })).created).toBe(1);
      expect(pick(await eventsOf(tx, x))).toEqual(['A:vuln.overdue_escalate:2026-10-15', 'A:vuln.overdue_notify:2026-10-15', 'A:vuln.overdue_notify:2026-11-20']);

      // Выключенное правило не создаёт событий.
      const remind = await tx.registerAutomation.findFirstOrThrow({ where: { registerId: x.reg.id, systemKey: 'vuln.remind_before_due' } });
      await svc.updateRule(tx, x.actor, remind.id, { version: remind.version, enabled: false });
      await vuln(tx, x, 'SOON', '2026-11-03', 'high'); // срок 03.12
      expect((await svc.runAutomations(tx, { now: DEC_1, registerId: x.reg.id })).created).toBe(0);

      // Обработано: статус, кто, история записи.
      const list = await svc.listEvents(tx, x.reg.id, { status: 'new', recordId: a.id, limit: 10 });
      expect(list.total).toBe(3);
      expect(list.items[0]).toMatchObject({ recordNumber: a.number, recordTitle: 'A', status: 'new' });
      await svc.processEvent(tx, x.actor, must(list.items[0]).id);
      await svc.processEvent(tx, x.actor, must(list.items[0]).id); // повторно — без ошибки и без второй записи в журнале
      expect((await svc.listEvents(tx, x.reg.id, { status: 'new', recordId: a.id, limit: 10 })).total).toBe(2);
      const done = must((await svc.listEvents(tx, x.reg.id, { status: 'processed', limit: 10 })).items[0]);
      expect([done.status, done.processedBy !== null]).toEqual(['processed', true]);
      const history = await records.recordHistory(tx, a.id);
      expect(history.filter((h) => h.action === 'automation_event.processed')).toHaveLength(1);
      expect((await records.getRecord(tx, a.id)).openEvents).toBe(2);
      // Фильтр «С событиями»: SOON без событий (правило выключено) не попадает.
      const withEvents = await records.listRecords(tx, x.reg.id, { limit: 10, withEvents: true });
      expect(withEvents.items.map((r) => r.values[x.vf.cve.id])).toEqual(['A']);
      // Запись в архиве: из журнала реестра её события уходят, в карточке остаются.
      const fresh = await records.getRecord(tx, a.id);
      await records.setRecordArchived(tx, x.actor, a.id, fresh.version, true);
      expect((await svc.listEvents(tx, x.reg.id, { limit: 10 })).total).toBe(0);
      expect((await svc.listEvents(tx, x.reg.id, { recordId: a.id, limit: 10 })).total).toBe(3);
    }));
});

describe('правила любого реестра', () => {
  it('«поле = значение»; проверка правила; системные правила только выключаются; правило с событиями — только в архив', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Нигина Получатель' });
      const rule = await svc.createRule(tx, x.actor, x.reg.id, {
        condition: { kind: 'equals', fieldId: x.f.status, optionId: x.opt('status', 'В работе') },
        action: { eventType: 'notify', recipients: [{ kind: 'field', fieldId: x.f.owner }, { kind: 'label', label: '  Начальник   ИБ ' }] },
      });
      expect([rule.when, rule.then]).toEqual(['«Статус» = «В работе»', 'Уведомить: Ответственный, Начальник ИБ']);
      const r1 = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Первая', [x.f.status]: x.opt('status', 'В работе'), [x.f.owner]: owner.id } });
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Вторая' } });
      expect((await svc.runAutomations(tx, { now: DEC_1, registerId: x.reg.id })).created).toBe(1);
      const [e] = (await svc.listEvents(tx, x.reg.id, { limit: 10 })).items;
      expect(e).toMatchObject({ recordId: r1.id, eventType: 'notify', recipients: [{ kind: 'user', name: 'Нигина Получатель' }, { kind: 'label', label: 'Начальник ИБ' }] });

      // Проверка: условие по полю не того типа, получатель — не сотрудник.
      await expectCode(svc.createRule(tx, x.actor, x.reg.id, {
        condition: { kind: 'before', fieldId: x.f.title, days: 3 }, action: { eventType: 'remind', recipients: [{ kind: 'label', label: 'ДИКТ' }] },
      }), 'BAD_RULE');
      await expectCode(svc.createRule(tx, x.actor, x.reg.id, {
        condition: { kind: 'overdue', fieldId: x.f.due, workdays: 10 }, action: { eventType: 'escalate', recipients: [{ kind: 'field', fieldId: x.f.title }] },
      }), 'BAD_RULE');
      const ok = await svc.createRule(tx, x.actor, x.reg.id, {
        condition: { kind: 'overdue', fieldId: x.f.due, workdays: 10, unlessFilledFieldId: x.f.score },
        action: { eventType: 'escalate', recipients: [{ kind: 'label', label: 'Руководство' }] },
      });
      expect(ok.when).toBe('«Срок устранения» просрочен на 10 раб. дн. и пусто «Баллы»');
      await svc.deleteRule(tx, x.actor, ok.id, ok.version);

      // С событиями правило не удаляется — только архив.
      await expectCode(svc.deleteRule(tx, x.actor, rule.id, rule.version), 'HAS_EVENTS');
      const archived = await svc.setRuleArchived(tx, x.actor, rule.id, rule.version, true);
      expect(archived.archived).toBe(true);
      expect(await svc.listRules(tx, x.reg.id, { includeArchived: false })).toHaveLength(0);

      // Системные правила реестра уязвимостей.
      const v = await vulnRegister(tx);
      const sys = await tx.registerAutomation.findFirstOrThrow({ where: { registerId: v.reg.id, systemKey: 'vuln.overdue_notify' } });
      await expectCode(svc.updateRule(tx, v.actor, sys.id, {
        version: sys.version, condition: { kind: 'overdue', fieldId: v.vf.due.id, workdays: 1 },
      }), 'SYSTEM_RULE');
      await expectCode(svc.setRuleArchived(tx, v.actor, sys.id, sys.version, true), 'SYSTEM_RULE');
      await expectCode(svc.deleteRule(tx, v.actor, sys.id, sys.version), 'SYSTEM_RULE');
      expect((await svc.updateRule(tx, v.actor, sys.id, { version: sys.version, enabled: false })).enabled).toBe(false);
    }));
});

describe('автоматизации и отчёт сканера по HTTP', () => {
  it('сотрудник ИБ: загрузка отчёта и события — да, правила — нет; без ib.work — ничего', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Http-Vuln-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const x = await vulnRegister(tx);
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const lawyer = await makeUser(tx, ['legal'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const [A, S, L] = [await login(admin.login), await login(staff.login), await login(lawyer.login)];
      const base = `/api/v1/registers/${x.reg.id}`;

      const up = await app.inject({
        method: 'POST', url: `${base}/scan-imports`, body: SAMPLE,
        headers: { cookie: S, 'content-type': XLSX_TYPE, 'x-file-name': encodeURIComponent(SAMPLE_NAME) },
      });
      expect(up.statusCode).toBe(201);
      const preview = up.json() as { id: string; summary: { created: number; reportDate: string } };
      expect([preview.summary.created, preview.summary.reportDate]).toEqual([90, '2026-10-15']);
      expect((await app.inject({ url: `/api/v1/scan-imports/${preview.id}`, headers: { cookie: S } })).statusCode).toBe(200);
      const applied = await app.inject({ method: 'POST', url: `/api/v1/scan-imports/${preview.id}/apply`, headers: { cookie: S }, payload: {} });
      expect(applied.statusCode).toBe(200);
      // Сроки отчёта 15.10 подходят (29.10) или уже прошли — события появились сразу после применения, без ожидания часа.
      const events = await app.inject({ url: `${base}/automation-events?status=new&limit=5`, headers: { cookie: S } });
      expect(events.statusCode).toBe(200);
      expect((events.json() as { total: number }).total).toBeGreaterThan(0);
      const ev = must((events.json() as { items: { id: string }[] }).items[0]);
      expect((await app.inject({ method: 'POST', url: `/api/v1/automation-events/${ev.id}/process`, headers: { cookie: S } })).statusCode).toBe(204);
      const reports = await app.inject({ url: `${base}/scan-reports`, headers: { cookie: S } });
      expect((reports.json() as { items: { hostsCount: number }[] }).items[0]?.hostsCount).toBe(12);
      const recs = await app.inject({ url: `${base}/records?sort=deadline&limit=1`, headers: { cookie: S } });
      // Срочное — первым: самый ранний срок отчёта 15.10 — критические, 15.10 + 14 = 29.10.
      expect((recs.json() as { items: { deadline: { date: string; state: string } }[] }).items[0]?.deadline).toMatchObject({ date: '2026-10-29' });

      const rule = { condition: { kind: 'before', fieldId: x.vf.due.id, days: 7 }, action: { eventType: 'remind', recipients: [{ kind: 'label', label: 'ДИКТ' }] } };
      expect((await app.inject({ url: `${base}/automations`, headers: { cookie: S } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `${base}/automations`, headers: { cookie: S }, payload: rule })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `${base}/automations/run`, headers: { cookie: S } })).statusCode).toBe(403);
      const created = await app.inject({ method: 'POST', url: `${base}/automations`, headers: { cookie: A }, payload: rule });
      expect(created.statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: `${base}/automations/run`, headers: { cookie: A } })).json()).toMatchObject({ ran: true });

      expect((await app.inject({ url: `${base}/automations`, headers: { cookie: L } })).statusCode).toBe(403);
      expect((await app.inject({ url: `${base}/automation-events`, headers: { cookie: L } })).statusCode).toBe(403);
      expect((await app.inject({ url: `${base}/scan-reports`, headers: { cookie: L } })).statusCode).toBe(403);
    }));
});

describe('одна кнопка «Импорт из Excel»', () => {
  it('отчёт сканера и выгрузка реестра распознаются сами; неизвестный файл — ошибка с найденными листами и колонками', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Http-Auto-Pass-2026';
      const x = await vulnRegister(tx);
      const other = await makeRegister(tx);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: await argon2Hasher.hash(PASSWORD) });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET });
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: staff.login, password: PASSWORD } });
      const cookie = `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      const upload = (registerId: string, body: Buffer, name: string) => app.inject({
        method: 'POST', url: `/api/v1/registers/${registerId}/file-imports`, body,
        headers: { cookie, 'content-type': XLSX_TYPE, 'x-file-name': encodeURIComponent(name) },
      });

      // Отчёт сканера без даты в имени: предпросмотр есть, применить без даты нельзя.
      const s = await upload(x.reg.id, SAMPLE, 'отчёт сканера.xlsx');
      expect(s.statusCode).toBe(201);
      const scanPrev = s.json() as { format: string; scan: { id: string; summary: { created: number; reportDate: string | null } } };
      expect([scanPrev.format, scanPrev.scan.summary.created, scanPrev.scan.summary.reportDate]).toEqual(['scan', 90, null]);
      const noDate = await app.inject({ method: 'POST', url: `/api/v1/scan-imports/${scanPrev.scan.id}/apply`, headers: { cookie }, payload: {} });
      expect([noDate.statusCode, (noDate.json() as { error: { code: string } }).error.code]).toEqual([400, 'REPORT_DATE_REQUIRED']);

      // Выгрузка того же реестра — обычный импорт по колонке ID.
      const exported = await excel.exportRegister(tx, x.reg.id);
      const r = await upload(x.reg.id, exported.buffer, exported.fileName);
      expect(r.statusCode).toBe(201);
      expect((r.json() as { format: string; records: { summary: unknown } }).format).toBe('records');

      // Отчёт сканера в обычный реестр — понятный отказ.
      const wrong = await upload(other.reg.id, SAMPLE, SAMPLE_NAME);
      expect((wrong.json() as { error: { code: string } }).error.code).toBe('NOT_VULN_REGISTER');

      // Без листа «Хосты» это уже не отчёт сканера и не выгрузка.
      const book = await sampleBook();
      book.removeWorksheet(must(book.worksheets.find((w) => w.name === 'Хосты')).id);
      const noHosts = await upload(x.reg.id, await toBuffer(book), SAMPLE_NAME);
      expect((noHosts.json() as { error: { code: string } }).error.code).toBe('UNKNOWN_FORMAT');

      const plain = new ExcelJS.Workbook();
      plain.addWorksheet('Лист1').addRow(['Имя', 'Дата', 'Сумма']);
      const unknown = await upload(x.reg.id, await toBuffer(plain), 'что-то.xlsx');
      expect(unknown.statusCode).toBe(400);
      const err = (unknown.json() as { error: { code: string; message: string } }).error;
      expect(err.code).toBe('UNKNOWN_FORMAT');
      expect(err.message).toContain('лист «Хосты» и лист с колонками «CVE» и «Пакет»');
      expect(err.message).toContain('колонка «ID» или скрытый лист «_поля»');
      expect(err.message).toContain('«Лист1»: «Имя», «Дата», «Сумма»');
    }));
});

describe('расписание внутри backend', () => {
  it('прогон при старте; остановка дожидается идущего прогона; без интервала — выключено', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      await vuln(tx, x, 'OLD', '2026-01-10', 'critical'); // давно просрочена
      const deps = { db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET };
      const off = await buildApp(deps);
      await off.ready();
      await off.close();
      expect(await tx.automationEvent.count({ where: { registerId: x.reg.id } })).toBe(0);
      const on = await buildApp({ ...deps, automationIntervalMin: 60 });
      await on.ready();
      await on.close();
      expect(await tx.automationEvent.count({ where: { registerId: x.reg.id } })).toBe(2); // уведомление + эскалация
      // Второй старт (перезапуск контейнера) — дублей нет.
      const again = await buildApp({ ...deps, automationIntervalMin: 60 });
      await again.ready();
      await again.close();
      expect(await tx.automationEvent.count({ where: { registerId: x.reg.id } })).toBe(2);
    }));
});
