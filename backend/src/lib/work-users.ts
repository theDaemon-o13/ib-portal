// Пользователи, участвующие в работе (релиз 1.8.0, ADR-0036): одна функция для всех списков выбора и получателей —
// исполнитель, проверяющий, ответственный цепочки, поле «сотрудник», руководитель, получатели автозадач, эскалаций и
// уведомлений, этапы документов, участники меток, владельцы в справочниках. Служебная учётная запись
// («Администратор портала») в работе не участвует никогда: её здесь нет, даже если состав прав нарушен.
import type { Prisma } from '../generated/prisma/client.js';
import type { Db } from './db.js';

/** Системный код служебной роли: определяет служебную учётную запись (без миграции, роль не переименовывается). */
export const SERVICE_ROLE_CODE = 'portal_admin';

const IB_WORK: Prisma.UserWhereInput = { roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } };
const NOT_SERVICE: Prisma.UserWhereInput = { NOT: { roles: { some: { role: { code: SERVICE_ROLE_CODE } } } } };

/**
 * Условие Prisma для пользователей, участвующих в работе: активный, не служебный; ibWork (по умолчанию) — с доступом
 * к разделам ИБ. ibWork: false — любой активный неслужебный (владелец системы в справочнике «Системы»).
 * active: false — без условия «активный»: роль сотрудника ИБ у отключённого (его руководитель и подчинённые сохраняются).
 */
export function workUsersWhere(opts: { ibWork?: boolean; active?: boolean } = {}): Prisma.UserWhereInput {
  return { AND: [...(opts.active === false ? [] : [{ isActive: true }]), NOT_SERVICE, ...(opts.ibWork === false ? [] : [IB_WORK])] };
}

/** Служебная ли учётная запись (по системному коду роли). */
export async function isServiceUser(db: Db, userId: string): Promise<boolean> {
  return (await db.userRole.count({ where: { userId, role: { code: SERVICE_ROLE_CODE } } })) > 0;
}

/** Есть ли служебная роль среди кодов ролей. */
export const hasServiceRole = (roleCodes: readonly (string | null)[]) => roleCodes.includes(SERVICE_ROLE_CODE);

/**
 * Роли, держатели которых участвуют в работе (1.9.0, ADR-0040): с правом ib.work, кроме служебной. Роль-исполнитель
 * правила рассылки выбирается только из них; держатели — через workUsersWhere() (служебные и отключённые отсекаются).
 */
export function workRolesWhere(): Prisma.RoleWhereInput {
  return {
    permissions: { some: { permissionCode: 'ib.work' } },
    OR: [{ code: null }, { code: { not: SERVICE_ROLE_CODE } }],
  };
}
