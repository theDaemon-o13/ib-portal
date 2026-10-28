import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, makeUser, must, permissionsOf } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as layout from './layout.service.js';

// Релиз 1.1.0, задача 5: раскладка дашборда — своя → роли → системная.

describe('раскладка дашборда', () => {
  it('seed: «Начальник ИБ» — сначала просроченное; сотрудник ИБ — системная', () =>
    inTx(async (tx) => {
      const head = await makeUser(tx, ['ib_staff', 'ib_head']);
      const staff = await makeUser(tx, ['ib_staff']);
      const h = await layout.myLayout(tx, head.id, new Set(await permissionsOf(tx, head.id)));
      expect(h).toMatchObject({ source: 'role', role: { name: 'Начальник ИБ' } });
      expect(h.items.slice(0, 4).map((i) => i.key)).toEqual(['kpi:vulns_overdue', 'kpi:tasks_overdue', 'kpi:risks_no_decision', 'kpi:docs_review']);
      const s = await layout.myLayout(tx, staff.id, new Set(await permissionsOf(tx, staff.id)));
      expect(s.source).toBe('system');
      expect(s.items[0]?.key).toBe('kpi:vulns_open');
    }));

  it('своя: сохранить, 409 по версии, «Сбросить» — снова роль; журнал', () =>
    inTx(async (tx) => {
      const user = await makeUser(tx, ['ib_staff', 'ib_head']);
      const actor = await actorFor(tx, user.id);
      const perms = new Set(await permissionsOf(tx, user.id));
      const start = await layout.myLayout(tx, user.id, perms);
      const items = [...start.items].reverse().map((i, n) => (n === 0 ? { ...i, hidden: true } : i));
      await expectCode(layout.saveMyLayout(tx, actor, perms, 3, items), 'VERSION_CONFLICT');
      const saved = await layout.saveMyLayout(tx, actor, perms, 0, items);
      expect(saved).toMatchObject({ source: 'user', version: 1 });
      expect(saved.items[0]).toMatchObject({ key: items[0]?.key, hidden: true });
      await expectCode(layout.saveMyLayout(tx, actor, perms, 0, items), 'VERSION_CONFLICT');
      await expectCode(layout.saveMyLayout(tx, actor, perms, 1, [{ key: 'widget:нет-такого', hidden: false, size: 's' }]), 'BAD_LAYOUT');

      const reset = await layout.resetMyLayout(tx, actor, perms);
      expect(reset.source).toBe('role');
      expect(await tx.dashboardLayout.count({ where: { userId: user.id } })).toBe(0);
      expect(await tx.auditLog.count({ where: { entityId: user.id, action: { in: ['dashboard.layout.saved', 'dashboard.layout.reset'] } } })).toBe(2);
    }));

  it('раскладка роли — settings.manage; настенному монитору — нельзя; по HTTP чужое не меняется', () =>
    inTx(async (tx) => {
      const admin = await makeUser(tx, ['super_admin', 'ib_staff']);
      const actor = await actorFor(tx, admin.id);
      const staffRole = await tx.role.findUniqueOrThrow({ where: { code: 'ib_staff' } });
      const kiosk = await tx.role.findUniqueOrThrow({ where: { code: 'kiosk' } });
      await expectCode(layout.getRoleLayout(tx, kiosk.id), 'NO_DASHBOARD');
      expect((await layout.roleLayouts(tx)).map((r) => r.id)).not.toContain(kiosk.id);
      const r = await layout.getRoleLayout(tx, staffRole.id);
      expect(r).toMatchObject({ custom: false, version: 0 });
      const items = r.items.map((i) => (i.key === 'kpi:vulns_open' ? { ...i, hidden: true } : i));
      expect((await layout.saveRoleLayout(tx, actor, staffRole.id, 0, items)).custom).toBe(true);
      const staff = await makeUser(tx, ['ib_staff']);
      const mine = await layout.myLayout(tx, staff.id, new Set(await permissionsOf(tx, staff.id)));
      expect(mine).toMatchObject({ source: 'role', role: { id: staffRole.id } });
      expect(must(mine.items.find((i) => i.key === 'kpi:vulns_open')).hidden).toBe(true);
      expect((await layout.resetRoleLayout(tx, actor, staffRole.id)).custom).toBe(false);

      const PASSWORD = 'Http-Layout-Pass-2026';
      const hash = await argon2Hasher.hash(PASSWORD);
      const s2 = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL });
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: s2.login, password: PASSWORD } });
      const cookie = `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`;
      expect((await app.inject({ url: `/api/v1/dashboard/role-layouts/${staffRole.id}`, headers: { cookie } })).statusCode).toBe(403);
      const got = await app.inject({ url: '/api/v1/dashboard/layout', headers: { cookie } });
      expect(got.json()).toMatchObject({ source: 'system', version: 0 });
      const put = await app.inject({ method: 'PUT', url: '/api/v1/dashboard/layout', headers: { cookie }, payload: { version: 0, items: got.json().items } });
      expect(put.json()).toMatchObject({ source: 'user', version: 1 });
      // Свою раскладку видит и меняет только сам пользователь: у другого — прежняя.
      expect((await layout.myLayout(tx, staff.id, new Set(await permissionsOf(tx, staff.id)))).source).toBe('system');
    }));
});
