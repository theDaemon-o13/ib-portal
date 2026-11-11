// Импорт большого скана (1.13.9, docs/tasks/1.13.9-vuln-import-timeout.md): 3390 находок одной транзакцией пачками,
// повторный импорт, откат при ошибке на середине, один импорт в узел за раз, ответ с номером запроса, колонки Linux.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import type { Values } from '../../lib/register-values.js';
import { expectCode, inTx, inTxLong, makeUser, must, prisma, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { SYNTHETIC_HOST, syntheticReport } from '../../test/scan-synthetic.js';
import { vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { recordHistory } from '../registers/records.service.js';
import * as groups from './groups.service.js';
import { keyNorm } from './keys.js';
import * as scan from './scan-import.service.js';

const root = mkdtempSync(join(tmpdir(), 'ibportal-scan-bulk-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function linuxNode(tx: Tx, x: VulnFixture) {
  const t = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: 'Linux' } });
  const g = await groups.createGroup(tx, x.actor, { name: unique('Серверы Linux'), kind: 'service', systemTypeIds: [t.id] });
  return must(g.nodes[0]);
}

describe('импорт большого скана', () => {
  it('3390 находок в пустой узел: 3390 записей, строк журнала и истории; повторный импорт — всё «Без изменений»', () =>
    inTxLong(async (tx) => {
      const x = await vulnRegister(tx);
      const node = await linuxNode(tx, x);
      const { buffer, fileName, rows } = await syntheticReport(3390);
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, buffer, fileName);
      expect(p.summary.counts).toEqual({ new: 3390, reopened: 0, changed: 0, unchanged: 0, deleted: 0, gone: 0 });
      expect([p.summary.hostsCount, p.summary.hosts[0], p.summary.coverageTitle]).toEqual([1, SYNTHETIC_HOST, '']);
      const a = await scan.applyNodeScan(tx, x.actor, p.id, {});
      expect(a).toMatchObject({ created: 3390, reopened: 0, changed: 0, unchanged: 0, gone: 0 });

      const recs = await tx.vulnRecord.findMany({ where: { nodeId: node.id }, include: { record: true } });
      expect(recs).toHaveLength(3390);
      const ids = recs.map((r) => r.recordId);
      expect(await tx.auditLog.count({ where: { action: 'register_record.created', entity: 'register_record', entityId: { in: ids } } })).toBe(3390);
      expect(await tx.vulnRecordScan.count({ where: { scanId: a.scanId, outcome: 'new' } })).toBe(3390);
      // История записи — из журнала: у каждой записи строка «создана из скана».
      await x.reload();
      const one = must(recs.find((r) => (r.record.values as Values)[x.vf.cve.id] === rows[0]?.cve && x.vf.pkg.options.find((o) => o.id === (r.record.values as Values)[x.vf.pkg.id])?.label === rows[0]?.pkg));
      const history = await recordHistory(tx, one.recordId);
      expect(history.map((h) => h.summary)).toEqual([expect.stringContaining(`из скана «${fileName}»`)]);
      // Описание и вектор отчёта Linux записаны (колонки «Описание (из CVE, англ.)» и «Вектор»).
      const v = one.record.values as Values;
      expect(v[x.vf.desc.id]).toBe(rows[0]?.desc);
      expect(recs.filter((r) => (r.record.values as Values)[x.vf.vector.id] !== undefined)).toHaveLength(rows.filter((r) => r.vector).length);

      const again = await scan.previewNodeScan(tx, store, x.actor, node.id, buffer, fileName.replace('2026_11_10', '2026_11_11'));
      expect(again.summary.counts).toEqual({ new: 0, reopened: 0, changed: 0, unchanged: 3390, deleted: 0, gone: 0 });
      const a2 = await scan.applyNodeScan(tx, x.actor, again.id, {});
      expect(a2).toMatchObject({ created: 0, changed: 0, unchanged: 3390 });
      expect(await tx.vulnRecord.count({ where: { nodeId: node.id } })).toBe(3390);
    }), 120_000);

  it('ошибка на середине применения — откат целиком: в узле 0 записей, скана нет, предпросмотр ждёт применения', () =>
    inTxLong(async (tx) => {
      const x = await vulnRegister(tx);
      const node = await linuxNode(tx, x);
      const { buffer, fileName } = await syntheticReport(1500);
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, buffer, fileName);
      const before = await tx.registerRecord.count({ where: { registerId: x.reg.id } });
      const auditBefore = await tx.auditLog.count();
      // Подставная ошибка: записи и журнал новых записей уже вставлены, скан — ещё нет.
      const steps: string[] = [];
      const progress = {
        get step() {
          return steps.at(-1) ?? '';
        },
        set step(v: string) {
          steps.push(v);
          if (v === 'скан') throw new Error('подставная ошибка');
        },
      };
      await expect(scan.applyNodeScan(tx, x.actor, p.id, {}, progress)).rejects.toThrow('подставная ошибка');
      expect(steps).toContain('журнал новых записей');
      expect(await tx.vulnRecord.count({ where: { nodeId: node.id } })).toBe(0);
      expect(await tx.registerRecord.count({ where: { registerId: x.reg.id } })).toBe(before);
      expect(await tx.vulnScan.count({ where: { nodeId: node.id } })).toBe(0);
      expect(await tx.auditLog.count()).toBe(auditBefore);
      expect((await tx.registerImport.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('preview');
      // После отката тот же предпросмотр применяется.
      expect((await scan.applyNodeScan(tx, x.actor, p.id, {})).created).toBe(1500);
    }), 120_000);

  it('второй импорт в тот же узел, пока идёт первый, — 409 «В этот узел уже идёт импорт»', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const node = await linuxNode(tx, x);
      const { buffer, fileName } = await syntheticReport(20);
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, buffer, fileName);
      // Другой запрос (своё соединение) держит блокировку импорта этого узла.
      let release!: () => void;
      const hold = new Promise<void>((r) => {
        release = r;
      });
      let lockedNow!: () => void;
      const locked = new Promise<void>((r) => {
        lockedNow = r;
      });
      const other = prisma.$transaction(async (t2) => {
        await t2.$executeRaw`SELECT pg_advisory_xact_lock(${scan.NODE_IMPORT_LOCK}::int, hashtext(${node.id}))`;
        lockedNow();
        await hold;
      }, { timeout: 30_000 });
      await locked;
      try {
        await expectCode(scan.applyNodeScan(tx, x.actor, p.id, {}), 'IMPORT_IN_PROGRESS');
      } finally {
        release();
        await other;
      }
      // Первый закончился — импорт проходит.
      expect((await scan.applyNodeScan(tx, x.actor, p.id, {})).created).toBe(20);
    }));
});

