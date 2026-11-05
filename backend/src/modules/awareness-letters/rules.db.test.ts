// Правила расписания рассылок с настоящей БД (1.9.0, шаг 7a; docs/specs/awareness.md, раздел 19.1–19.4).
// Даты — 2041 год: производственного календаря на него нет, переносы задаёт сам тест.
import { describe, expect, it } from 'vitest';
import { SERVICE_ROLE_CODE } from '../../lib/work-users.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, roleId } from '../../test/db.js';
import * as rules from './rules.service.js';
import * as templates from './templates.service.js';
import { deleteRole, setRolePermission } from '../roles/service.js';

const NOW = new Date('2041-01-01T06:00:00Z');
const monthly5 = { kind: 'monthly', day: 5 } as const;

describe('правила расписания', () => {
  it('роль — только рабочая; опережение 7–90; периодичность проверяется; журнал', () =>
    inTx(async (tx) => {
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const ibStaff = await roleId(tx, 'ib_staff');
      const base = { title: 'Ежемесячная рассылка', cadence: monthly5, startsOn: '2041-01-01', roleId: ibStaff };
      for (const code of [SERVICE_ROLE_CODE, 'doc_reader', 'kiosk']) {
        await expectCode(rules.createRule(tx, staff, { ...base, roleId: await roleId(tx, code) }, NOW), 'BAD_ROLE');
      }
      await expectCode(rules.createRule(tx, staff, { ...base, leadDays: 6 }, NOW), 'BAD_LEAD_DAYS');
      await expectCode(rules.createRule(tx, staff, { ...base, leadDays: 91 }, NOW), 'BAD_LEAD_DAYS');
      await expectCode(rules.createRule(tx, staff, { ...base, cadence: { kind: 'twice_monthly', days: [3, 3] } }, NOW), 'BAD_CADENCE');
      await expectCode(rules.createRule(tx, staff, { ...base, title: ' ' }, NOW), 'TITLE_REQUIRED');

      const r = await rules.createRule(tx, staff, base, NOW);
      expect([r.leadDays, r.active, r.cadenceText, r.role.id, r.roleHolders > 0]).toEqual([10, true, 'ежемесячно, 5-го', ibStaff, true]);
      expect((await lastAudit(tx)).action).toBe('awareness_rule.created');

      const roles = await rules.listWorkRoles(tx);
      expect(roles.items.map((x) => x.id)).toContain(ibStaff);
      expect(roles.items.map((x) => x.id)).not.toContain(await roleId(tx, SERVICE_ROLE_CODE));
    }));

  it('ближайшие 6 дат: перенос на предыдущий рабочий день — выходной и праздник с названием', () =>
    inTx(async (tx) => {
      await tx.workCalendarDay.create({ data: { day: new Date('2041-02-05T00:00:00Z'), kind: 'holiday', title: 'Тестовый праздник' } });
      const p = await rules.previewForm(tx, { cadence: monthly5, startsOn: '2041-01-01' }, NOW);
      expect(p.dates).toEqual([
        { nominal: '2041-01-05', planned: '2041-01-04', shifted: true, reason: 'выходной' },
        { nominal: '2041-02-05', planned: '2041-02-04', shifted: true, reason: 'праздник: Тестовый праздник' },
        { nominal: '2041-03-05', planned: '2041-03-05', shifted: false, reason: null },
        { nominal: '2041-04-05', planned: '2041-04-05', shifted: false, reason: null },
        { nominal: '2041-05-05', planned: '2041-05-03', shifted: true, reason: 'выходной' },
        { nominal: '2041-06-05', planned: '2041-06-05', shifted: false, reason: null },
      ]);
      // Дата начала позже сегодня — даты не раньше неё.
      expect((await rules.previewForm(tx, { cadence: monthly5, startsOn: '2041-03-06' }, NOW)).dates[0]?.nominal).toBe('2041-04-05');
    }));

  it('правка с version: без изменений — без журнала; отключение; архивный шаблон — нельзя выбрать, но выбранный остаётся; архив', () =>
    inTx(async (tx) => {
      const staff = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const ibStaff = await roleId(tx, 'ib_staff');
      const { template: t } = await templates.createTemplate(tx, staff, { title: 'Шаблон правила', subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: '<p>Текст</p>', htmlTj: '<p>Матн</p>' });
      const base = { title: 'Ежемесячная', cadence: monthly5, startsOn: '2041-01-01', roleId: ibStaff, templateId: t.id };
      const r = await rules.createRule(tx, staff, base, NOW);
      const auditBefore = await tx.auditLog.count();
      const same = await rules.updateRule(tx, staff, r.id, { ...base, version: r.version }, NOW);
      expect([same.version, await tx.auditLog.count()]).toEqual([r.version, auditBefore]);

      const off = await rules.updateRule(tx, staff, r.id, { ...base, active: false, version: r.version }, NOW);
      expect([off.active, (await lastAudit(tx)).diff]).toMatchObject([false, { summary: 'Правило рассылки «Ежемесячная» отключено' }]);
      await expectCode(rules.updateRule(tx, staff, r.id, { ...base, version: r.version }, NOW), 'VERSION_CONFLICT');

      const archivedTpl = await templates.archiveTemplate(tx, staff, t.id, { version: t.version, archived: true });
      expect(archivedTpl.rules).toBe(1);
      await expectCode(rules.createRule(tx, staff, base, NOW), 'TEMPLATE_ARCHIVED');
      const kept = await rules.updateRule(tx, staff, r.id, { ...base, leadDays: 14, active: false, version: off.version }, NOW);
      expect([kept.leadDays, kept.template?.archived]).toEqual([14, true]);

      const arch = await rules.archiveRule(tx, staff, r.id, { version: kept.version, archived: true }, NOW);
      expect(arch.archived).toBe(true);
      await expectCode(rules.updateRule(tx, staff, r.id, { ...base, version: arch.version }, NOW), 'RULE_ARCHIVED');
      expect((await rules.listRules(tx, { scope: 'active' }, NOW)).items.map((x) => x.id)).not.toContain(r.id);
      expect((await rules.archiveRule(tx, staff, r.id, { version: arch.version, archived: false }, NOW)).archived).toBe(false);
    }));

  it('«Роли и права»: снять ib.work с роли активного правила можно — с предупреждением; удалить роль из правил — 409', () =>
    inTx(async (tx) => {
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      const role = await tx.role.create({ data: { name: 'Рассыльщики', permissions: { create: [{ permissionCode: 'ib.work' }] } } });
      const other = await tx.role.create({ data: { name: 'Без правил', permissions: { create: [{ permissionCode: 'ib.work' }] } } });
      const base = { cadence: monthly5, startsOn: '2041-01-01', roleId: role.id };
      await rules.createRule(tx, admin, { ...base, title: 'Активное' }, NOW);
      await rules.createRule(tx, admin, { ...base, title: 'Отключённое', active: false }, NOW);

      const res = await setRolePermission(tx, admin, role.id, 'ib.work', false);
      expect(res.permissions).not.toContain('ib.work');
      expect(res.warnings).toEqual(['Роль — исполнитель правил расписания рассылок: «Активное». Их задачи будут создаваться без кандидатов, с эскалацией начальнику ИБ. Выберите в правилах другую роль']);
      expect((await setRolePermission(tx, admin, other.id, 'ib.work', false)).warnings).toEqual([]);

      const fresh = await tx.role.findUniqueOrThrow({ where: { id: role.id } });
      await expectCode(deleteRole(tx, admin, role.id, fresh.version), 'ROLE_IN_RULES');
    }));
});
