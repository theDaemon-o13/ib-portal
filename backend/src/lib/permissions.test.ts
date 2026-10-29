import { describe, expect, it } from 'vitest';
import { APPROVAL_PERMISSIONS, KIOSK_PERMISSION, PERMISSION_CODES, PERMISSION_GRANTS, SYSTEM_ROLES } from './permissions.js';

const role = (code: string): readonly string[] => SYSTEM_ROLES.find((r) => r.code === code)?.permissions ?? [];

describe('коды прав и системные роли', () => {
  it('коды уникальны', () => {
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
  });

  it('релиз 1.2.0: всё новое — «Начальник ИБ»; журнал и история — ещё «Супер-администратор»; «Сотрудник ИБ» — ничего', () => {
    const added = ['tasks.assign', 'tasks.review', 'tasks.status.override', 'tasks.report', 'docs.delete', 'history.view', 'audit.view'];
    for (const code of added) expect(PERMISSION_CODES).toContain(code);
    expect(role('ib_head')).toEqual(expect.arrayContaining(added));
    expect(role('super_admin')).toEqual(expect.arrayContaining(['history.view', 'audit.view']));
    expect(role('super_admin')).not.toContain('tasks.review');
    for (const code of added) expect(role('ib_staff')).not.toContain(code);
  });

  it('шаг обновления выдаёт ровно то, что новая установка получает в SYSTEM_ROLES', () => {
    for (const step of PERMISSION_GRANTS) {
      for (const [code, perms] of Object.entries(step.grants)) {
        expect(role(code)).toEqual(expect.arrayContaining([...(perms ?? [])]));
      }
    }
  });

  it('супер-администратор не получает права этапов согласования; киоск — только своё право', () => {
    for (const code of APPROVAL_PERMISSIONS) expect(role('super_admin')).not.toContain(code);
    expect(role('kiosk')).toEqual([KIOSK_PERMISSION]);
  });
});
