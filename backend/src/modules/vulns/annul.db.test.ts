// «Аннулировать скан» (1.13.12, ADR-0052; docs/plans/release-1.13.12.md): условия, последствия, корзина, права.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { expectCode, inTx, lastAudit, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { SAMPLE, vulnRegister, type VulnFixture } from '../../test/vulns-fixture.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { listDeletions, restoreDeletion } from '../trash/service.js';
import * as annul from './annul.service.js';
import * as groups from './groups.service.js';
import * as scan from './scan-import.service.js';
import * as scans from './scans.service.js';
import { overview, recordInfo } from './section.service.js';

const root = mkdtempSync(join(tmpdir(), 'ibportal-annul-'));
const store = diskFileStore(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const unique = (s: string) => `${s} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function node(tx: Tx, x: VulnFixture) {
  const t = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: groups.SYSTEM_TYPES_CATALOG, value: 'Windows' } });
  const g = await groups.createGroup(tx, x.actor, { name: unique('Отдел карт'), kind: 'department', systemTypeIds: [t.id] });
  return must(g.nodes[0]);
}

/** Тот же отчёт дважды: первый скан — «дубль» (12.10), второй — тот же файл под датой 16.10. */
async function twoScans(tx: Tx, x: VulnFixture, nodeId: string) {
  const p1 = await scan.previewNodeScan(tx, store, x.actor, nodeId, SAMPLE, 'vuln-windows-2026-10-15.xlsx');
  const a1 = await scan.applyNodeScan(tx, x.actor, p1.id, {});
  const p2 = await scan.previewNodeScan(tx, store, x.actor, nodeId, SAMPLE, 'vuln-windows-2026-10-16.xlsx');
  const a2 = await scan.applyNodeScan(tx, x.actor, p2.id, {});
  return { first: a1.scanId, second: a2.scanId };
}

describe('аннулировать скан', () => {
  it('при выполненных условиях: событие корзины и журнал; скан не изменился; пропал из дерева и «ждут передачи»; «Передать ИКТ» — 409', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const n = await node(tx, x);
      const { first, second } = await twoScans(tx, x, n.id);
      const before = await tx.vulnScan.findUniqueOrThrow({ where: { id: first } });
      expect((await scans.getScan(tx, first)).canAnnul).toBe(true);
      expect((await scans.getScan(tx, second)).canAnnul).toBe(false);

      const r = await annul.annulScan(tx, x.actor, first, { reason: 'reupload' });
      expect(r.annulled).toMatchObject({ reasonCode: 'reupload', reasonLabel: 'Повторная загрузка' });
      const audit = await lastAudit(tx);
      expect(audit).toMatchObject({ action: 'vuln.scan.annulled', entity: 'vuln_scan', entityId: first });
      expect((audit.diff as { summary: string }).summary).toContain('Изменения реестра не откатывались');
      // Скан, файл, снимок находок и сравнение — как были.
      expect(await tx.vulnScan.findUniqueOrThrow({ where: { id: first } })).toEqual(before);

      expect((await scans.listScans(tx, n.id)).map((s) => s.id)).toEqual([second]);
      const all = await scans.listScans(tx, n.id, { withAnnulled: true });
      expect(all.map((s) => [s.id, s.annulled])).toEqual([[second, false], [first, true]]);
      const o = await overview(tx);
      expect(o.awaiting.map((s) => s.id)).toContain(second);
      expect(o.awaiting.map((s) => s.id)).not.toContain(first);
      expect(must(o.nodes.find((s) => s.nodeId === n.id)).scans.map((s) => s.id)).toEqual([second]);

      const detail = await scans.getScan(tx, first);
      expect(detail.annulment).toMatchObject({ reasonLabel: 'Повторная загрузка', deletionId: r.deletionId });
      expect([detail.annulled, detail.canAnnul]).toEqual([true, false]);
      await expectCode(scans.handOverScan(tx, x.actor, first, { date: '2026-10-20' }), 'SCAN_ANNULLED');
    }));

  it('карточка записи: аннулированный скан — с отметкой; «впервые» — по неаннулированным; срок — от передачи следующего скана', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const n = await node(tx, x);
      const { first, second } = await twoScans(tx, x, n.id);
      await annul.annulScan(tx, x.actor, first, { reason: 'reupload' });
      const rec = must(await tx.vulnRecord.findFirst({ where: { nodeId: n.id, firstScanId: first } }));
      const info = await recordInfo(tx, rec.recordId);
      expect(info.scans.map((s) => [s.id, s.annulled])).toEqual([[second, false], [first, true]]);
      expect([info.firstScanDate, info.lastScanDate]).toEqual(['2026-10-16', '2026-10-16']);
      // Строка записи не менялась: first_scan_id по-прежнему аннулированный.
      expect((await tx.vulnRecord.findUniqueOrThrow({ where: { recordId: rec.recordId } })).firstScanId).toBe(first);
      // Срок: аннулированный скан не передан ИКТ, срок пойдёт от передачи второго.
      await scans.handOverScan(tx, x.actor, second, { date: '2026-10-20' });
      expect((await tx.vulnRecord.findUniqueOrThrow({ where: { recordId: rec.recordId } })).deadlineScanId).toBe(second);
    }));

  it('отказы: последний скан узла, переданный ИКТ, повторно, «Другое» без текста', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const n = await node(tx, x);
      const { first, second } = await twoScans(tx, x, n.id);
      await expectCode(annul.annulScan(tx, x.actor, second, { reason: 'reupload' }), 'SCAN_LAST');
      await expectCode(annul.annulScan(tx, x.actor, first, { reason: 'other', comment: '  ' }), 'REASON_REQUIRED');
      await scans.handOverScan(tx, x.actor, first, { date: '2026-10-20' });
      await expectCode(annul.annulScan(tx, x.actor, first, { reason: 'wrong_file' }), 'SCAN_HANDED_OVER');

      const n2 = await node(tx, x);
      const s2 = await twoScans(tx, x, n2.id);
      await annul.annulScan(tx, x.actor, s2.first, { reason: 'other', comment: 'Ошибочный выбор «Пропали»' });
      await expectCode(annul.annulScan(tx, x.actor, s2.first, { reason: 'reupload' }), 'SCAN_ANNULLED');
    }));

  it('следующий импорт: «прошлый скан» — неаннулированный', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const n = await node(tx, x);
      const { first, second } = await twoScans(tx, x, n.id);
      await annul.annulScan(tx, x.actor, first, { reason: 'reupload' });
      const p3 = await scan.previewNodeScan(tx, store, x.actor, n.id, SAMPLE, 'vuln-windows-2026-10-17.xlsx');
      expect(p3.summary.previousScan?.id).toBe(second);
      const a3 = await scan.applyNodeScan(tx, x.actor, p3.id, {});
      expect((await tx.vulnScan.findUniqueOrThrow({ where: { id: a3.scanId } })).previousScanId).toBe(second);
    }));

  it('корзина: аннулированный скан виден в разделе «Уязвимости»; восстановление — снова в списке и «ждут передачи»; при удалённом узле — 409', () =>
    inTx(async (tx) => {
      const x = await vulnRegister(tx);
      const n = await node(tx, x);
      const { first } = await twoScans(tx, x, n.id);
      const { deletionId } = await annul.annulScan(tx, x.actor, first, { reason: 'wrong_file' });
      const trash = await listDeletions(tx, { scope: 'vulns', nodeId: n.id });
      const item = must(trash.items.find((i) => i.id === deletionId));
      expect(item).toMatchObject({ entity: 'vuln_scan', entityLabel: 'Скан уязвимостей', vulns: true, reasonLabel: 'Ошибочный файл' });
      expect(item.title).toContain('Скан от 15.10.2026');

      // Узел удалён — сначала восстановить его.
      await tx.vulnNode.update({ where: { id: n.id }, data: { deletedAt: new Date() } });
      await expectCode(restoreDeletion(tx, x.actor, deletionId), 'PARENT_DELETED');
      await tx.vulnNode.update({ where: { id: n.id }, data: { deletedAt: null } });

      await restoreDeletion(tx, x.actor, deletionId);
      expect((await lastAudit(tx)).action).toBe('deletion.restored');
      expect((await scans.listScans(tx, n.id)).map((s) => s.id)).toContain(first);
      expect((await overview(tx)).awaiting.map((s) => s.id)).toContain(first);
      expect((await scans.getScan(tx, first)).annulment).toBeNull();
    }));
});

describe('аннулировать скан по HTTP', () => {
  it('без права data.delete — 403; с правом — 200; список узла с annulled=1 показывает отметку', () =>
    inTx(async (tx) => {
      const PASSWORD = 'Http-Annul-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const x = await vulnRegister(tx);
      const n = await node(tx, x);
      const { first } = await twoScans(tx, x, n.id);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const role = await tx.role.create({ data: { code: unique('annul').replace(/\s/g, '_'), name: unique('Удаление данных'), permissions: { create: [{ permissionCode: 'ib.work' }, { permissionCode: 'data.delete' }] } } });
      const deleter = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      await tx.userRole.create({ data: { userId: deleter.id, roleId: role.id } });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: store });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      };
      const url = `/api/v1/vulns/scans/${first}/annul`;
      const S = await login(staff.login);
      expect((await app.inject({ method: 'POST', url, headers: { cookie: S, origin: TEST_PORTAL_URL }, payload: { reason: 'reupload' } })).statusCode).toBe(403);
      const D = await login(deleter.login);
      const ok = await app.inject({ method: 'POST', url, headers: { cookie: D, origin: TEST_PORTAL_URL }, payload: { reason: 'reupload' } });
      expect(ok.statusCode).toBe(200);
      const list = await app.inject({ url: `/api/v1/vulns/nodes/${n.id}/scans?annulled=1`, headers: { cookie: S } });
      expect((list.json() as { items: { id: string; annulled: boolean }[] }).items.find((s) => s.id === first)?.annulled).toBe(true);
      await app.close();
    }));
});
