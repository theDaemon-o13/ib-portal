// Системные цепочки автозадач реестров (1.14.0, ADR-0053): привязка при создании, одна цепочка на источник,
// «Уязвимости · <группа>» и «Реестр · <название>», перенос записи между группами, переименование, запреты API,
// отвязка вручную, подсказки, видимость, одновременное создание. Данные — вымышленные. Тесты — в транзакции с откатом,
// кроме одновременного создания (две настоящие транзакции; созданные цепочки удаляются в конце).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { seedVulnLegacy } from '../../../prisma/seed/vuln-legacy.js';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { SYSTEM_USER_LOGIN } from '../../lib/system-user.js';
import { actorFor, expectCode, inTx, inTxLong, makeUser, must, prisma, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { makeRegister } from '../../test/registers-fixture.js';
import { SAMPLE, SAMPLE_NAME, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { createRule, runAutomations } from '../automations/service.js';
import * as records from '../registers/records.service.js';
import * as structure from '../registers/structure.service.js';
import * as groups from '../vulns/groups.service.js';
import * as scan from '../vulns/scan-import.service.js';
import * as scans from '../vulns/scans.service.js';
import { transferRecords } from '../vulns/transfer.service.js';
import { suggestChains } from './chain-suggest.js';
import * as chains from './chains.js';
import { statusIdOf } from './flow.js';
import * as svc from './service.js';
import { ensureSystemChain } from './system-chains.js';

const root = mkdtempSync(join(tmpdir(), 'ibportal-system-chains-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PASSWORD = 'System-Chains-2026-Qx';
const NOV_11 = new Date('2026-11-11T06:00:00Z');
const NOV_12 = new Date('2026-11-12T06:00:00Z');
const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Реестр конструктора и правило «Статус = В работе → уведомить» по n записям. */
async function registerWithTasks(tx: Tx, n: number, name = unique('Реестр проверок')) {
  const x = await makeRegister(tx, name);
  const rule = await createRule(tx, x.actor, x.reg.id, {
    condition: { kind: 'equals', fieldId: x.f.status, optionId: x.opt('status', 'В работе') },
    action: { eventType: 'notify', recipients: [{ kind: 'user', userId: x.actor.id }] },
  });
  const recs = [];
  for (let i = 1; i <= n; i++) {
    recs.push(await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: `Запись ${i}`, [x.f.status]: x.opt('status', 'В работе') } }));
  }
  await runAutomations(tx, { now: NOV_11, registerId: x.reg.id });
  const tasks = await tx.task.findMany({ where: { automationId: rule.id }, orderBy: { number: 'asc' } });
  return { x, rule, recs, tasks };
}

/** Группа с узлом Windows, скан образца и передача ИКТ: записи узла с начатым сроком. */
async function groupWithScan(tx: Tx, x: VulnFixture, name: string) {
  const t = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: 'Windows' } });
  const g = await groups.createGroup(tx, x.actor, { name, kind: 'service', systemTypeIds: [t.id] });
  const node = must(g.nodes[0]);
  const p = await scan.previewNodeScan(tx, store, x.actor, node.id, SAMPLE, SAMPLE_NAME);
  const a = await scan.applyNodeScan(tx, x.actor, p.id, { scanDate: '2026-01-05' });
  await scans.handOverScan(tx, x.actor, a.scanId, { date: '2026-01-06' });
  return { group: g, node };
}

const systemChains = (tx: Tx) => tx.taskChain.findMany({ where: { kind: 'system', deletedAt: null } });

