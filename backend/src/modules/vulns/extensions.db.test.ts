// Шаг 5 релиза 1.5.0 (ADR-0030; CLAUDE.md, раздел 7, правило 14): продления сроков по обоснованию ОИКТ.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { buildApp } from '../../app.js';
import { PERMISSION_CODES, SYSTEM_ROLES } from '../../lib/permissions.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { addDays, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { SAMPLE, SAMPLE_NAME, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { computeKpis } from '../dashboard/service.js';
import { getFileMeta, uploadFile } from '../files/service.js';
import { vulnsBlock } from '../monitor/service.js';
import * as records from '../registers/records.service.js';
import * as ext from './extensions.service.js';
import * as groups from './groups.service.js';
import * as scan from './scan-import.service.js';
import * as scans from './scans.service.js';
import * as section from './section.service.js';

const root = mkdtempSync(join(tmpdir(), 'ibportal-ext-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CVE = 'CVE-2024-21413'; // Критическая, Уровень «Важная»

async function setup(tx: Tx, opts: { handover?: string | null; types?: string[]; scanDate?: string } = {}) {
  const x = await vulnRegister(tx);
  const types = await tx.catalogItem.findMany({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: { in: opts.types ?? ['Windows'] } } });
  const g = await groups.createGroup(tx, x.actor, { name: unique('Отдел карт'), kind: 'department', systemTypeIds: types.map((t) => t.id) });
  const node = must(g.nodes[0]);
  const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
  const applied = await scan.applyNodeScan(tx, x.actor, p.id, { profileConfirmed: true, scanDate: opts.scanDate });
  await x.reload();
  if (opts.handover !== null) await scans.handOverScan(tx, x.actor, applied.scanId, { date: opts.handover ?? '2026-10-15' });
  const file = await uploadFile(tx, store, x.actor, 'обращение ОИКТ.txt', Buffer.from('обоснование'));
  const levelId = (label: string) => must(x.vf.level.options.find((o) => o.label === label)).id;
  return { x, node, group: g, scanId: applied.scanId, file, levelId };
}

async function rec(tx: Tx, x: VulnFixture, nodeId: string, cve: string) {
  const rows = await tx.vulnRecord.findMany({ where: { nodeId, keyNorm: { not: null } }, include: { record: true } });
  return records.getRecord(tx, must(rows.find((v) => (v.record.values as Values)[x.vf.cve.id] === cve), cve).recordId);
}

/**
 * Передача с запасом: Критическая (14 дн.) просрочена, Высокая (30 дн.) ещё нет — в любой день недели.
 * Окончание на выходном переносится вперёд: с «сегодня − 15» срок в понедельник и в воскресенье попадал на сегодня, просрочки не было.
 */
const HANDED_OVER = () => addDays(todayIso(), -20);

const basis = (fileId: string) => ({ basisNumber: '№ 42/ОИКТ', basisDate: '2026-10-28', basisFileId: fileId });

describe('продления сроков', () => {
  it('право vulns.deadlines есть в матрице, но ни в одной системной роли, в том числе у супер-администратора', () => {
    expect(PERMISSION_CODES).toContain('vulns.deadlines');
    for (const r of SYSTEM_ROLES) expect((r.permissions as readonly string[]).includes('vulns.deadlines'), r.code).toBe(false);
  });

  it('предпросмотр: уровни области, было → станет, ничего не меняет; применение: «Продлено, дн.», итоговый срок, история, журнал', () =>
    inTx(async (tx) => {
      const { x, node, file, levelId } = await setup(tx);
      const before = await rec(tx, x, node.id, CVE);
      expect(before.calc[x.vf.due.id]).toBe('2026-10-29');

      const empty = await ext.previewExtension(tx, { nodeId: node.id, daysByLevel: {} });
      expect(empty.items).toEqual([]);
      expect(empty.levels.map((l) => l.label)).toContain('Важная');
      expect(empty.levels.reduce((n, l) => n + l.count, 0)).toBe(90);

      const important = levelId('Важная');
      const plan = { nodeId: node.id, daysByLevel: { [important]: 30 } };
      const p = await ext.previewExtension(tx, plan);
      const item = must(p.items.find((i) => i.cve === CVE));
      expect(item).toMatchObject({ days: 30, dueBefore: '2026-10-29', dueAfter: '2026-11-30', level: 'Важная' }); // 28.11 — суббота → понедельник
      expect(p.items.every((i) => i.level === 'Важная')).toBe(true);
      expect((await rec(tx, x, node.id, CVE)).version).toBe(before.version);

      await expectCode(ext.applyExtension(tx, x.actor, { ...plan, ...basis(file.id), basisNumber: '  ', expected: p.items.length }), 'BASIS_REQUIRED');
      await expectCode(ext.applyExtension(tx, x.actor, { ...plan, ...basis(file.id), basisDate: addDays(todayIso(), 1), expected: p.items.length }), 'BAD_DATE');
      await expectCode(ext.applyExtension(tx, x.actor, { ...plan, ...basis(x.adminId), expected: p.items.length }), 'FILE_NOT_FOUND');
      await expectCode(ext.applyExtension(tx, x.actor, { ...plan, ...basis(file.id), expected: p.items.length + 1 }), 'BULK_CHANGED');
      const done = await ext.applyExtension(tx, x.actor, { ...plan, ...basis(file.id), comment: 'Ждём обновление', expected: p.items.length });
      expect(done.records).toBe(p.items.length);

      const after = await rec(tx, x, node.id, CVE);
      expect([after.values[x.vf.extDays.id], after.calc[x.vf.due.id], after.version]).toEqual([30, '2026-11-30', before.version + 1]);
      const h = must((await records.recordHistory(tx, after.id))[0]);
      expect(h.summary).toContain('срок продлён на 30 дн. (29.10.2026 → 30.11.2026) по обоснованию ОИКТ № № 42/ОИКТ от 28.10.2026');
      expect((await lastAudit(tx)).action).toBe('vuln.extension.applied');
      expect((await getFileMeta(tx, x.actor, file.id)).refs.map((r) => r.kind)).toEqual(['vuln_extension']);

      const list = await ext.listExtensions(tx, { nodeId: node.id });
      expect(list[0]).toMatchObject({ id: done.id, scope: expect.stringContaining('Windows'), days: [{ level: 'Важная', days: 30 }], recordsCount: done.records, comment: 'Ждём обновление', cancelledAt: null });
      expect((await ext.getExtension(tx, done.id)).items.find((i) => i.cve === CVE)).toMatchObject({ dueBefore: '2026-10-29', dueAfter: '2026-11-30' });

      // Карточка: база, продление, итог.
      const info = await section.recordInfo(tx, after.id);
      expect(info.deadline).toMatchObject({ base: '2026-10-29', extendedDays: 30, final: '2026-11-30' });
      expect(info.extensions).toEqual([expect.objectContaining({ id: done.id, days: 30, active: true, cancelledAt: null })]);
    }));

  it('не участвуют: решение п. 7.3 и не переданные ИКТ, показывается сколько; фильтры; без уровня; дни 0–365', () =>
    inTx(async (tx) => {
      const { x, node, levelId } = await setup(tx, { handover: null, scanDate: addDays(todayIso(), -40) });
      expect(await ext.previewExtension(tx, { nodeId: node.id, daysByLevel: {} })).toMatchObject({ notHandedOver: 90, items: [], levels: [] });
      const scanId = must((await scans.listScans(tx, node.id))[0]).id;
      await scans.handOverScan(tx, x.actor, scanId, { date: HANDED_OVER() });

      const decided = await rec(tx, x, node.id, CVE);
      await records.updateRecord(tx, x.actor, decided.id, { version: decided.version, values: { [x.vf.measures.id]: 'Сегментация', [x.vf.newDue.id]: '2027-02-01' } });
      const noLevel = await rec(tx, x, node.id, 'CVE-2025-0411');
      const row = await tx.registerRecord.findUniqueOrThrow({ where: { id: noLevel.id } });
      const rest = Object.fromEntries(Object.entries(row.values as Record<string, unknown>).filter(([k]) => k !== x.vf.level.id));
      await tx.registerRecord.update({ where: { id: noLevel.id }, data: { values: rest as Prisma.InputJsonValue, version: { increment: 1 } } });

      const base = await ext.previewExtension(tx, { nodeId: node.id, daysByLevel: { none: 10 } });
      expect(base.withDecision).toBe(1);
      expect(base.items.map((i) => i.cve)).toEqual(['CVE-2025-0411']);
      expect(base.levels.at(-1)).toMatchObject({ id: 'none', label: 'Без уровня', count: 1 });
      expect(base.items[0]?.level).toBe('Без уровня');

      // «Только просроченные»: 14-дневные сроки истекли, остальные — нет.
      const important = levelId('Важная');
      const all = await ext.previewExtension(tx, { nodeId: node.id, daysByLevel: { [important]: 5 } });
      const overdue = await ext.previewExtension(tx, { nodeId: node.id, daysByLevel: { [important]: 5 }, onlyOverdue: true });
      expect(overdue.items.length).toBeGreaterThan(0);
      expect(overdue.items.length).toBeLessThan(all.items.length);
      expect(overdue.items.every((i) => i.dueBefore < todayIso())).toBe(true);
      expect(overdue.filteredOut).toBeGreaterThan(0);
      const until = must(overdue.items[0]).dueBefore;
      const byDate = await ext.previewExtension(tx, { nodeId: node.id, daysByLevel: { [important]: 5 }, dueUntil: until });
      expect(byDate.items.every((i) => i.dueBefore <= until)).toBe(true);
      await expectCode(ext.previewExtension(tx, { nodeId: node.id, daysByLevel: { [important]: 366 } }), 'BAD_DAYS');
      await expectCode(ext.previewExtension(tx, { nodeId: node.id, daysByLevel: { [important]: -1 } }), 'BAD_DAYS');
      await expectCode(ext.previewExtension(tx, { daysByLevel: {} }), 'BAD_SCOPE');
    }));

  it('область «группа»: все узлы группы; список у группы и у узла; записи изменились — BULK_CHANGED', () =>
    inTx(async (tx) => {
      const { x, node, group, file, levelId } = await setup(tx, { types: ['Windows', 'Серверы'] });
      const second = must(group.nodes.find((n) => n.id !== node.id));
      const p2 = await scan.previewNodeScan(tx, store, x.actor, second.id, SAMPLE, SAMPLE_NAME);
      const a2 = await scan.applyNodeScan(tx, x.actor, p2.id, { profileConfirmed: true });
      await scans.handOverScan(tx, x.actor, a2.scanId, { date: '2026-10-15' });
      await x.reload();
      const plan = { groupId: group.id, daysByLevel: { [levelId('Важная')]: 7 } };
      const p = await ext.previewExtension(tx, plan);
      expect(p.items.filter((i) => i.cve === CVE)).toHaveLength(2);
      const r = await rec(tx, x, second.id, CVE);
      await records.updateRecord(tx, x.actor, r.id, { version: r.version, values: { [x.vf.status.id]: x.opt('status', 'fixed') } });
      await expectCode(ext.applyExtension(tx, x.actor, { ...plan, ...basis(file.id), expected: p.items.length }), 'BULK_CHANGED');
      const fresh = await ext.previewExtension(tx, plan);
      const done = await ext.applyExtension(tx, x.actor, { ...plan, ...basis(file.id), expected: fresh.items.length });
      expect((await ext.listExtensions(tx, { groupId: group.id })).map((e) => e.id)).toEqual([done.id]);
      expect((await ext.listExtensions(tx, { nodeId: second.id })).map((e) => e.id)).toEqual([done.id]);
      expect((await rec(tx, x, node.id, CVE)).values[x.vf.extDays.id]).toBe(7);
    }));

  it('отмена — целиком: сроки возвращаются, запись другого цикла не трогается; событие остаётся; повторно — 409; два продления суммируются', () =>
    inTx(async (tx) => {
      const { x, node, file, levelId } = await setup(tx);
      const important = levelId('Важная');
      const plan = { nodeId: node.id, daysByLevel: { [important]: 10 } };
      const first = await ext.applyExtension(tx, x.actor, { ...plan, ...basis(file.id), expected: (await ext.previewExtension(tx, plan)).items.length });
      const secondPlan = { nodeId: node.id, daysByLevel: { [important]: 5 } };
      const second = await ext.applyExtension(tx, x.actor, { ...secondPlan, ...basis(file.id), basisNumber: '43', expected: (await ext.previewExtension(tx, secondPlan)).items.length });
      expect((await rec(tx, x, node.id, CVE)).values[x.vf.extDays.id]).toBe(15);

      // Повторно обнаруженная запись: цикл новый, продления прошлого не касаются.
      const other = await rec(tx, x, node.id, 'CVE-2025-0411');
      expect(other.values[x.vf.extDays.id]).toBe(15);
      await records.updateRecord(tx, x.actor, other.id, { version: other.version, values: { [x.vf.status.id]: x.opt('status', 'fixed') } });
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, 'vuln-2026-10-20.xlsx');
      const s2 = await scan.applyNodeScan(tx, x.actor, p.id, {});
      await x.reload();
      await scans.handOverScan(tx, x.actor, s2.scanId, { date: '2026-10-20' });
      const reopened = await rec(tx, x, node.id, 'CVE-2025-0411');
      expect(reopened.values[x.vf.extDays.id]).toBeUndefined();
      const v = reopened.version;
      const dueReopened = reopened.calc[x.vf.due.id];

      const res = await ext.cancelExtension(tx, x.actor, first.id);
      expect(res.returned).toBe(res.total - 1);
      const a = await rec(tx, x, node.id, CVE);
      expect(a.values[x.vf.extDays.id]).toBe(5);
      const again = await rec(tx, x, node.id, 'CVE-2025-0411');
      expect([again.version, again.calc[x.vf.due.id]]).toEqual([v, dueReopened]);
      expect((await records.recordHistory(tx, a.id))[0]?.summary).toContain('отменено, срок −10 дн.');
      const list = await ext.listExtensions(tx, { nodeId: node.id });
      expect(list.find((e) => e.id === first.id)?.cancelledAt).toBeTruthy();
      expect(list.find((e) => e.id === second.id)?.cancelledAt).toBeNull();
      await expectCode(ext.cancelExtension(tx, x.actor, first.id), 'EXTENSION_CANCELLED');
      const info = await section.recordInfo(tx, a.id);
      expect(info.extensions.find((e) => e.id === first.id)).toMatchObject({ active: false });
      expect(info.extensions.find((e) => e.id === second.id)).toMatchObject({ active: true });

      // Отмена последнего — ключ убирается, срок прежний.
      await ext.cancelExtension(tx, x.actor, second.id);
      const b = await rec(tx, x, node.id, CVE);
      expect([b.values[x.vf.extDays.id], b.calc[x.vf.due.id]]).toEqual([undefined, '2026-10-29']);

      // Таблицы только пополняются.
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.$executeRaw`UPDATE vuln_extensions SET cancelled_at = NULL WHERE id = ${first.id}::uuid`).rejects.toThrow(/продление не меняется/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      await tx.$executeRaw`SAVEPOINT s2`;
      await expect(tx.$executeRaw`UPDATE vuln_extension_items SET days = 1 WHERE extension_id = ${first.id}::uuid`).rejects.toThrow(/permission denied/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s2`;
    }));

  it('продление снимает просрочку в KPI, мониторе и фильтре, отмена возвращает; срок решения п. 7.3 продление не трогает', () =>
    inTx(async (tx) => {
      const { x, node, scanId, file, levelId } = await setup(tx, { handover: null, scanDate: addDays(todayIso(), -40) });
      await scans.handOverScan(tx, x.actor, scanId, { date: HANDED_OVER() });
      const important = levelId('Важная');
      const overdueCount = async () => (await section.nodeRecords(tx, node.id, { state: 'overdue', limit: 200 })).total;
      const filtered = async () => (await records.listRecords(tx, x.reg.id, { limit: 200, filter: { deadline: ['overdue'] } })).total;
      const kpiOverdue = async () => must((await computeKpis(tx)).find((k) => k.key === 'vulns_overdue')).value;
      const monitored = async () => must(await vulnsBlock(tx, x.reg, todayIso())).buckets.filter((b) => b.key === 'overdue').reduce((n, b) => n + b.count, 0);
      const before = await overdueCount();
      expect(before).toBeGreaterThan(0);
      const inFilter = await filtered();
      const [kpi, mon] = [await kpiOverdue(), await monitored()];
      expect(inFilter).toBeGreaterThanOrEqual(before);
      const plan = { nodeId: node.id, daysByLevel: { [important]: 100 }, onlyOverdue: true };
      const p = await ext.previewExtension(tx, plan);
      const done = await ext.applyExtension(tx, x.actor, { ...plan, ...basis(file.id), expected: p.items.length });
      expect(await overdueCount()).toBe(before - p.items.length);
      expect(await filtered()).toBe(inFilter - p.items.length);
      expect(await kpiOverdue()).toBe(Number(kpi) - p.items.length);
      expect(await monitored()).toBe(mon - p.items.length);
      await ext.cancelExtension(tx, x.actor, done.id);
      expect(await overdueCount()).toBe(before);
      expect(await filtered()).toBe(inFilter);
      expect(await kpiOverdue()).toBe(kpi);
      expect(await monitored()).toBe(mon);
    }));
});

describe('продления по HTTP', () => {
  it('просмотр — ib.work; предпросмотр, применение, отмена — только vulns.deadlines (и у супер-администратора без него — 403)', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Http-Ext-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const { node, levelId } = await setup(tx);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const admin = await makeUser(tx, ['super_admin'], { passwordHash: hash });
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash: hash });
      const holder = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const role = await tx.role.create({ data: { name: unique('Сроки'), description: '', isSystem: false, permissions: { create: [{ permission: { connect: { code: 'vulns.deadlines' } } }] } } });
      await tx.userRole.create({ data: { userId: holder.id, roleId: role.id } });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return { cookie: `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`, origin: TEST_PORTAL_URL };
      };
      const [S, A, R, H] = [await login(staff.login), await login(admin.login), await login(reader.login), await login(holder.login)];
      const body = { nodeId: node.id, daysByLevel: { [levelId('Важная')]: 3 } };
      const preview = '/api/v1/vulns/extensions/preview';
      for (const h of [S, A, R]) expect((await app.inject({ method: 'POST', url: preview, headers: h, payload: body })).statusCode).toBe(403);
      const p = await app.inject({ method: 'POST', url: preview, headers: H, payload: body });
      expect(p.statusCode).toBe(200);
      const expected = (p.json() as { items: unknown[] }).items.length;
      const own = await uploadFile(tx, store, await actorFor(tx, holder.id), 'обоснование.txt', Buffer.from('x'));
      const full = { ...body, ...basis(own.id), expected };
      expect((await app.inject({ method: 'POST', url: '/api/v1/vulns/extensions', headers: S, payload: full })).statusCode).toBe(403);
      const done = await app.inject({ method: 'POST', url: '/api/v1/vulns/extensions', headers: H, payload: full });
      expect(done.statusCode, done.body).toBe(201);
      const id = (done.json() as { id: string }).id;
      expect((await app.inject({ url: `/api/v1/vulns/extensions?nodeId=${node.id}`, headers: S })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/v1/vulns/extensions/${id}`, headers: S })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/v1/vulns/extensions/${id}`, headers: R })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/v1/vulns/extensions/${id}/cancel`, headers: A })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/v1/vulns/extensions/${id}/cancel`, headers: H })).statusCode).toBe(200);
    }));
});
