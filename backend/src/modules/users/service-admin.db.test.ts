// Служебная роль «Администратор портала» (релиз 1.8.0, ADR-0036): нет ни в одном списке «кто работает», не совмещается
// с другими ролями, роль не меняется, видит настройки и не видит данных банка, действия — в журнале, последнего
// держателя users.manage не лишить права, действия с доступом — в индикаторе держателей audit.view.
// Люди вымышленные. Каждый тест — в транзакции с откатом.
import { describe, expect, it } from 'vitest';
import type { User } from '../../generated/prisma/client.js';
import { buildApp } from '../../app.js';
import { reviewerFor } from '../../lib/hierarchy.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { SERVICE_ROLE_CODE, workUsersWhere } from '../../lib/work-users.js';
import { actorFor, expectCode, inTx, makeUser, roleId, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { attentionOf } from '../attention/service.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { recipientChoices } from '../automations/service.js';
import { createItem } from '../catalogs/service.js';
import { assignableUsers } from '../registers/definition.js';
import { setRolePermission, updateRole } from '../roles/service.js';
import * as chains from '../tasks/chains.js';
import * as tasks from '../tasks/service.js';
import { createUser, resetPassword, setIbHead, updateUser, userOptions } from './service.js';

const PASSWORD = 'Service-Admin-Test-2026';

async function setup(tx: Tx) {
  const hash = await argon2Hasher.hash(PASSWORD);
  const svc = await makeUser(tx, [SERVICE_ROLE_CODE], { fullName: 'Администратор Портала Тестов', passwordHash: hash });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Иванов И.И.', passwordHash: hash });
  const auditor = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Сидорова С.С.', passwordHash: hash });
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  return { svc, staff, auditor, project, a: { svc: await actorFor(tx, svc.id), staff: await actorFor(tx, staff.id), auditor: await actorFor(tx, auditor.id) } };
}

describe('служебная роль «Администратор портала» (1.8.0)', () => {
  it('нет ни в одном списке участвующих в работе', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const ids = (list: { id: string }[]) => list.map((u) => u.id);
      expect(x.a.svc.perms.has('ib.work')).toBe(false);
      // Списки выбора: сотрудники ИБ и все активные (владелец системы).
      expect(ids(await userOptions(tx, 'ib'))).not.toContain(x.svc.id);
      expect(ids(await userOptions(tx, 'all'))).not.toContain(x.svc.id);
      expect(ids(await userOptions(tx, 'all'))).toContain(x.staff.id);
      expect(await tx.user.count({ where: { id: x.svc.id, ...workUsersWhere({ ibWork: false }) } })).toBe(0);
      // Поле «сотрудник», получатели автоматизаций.
      expect([...(await assignableUsers(tx)).keys()]).not.toContain(x.svc.id);
      expect([...(await recipientChoices(tx)).users.keys()]).not.toContain(x.svc.id);
      // Исполнитель задачи и ответственный цепочки.
      await expectCode(tasks.createTask(tx, x.a.auditor, { title: 'Тестовая задача', categoryId: x.project.id, assigneeId: x.svc.id }), 'BAD_ASSIGNEE');
      const t = await tasks.createTask(tx, x.a.staff, { title: 'Тестовая задача', categoryId: x.project.id });
      const c = await chains.createChain(tx, x.a.staff, { title: 'Тестовая тема', tasks: [{ id: t.id, version: t.version }] });
      await expectCode(chains.updateChain(tx, x.a.staff, c.id, { version: c.version, ownerId: x.svc.id }), 'BAD_ASSIGNEE');
      // Руководитель и проверяющий: назначить нельзя, а прописанный в обход — не проверяет.
      await expectCode(updateUser(tx, x.a.auditor, x.staff.id, { version: x.staff.version, managerId: x.svc.id }), 'MANAGER_NOT_IB');
      await tx.user.update({ where: { id: x.staff.id }, data: { managerId: x.svc.id } });
      expect(await reviewerFor(tx, x.staff.id)).toBeNull();
      // Отметка «Начальник ИБ», участники меток получателей, владелец системы.
      await expectCode(setIbHead(tx, x.a.auditor, x.svc.id, { version: x.svc.version, value: true }), 'IB_HEAD_NOT_IB');
      await expectCode(createItem(tx, x.a.auditor, 'notify_recipients', { value: 'Тестовая метка', memberIds: [x.svc.id] }), 'NOT_IB_USER');
      await expectCode(createItem(tx, x.a.auditor, 'systems', { value: 'Тестовая система', ownerUserId: x.svc.id }), 'BAD_OWNER');
      // Индикаторы — нули.
      expect(await attentionOf(tx, x.a.svc)).toEqual({ tasks: 0, documents: 0, audit: 0, total: 0 });
    }));

  it('не совмещается с другими ролями; роль не переименовать и не изменить её права', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const staffRole = await roleId(tx, 'ib_staff');
      const serviceRole = await roleId(tx, SERVICE_ROLE_CODE);
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      await expectCode(updateUser(tx, admin, x.svc.id, { version: x.svc.version, roleIds: [serviceRole, staffRole] }), 'SERVICE_ROLE_EXCLUSIVE');
      await expectCode(updateUser(tx, admin, x.staff.id, { version: x.staff.version, roleIds: [staffRole, serviceRole] }), 'SERVICE_ROLE_EXCLUSIVE');
      await expectCode(createUser(tx, admin, argon2Hasher, { login: 'svc.mixed', fullName: 'Петров П.П.', position: '', department: '', roleIds: [serviceRole, staffRole] }), 'SERVICE_ROLE_EXCLUSIVE');
      const role = await tx.role.findUniqueOrThrow({ where: { id: serviceRole } });
      await expectCode(updateRole(tx, admin, serviceRole, { version: role.version, name: 'Другое название' }), 'SERVICE_ROLE_LOCKED');
      await expectCode(setRolePermission(tx, admin, serviceRole, 'ib.work', true), 'SERVICE_ROLE_LOCKED');
      await expectCode(setRolePermission(tx, admin, serviceRole, 'users.manage', false), 'SERVICE_ROLE_LOCKED');
    }));

  it('правка отключённого сотрудника ИБ не снимает его руководителя и не мешает подчинённым (как до 1.8.0)', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const lead = await makeUser(tx, ['ib_staff'], { fullName: 'Петров П.П.', manager: { connect: { id: x.auditor.id } } });
      await makeUser(tx, ['ib_staff'], { fullName: 'Кузнецов К.К.', manager: { connect: { id: lead.id } } });
      await tx.user.update({ where: { id: lead.id }, data: { isActive: false } });
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: lead.id } });
      await updateUser(tx, x.a.svc, lead.id, { version: fresh.version, fullName: 'Петров Пётр Петрович' });
      const after = await tx.user.findUniqueOrThrow({ where: { id: lead.id } });
      expect(after.fullName).toBe('Петров Пётр Петрович');
      expect(after.managerId).toBe(x.auditor.id);
    }));

  it('последнего держателя users.manage — служебного — не лишить права', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      // Других держателей users.manage в транзакции нет: снимаем право у всех, кроме служебного.
      const others = await tx.user.findMany({ where: { id: { not: x.svc.id }, roles: { some: { role: { permissions: { some: { permissionCode: 'users.manage' } } } } } } });
      for (const u of others) await tx.user.update({ where: { id: u.id }, data: { isActive: false } });
      await expectCode(updateUser(tx, x.a.svc, x.svc.id, { version: x.svc.version, roleIds: [] }), 'LAST_USERS_MANAGE');
    }));

  it('действия с доступом (роль, права роли, сброс пароля) — в журнале и в индикаторе держателей audit.view; обычного — нет', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const staffRole = await roleId(tx, 'ib_staff');
      const socRole = await roleId(tx, 'soc');
      const before = (await attentionOf(tx, x.a.auditor)).audit;
      await updateUser(tx, x.a.svc, x.staff.id, { version: x.staff.version, roleIds: [staffRole, socRole] });
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: x.staff.id } });
      await resetPassword(tx, x.a.svc, argon2Hasher, x.staff.id, fresh.version);
      await setRolePermission(tx, x.a.svc, socRole, 'tasks.report', true);
      const att = await attentionOf(tx, x.a.auditor);
      expect(att.audit - before).toBe(3);
      expect(att.total).toBeGreaterThanOrEqual(att.audit);
      const notes = await tx.notification.findMany({ where: { userId: x.auditor.id, kind: 'service_admin_action' }, orderBy: { createdAt: 'asc' } });
      expect(notes.map((n) => n.actorId)).toEqual([x.svc.id, x.svc.id, x.svc.id]);
      expect(notes[1]?.title).toMatch(/сброшен пароль/);
      // Журнал: действия служебного — с его user_id.
      const log = await tx.auditLog.findMany({ where: { userId: x.svc.id }, select: { action: true } });
      expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['user.updated', 'user.password_reset', 'role.permission.granted']));
      // Те же действия обычного администратора — без записи в индикаторе.
      const admin = await makeUser(tx, ['super_admin']);
      await setRolePermission(tx, await actorFor(tx, admin.id), socRole, 'tasks.report', false);
      expect((await attentionOf(tx, x.a.auditor)).audit - before).toBe(3);
    }));

  it('по HTTP: настройки и справочники — да; задачи, реестры, документы, поиск, «Ответственные лица» — 403 SERVICE_ACCOUNT', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: false,
      });
      const login = async (u: User) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u.login, password: PASSWORD } });
        expect(res.statusCode).toBe(200);
        return { cookie: `ib_session=${res.cookies.find((c) => c.name === 'ib_session')?.value}`, origin: TEST_PORTAL_URL };
      };
      const S = await login(x.svc);
      const me = await app.inject({ url: '/api/v1/auth/me', headers: S });
      expect((me.json() as { user: { service: boolean; permissions: string[] } }).user).toMatchObject({ service: true, permissions: ['settings.manage', 'users.manage'] });
      for (const url of ['/api/v1/users', '/api/v1/roles', '/api/v1/permissions', '/api/v1/users/options', '/api/v1/catalogs', '/api/v1/catalogs/systems/items?archived=true',
        '/api/v1/form-templates', '/api/v1/calendar/week', '/api/v1/me/attention', '/api/v1/notifications', '/api/v1/settings/presentation']) {
        expect((await app.inject({ url, headers: S })).statusCode, url).toBe(200);
      }
      for (const url of ['/api/v1/tasks', '/api/v1/task-chains', '/api/v1/registers', '/api/v1/documents', '/api/v1/search?q=тест', '/api/v1/evidence',
        '/api/v1/settings/party-directory', '/api/v1/settings/portal-params', '/api/v1/dashboard/role-layouts', '/api/v1/audit']) {
        const res = await app.inject({ url, headers: S });
        expect(res.statusCode, url).toBe(403);
        expect((res.json() as { error: { code: string } }).error.code, url).toBe('SERVICE_ACCOUNT');
      }
      // Действие в настройках — в журнале с его именем.
      const created = await app.inject({ method: 'POST', url: '/api/v1/catalogs/task_categories/items', headers: S, payload: { value: 'Тестовая категория служебного' } });
      expect(created.statusCode, created.body).toBeLessThan(300);
      const last = await tx.auditLog.findFirstOrThrow({ where: { userId: x.svc.id }, orderBy: { id: 'desc' } });
      expect(last.action).toMatch(/^catalog\./);
      await app.close();
    }));
});