describe('системные цепочки автозадач реестров (1.14.0)', () => {
  it('«Уязвимости»: задачи двух групп — в цепочках «Уязвимости · A» и «Уязвимости · B»; повторный прогон новых цепочек не создаёт; переименование группы', () =>
    inTxLong(async (tx) => {
      const x = await vulnRegister(tx);
      const nameA = unique('Сервис А');
      const nameB = unique('Отдел Б');
      const A = await groupWithScan(tx, x, nameA);
      const B = await groupWithScan(tx, x, nameB);
      const before = (await systemChains(tx)).length;
      const run1 = await runAutomations(tx, { registerId: x.reg.id, now: NOV_11 });
      expect(run1.tasksCreated).toBeGreaterThan(10);

      const chainA = must(await tx.taskChain.findFirst({ where: { kind: 'system', sourceType: 'vuln_group', sourceId: A.group.id } }));
      const chainB = must(await tx.taskChain.findFirst({ where: { kind: 'system', sourceType: 'vuln_group', sourceId: B.group.id } }));
      expect(chainA.title).toBe(`Уязвимости · ${nameA}`);
      expect(chainB.title).toBe(`Уязвимости · ${nameB}`);
      expect((await systemChains(tx)).length).toBe(before + 2);
      const sys = await tx.user.findUniqueOrThrow({ where: { login: SYSTEM_USER_LOGIN } });
      expect(chainA.createdBy).toBe(sys.id);

      // Каждая автозадача — в цепочке группы своей записи.
      const tasks = await tx.task.findMany({ where: { source: 'automation', record: { registerId: x.reg.id } }, select: { id: true, chainId: true, recordId: true } });
      const nodeOf = new Map((await tx.vulnRecord.findMany({ where: { recordId: { in: tasks.map((t) => t.recordId as string) } } })).map((v) => [v.recordId, v.nodeId]));
      for (const t of tasks) expect(t.chainId).toBe(nodeOf.get(t.recordId as string) === A.node.id ? chainA.id : chainB.id);
      expect(tasks.some((t) => t.chainId === chainA.id) && tasks.some((t) => t.chainId === chainB.id)).toBe(true);

      // Журнал: «добавлена в цепочку … автоматически», автор — система.
      const linked = must(await tx.auditLog.findFirst({ where: { action: 'task.chain_linked', entityId: must(tasks[0]).id } }));
      expect(linked.userId).toBeNull();
      expect((linked.diff as { summary: string }).summary).toMatch(/добавлена в цепочку «Уязвимости · .+» \(#\d+\) автоматически$/);
      expect(await tx.auditLog.count({ where: { action: 'task_chain.created', entityId: chainA.id, userId: null } })).toBe(1);

      // Повторный прогон: новых цепочек нет.
      await runAutomations(tx, { registerId: x.reg.id, now: NOV_12 });
      expect((await systemChains(tx)).length).toBe(before + 2);

      // Переименование группы — новое название у цепочки, в карточке задачи и в списке.
      const renamed = unique('Сервис А2');
      await groups.renameGroup(tx, x.actor, A.group.id, { name: renamed, version: (await tx.vulnGroup.findUniqueOrThrow({ where: { id: A.group.id } })).version });
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const detail = await chains.getChain(tx, staff, chainA.id);
      expect(detail).toMatchObject({ title: `Уязвимости · ${renamed}`, kind: 'system', status: 'open', canManage: false, source: { type: 'vuln_group', id: A.group.id, name: renamed, deleted: false } });
      const someA = must(tasks.find((t) => t.chainId === chainA.id));
      expect((await svc.getTask(tx, someA.id)).chain).toMatchObject({ title: `Уязвимости · ${renamed}`, kind: 'system' });
    }), 300_000);

  it('«Без группы» → «Уязвимости · Без группы»; перенос записи в группу A — незавершённые задачи в цепочке A, выполненные остались', () =>
    inTxLong(async (tx) => {
      const x = await vulnRegister(tx);
      const A = await groupWithScan(tx, x, unique('Сервис А'));
      // Запись «как в 1.1.0» с давно переданным сроком → seed переносит её в «Без группы».
      const pkg = await tx.registerFieldOption.create({ data: { fieldId: x.vf.pkg.id, label: unique('Пакет'), sortOrder: 5000 } });
      await x.reload();
      const number = await records.nextNumbers(tx, x.reg.id, 1);
      const rec = await tx.registerRecord.create({
        data: {
          registerId: x.reg.id, number, searchText: 'cve-2099-10001',
          values: { [x.vf.cve.id]: 'CVE-2099-10001', [x.vf.pkg.id]: pkg.id, [x.vf.status.id]: x.opt('status', 'open'), [x.vf.crit.id]: x.opt('crit', 'critical'), [x.vf.notified.id]: '2026-01-06' },
        },
      });
      await seedVulnLegacy(tx);
      await runAutomations(tx, { registerId: x.reg.id, now: NOV_11 });
      const legacyGroup = await tx.vulnGroup.findFirstOrThrow({ where: { systemKey: { not: null } } });
      const recTasks = await tx.task.findMany({ where: { recordId: rec.id }, include: { chain: true }, orderBy: { number: 'asc' } });
      expect(recTasks.length).toBeGreaterThanOrEqual(2);
      for (const t of recTasks) expect(t.chain).toMatchObject({ kind: 'system', sourceType: 'vuln_group', sourceId: legacyGroup.id, title: `Уязвимости · ${legacyGroup.name}` });

      const [done, ...open] = recTasks;
      await tx.task.update({ where: { id: must(done).id }, data: { statusId: await statusIdOf(tx, 'done'), completedAt: new Date() } });
      const res = await transferRecords(tx, x.actor, { recordIds: [rec.id], nodeId: A.node.id });
      expect(res.moved).toHaveLength(1);
      const chainA = must(await tx.taskChain.findFirst({ where: { kind: 'system', sourceType: 'vuln_group', sourceId: A.group.id, deletedAt: null } }));
      for (const t of open) {
        expect((await tx.task.findUniqueOrThrow({ where: { id: t.id } })).chainId).toBe(chainA.id);
        const moved = must(await tx.auditLog.findFirst({ where: { action: 'task.chain_moved', entityId: t.id } }));
        expect(moved.userId).toBe(x.actor.id);
        expect((moved.diff as { summary: string }).summary).toContain('автоматически: запись #');
      }
      expect((await tx.task.findUniqueOrThrow({ where: { id: must(done).id } })).chainId).toBe(must(done).chainId);
    }), 300_000);

  it('реестр конструктора → «Реестр · <название>»; переименование реестра; повторный прогон — та же цепочка', () =>
    inTx(async (tx) => {
      const name = unique('Реестр проверок');
      const { x, tasks } = await registerWithTasks(tx, 3, name);
      const chain = must(await tx.taskChain.findFirst({ where: { kind: 'system', sourceType: 'register', sourceId: x.reg.id } }));
      expect(chain.title).toBe(`Реестр · ${name}`);
      expect(tasks.every((t) => t.chainId === chain.id)).toBe(true);
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Запись 4', [x.f.status]: x.opt('status', 'В работе') } });
      await runAutomations(tx, { now: NOV_12, registerId: x.reg.id });
      expect(await tx.taskChain.count({ where: { kind: 'system', sourceType: 'register', sourceId: x.reg.id } })).toBe(1);
      expect(await tx.task.count({ where: { chainId: chain.id } })).toBe(4);

      const reg = await tx.register.findUniqueOrThrow({ where: { id: x.reg.id } });
      await structure.updateRegister(tx, x.actor, x.reg.id, { version: reg.version, name: `${name} (новое)` });
      expect((await tx.taskChain.findUniqueOrThrow({ where: { id: chain.id } })).title).toBe(`Реестр · ${name} (новое)`);
    }));

  it('API: в системную цепочку нельзя добавить ручную задачу, создать в ней задачу, перенести; нельзя закрыть, удалить, переименовать, открыть', () =>
    inTx(async (tx) => {
      const { tasks } = await registerWithTasks(tx, 1);
      const chainId = must(must(tasks[0]).chainId);
      const hash = await argon2Hasher.hash(PASSWORD);
      const boss = await makeUser(tx, ['ib_staff', 'super_admin'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL });
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: boss.login, password: PASSWORD } });
      const headers = { cookie: `ib_session=${login.cookies.find((c) => c.name === 'ib_session')?.value}`, origin: TEST_PORTAL_URL };
      const call = async (method: 'POST' | 'PATCH', url: string, payload: object) => {
        const r = await app.inject({ method, url: `/api/v1${url}`, headers, payload });
        return { status: r.statusCode, code: r.json().error?.code as string | undefined, message: r.json().error?.message as string | undefined };
      };
      const c = await tx.taskChain.findUniqueOrThrow({ where: { id: chainId } });
      const cat = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
      const manual = await svc.createTask(tx, await actorFor(tx, boss.id), { title: 'Ручная задача', categoryId: cat.id });
      const other = await chains.createChain(tx, await actorFor(tx, boss.id), { title: 'Ручная цепочка', tasks: [{ id: manual.id, version: manual.version }] });

      for (const [m, url, body] of [
        ['PATCH', `/task-chains/${chainId}`, { version: c.version, title: 'Другое' }],
        ['POST', `/task-chains/${chainId}/close`, { version: c.version }],
        ['POST', `/task-chains/${chainId}/reopen`, { version: c.version }],
        ['POST', `/task-chains/${chainId}/delete`, { version: c.version }],
        ['POST', `/task-chains/${chainId}/tasks`, { tasks: [{ id: manual.id, version: (await tx.task.findUniqueOrThrow({ where: { id: manual.id } })).version }] }],
        ['POST', `/tasks/${manual.id}/move-chain`, { version: (await tx.task.findUniqueOrThrow({ where: { id: manual.id } })).version, toChainId: chainId }],
        ['POST', '/tasks', { title: 'Ещё одна', categoryId: cat.id, chain: { id: chainId } }],
      ] as const) {
        const r = await call(m, url, body);
        expect([url, r.status, r.code]).toEqual([url, 409, 'SYSTEM_CHAIN']);
        expect(r.message).toContain('Системную цепочку ведёт портал');
      }
      expect(await tx.task.count({ where: { chainId } })).toBe(1);
      expect((await tx.taskChain.findUniqueOrThrow({ where: { id: chainId } })).title).toBe(c.title);
      expect(other.kind).toBe('manual');

      // Отвязать и перенести в ручную цепочку можно.
      const t = must(tasks[0]);
      const moved = await call('POST', `/tasks/${t.id}/move-chain`, { version: (await tx.task.findUniqueOrThrow({ where: { id: t.id } })).version, toChainId: other.id });
      expect(moved.status).toBe(200);
    }));

  it('отвязанная вручную задача не возвращается при следующем прогоне', () =>
    inTx(async (tx) => {
      const { x, rule, tasks } = await registerWithTasks(tx, 2);
      const t = must(tasks[0]);
      await chains.detachTask(tx, { ...x.actor, perms: new Set(['ib.work']) }, must(t.chainId), t.id, t.version);
      // Следующий прогон: по записи открытая задача — комментарий, цепочки нет; новая запись — новая задача в цепочке.
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Запись 3', [x.f.status]: x.opt('status', 'В работе') } });
      await runAutomations(tx, { now: NOV_12, registerId: x.reg.id });
      expect((await tx.task.findUniqueOrThrow({ where: { id: t.id } })).chainId).toBeNull();
      expect(await tx.task.count({ where: { automationId: rule.id, chainId: null } })).toBe(1);
      expect(await tx.task.count({ where: { automationId: rule.id, chainId: must(t.chainId) } })).toBe(2);
    }));

  it('подсказки по заголовку: системные цепочки не предлагаются', () =>
    inTx(async (tx) => {
      const name = unique('Реестр подсказок');
      const { x } = await registerWithTasks(tx, 2, name);
      const actor = { ...x.actor, perms: new Set(['ib.work']) };
      const s = await suggestChains(tx, actor, `Реестр · ${name}`);
      expect(s.items.filter((i) => i.kind === 'chain')).toEqual([]);
    }));

  it('видимость: без ib.work — ни цепочки, ни счётчиков; по источнику — ссылка «Задачи: N активных»; без активных задач — в списке с active = 0 (доска её прячет)', () =>
    inTx(async (tx) => {
      const { x, tasks } = await registerWithTasks(tx, 3);
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const reader = await actorFor(tx, (await makeUser(tx, ['doc_reader'])).id);
      const chainId = must(must(tasks[0]).chainId);
      expect(await chains.chainBySource(tx, staff, 'register', x.reg.id)).toEqual({ chain: expect.objectContaining({ id: chainId, active: 3, total: 3 }) });
      expect(await chains.chainBySource(tx, reader, 'register', x.reg.id)).toEqual({ chain: null });
      expect((await chains.listChains(tx, reader, { limit: 50 })).items).toEqual([]);
      await expectCode(chains.getChain(tx, reader, chainId), 'NOT_FOUND');

      for (const t of tasks) await tx.task.update({ where: { id: t.id }, data: { statusId: await statusIdOf(tx, 'done'), completedAt: new Date() } });
      const listed = must((await chains.listChains(tx, staff, { limit: 200, kind: 'system' })).items.find((c) => c.id === chainId));
      expect(listed).toMatchObject({ status: 'open', counts: { total: 3, done: 3, active: 0 }, allDone: false, canManage: false });
    }));

  it('одновременное создание двух задач одного источника — одна цепочка', async () => {
    const source = { type: 'register' as const, id: randomUUID(), name: unique('Реестр гонки') };
    const run = (delayMs: number) => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_sleep(${delayMs / 1000})`);
      const c = await ensureSystemChain(tx, source);
      await tx.$executeRawUnsafe('SELECT pg_sleep(0.4)');
      return c.id;
    }, { timeout: 20_000 });
    try {
      const [a, b] = await Promise.all([run(0), run(100)]);
      expect(a).toBe(b);
      expect(await prisma.taskChain.count({ where: { kind: 'system', sourceType: 'register', sourceId: source.id } })).toBe(1);
    } finally {
      await prisma.taskChain.deleteMany({ where: { kind: 'system', sourceType: 'register', sourceId: source.id } });
    }
  });
});