describe('импорт скана: отчёт Linux (1.13.9)', () => {
  it('вектор: «Сеть» → «Удалённо (сеть)», «Локально» → «Локально», «Смежная сеть» и «Физический» — новые значения; «Задача №» — справка', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const node = await linuxNode(tx, x);
      const { buffer, fileName, rows } = await syntheticReport(300);
      const p = await scan.previewNodeScan(tx, store, x.actor, node.id, buffer, fileName);
      expect(p.summary.info).toEqual(['Колонка «Задача №» не используется']);
      expect(p.summary.warnings.join(' ')).not.toContain('Сетевой вектор');
      expect(p.summary.warnings.join(' ')).not.toContain('Краткое описание');
      expect(p.summary.warnings.join(' ')).toContain('«Обнаружений»');
      const vectorNew = p.summary.newOptions.find((o) => o.field === x.vf.vector.label)?.values ?? [];
      expect([...vectorNew].sort()).toEqual(['Смежная сеть', 'Физический']);
      await scan.applyNodeScan(tx, x.actor, p.id, {});
      await x.reload();
      const label = (id: unknown) => x.vf.vector.options.find((o) => o.id === id)?.label;
      const recs = await tx.vulnRecord.findMany({ where: { nodeId: node.id }, include: { record: true } });
      const byKey = new Map(recs.map((r) => [r.keyNorm, label((r.record.values as Values)[x.vf.vector.id])]));
      const expected: Record<string, string> = { Сеть: 'Удалённо (сеть)', Локально: 'Локально', 'Смежная сеть': 'Смежная сеть', Физический: 'Физический' };
      const withVector = rows.filter((y) => y.vector);
      expect(withVector.length).toBeGreaterThan(100);
      for (const r of withVector) expect(byKey.get(keyNorm(r.pkg, r.cve)), `${r.pkg} ${r.cve}`).toBe(expected[r.vector as string]);
      expect(x.vf.vector.options.filter((o) => o.label === 'Удалённо (сеть)')).toHaveLength(1);
    }));
});

describe('импорт скана: ошибка применения по HTTP', () => {
  it('не 409/400, а сбой — 500 IMPORT_FAILED с номером запроса; в логе error: узел, строк, шаг, длительность, номер', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Http-Scan-Pass-2026';
      const x = await vulnRegister(tx);
      const node = await linuxNode(tx, x);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: await argon2Hasher.hash(PASSWORD) });
      const lines: string[] = [];
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store,
        logger: { level: 'error', stream: { write: (s: string) => lines.push(s) } },
      });
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: staff.login, password: PASSWORD } });
      const cookie = `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      const { buffer, fileName } = await syntheticReport(30);
      const up = await app.inject({ method: 'POST', url: `/api/v1/vulns/nodes/${node.id}/scan-imports`, body: buffer, headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(fileName) } });
      expect(up.statusCode).toBe(201);
      const id = (up.json() as { id: string }).id;
      // Испорченный предпросмотр — сбой разбора внутри применения (не AppError).
      await tx.$executeRaw`UPDATE register_imports SET payload = jsonb_set(payload, '{rows}', 'null'::jsonb) WHERE id = ${id}::uuid`;
      const applied = await app.inject({ method: 'POST', url: `/api/v1/vulns/scan-imports/${id}/apply`, headers: { cookie }, payload: {} });
      expect(applied.statusCode).toBe(500);
      const err = (applied.json() as { error: { code: string; message: string } }).error;
      expect(err.code).toBe('IMPORT_FAILED');
      const m = /^Импорт не завершён, ничего не записано\. Сообщите администратору номер запроса ([0-9a-f]{8})$/.exec(err.message);
      expect(m).not.toBeNull();
      const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'импорт не выполнен');
      expect(line).toMatchObject({ level: 50, reqId: m?.[1], import: 'скан', rows: 30, step: 'проверка', timeout: false });
      expect(String(line?.target)).toContain('Серверы Linux');
      expect(typeof line?.durationMs).toBe('number');
      expect(await tx.vulnScan.count({ where: { nodeId: node.id } })).toBe(0);
      await app.close();
    }));
});
