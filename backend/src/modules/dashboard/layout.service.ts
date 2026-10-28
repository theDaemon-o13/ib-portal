// Раскладка дашборда (релиз 1.1.0, задача 5, ADR-0018): своя → роли → системная.
// Своя — правит сам пользователь (ib.work), «Сбросить» удаляет строку физически (настройка интерфейса).
// Раскладка роли по умолчанию — settings.manage. Элементы без права пользователя не отдаются.
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, notFound, versionConflict } from '../../lib/errors.js';
import type { PermissionCode } from '../../lib/permissions.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { checkLayout, mergeLayout, type LayoutElement, type LayoutItem } from './layout.js';
import { DASHBOARD_KPIS, listWidgets } from './service.js';
import { listTiles } from './tiles.service.js';

/** Виджеты сроков и дат — половина ширины, остальные — треть (как было до настройки). */
const WIDE_KINDS = new Set(['deadline', 'timeline', 'basis']);

/** Всё, что сейчас есть на дашборде, — в системном порядке (KPI, плитки, виджеты). */
export async function dashboardElements(db: Db): Promise<LayoutElement[]> {
  const tiles = (await listTiles(db)).filter((t) => !t.broken);
  const widgets = await listWidgets(db);
  return [
    ...DASHBOARD_KPIS.map((k) => ({ key: `kpi:${k}`, defaultSize: 's' as const, fixedSize: true, perm: 'ib.work' as PermissionCode })),
    ...tiles.map((t) => ({ key: `tile:${t.id}`, defaultSize: 's' as const, fixedSize: false, perm: 'ib.work' as PermissionCode })),
    ...widgets.map((w) => ({ key: `widget:${w.key}`, defaultSize: WIDE_KINDS.has(w.kind) ? 'm' as const : 's' as const, fixedSize: false, perm: 'ib.work' as PermissionCode })),
  ];
}

const visibleTo = (elements: LayoutElement[], perms: ReadonlySet<string>) => elements.filter((e) => perms.has(e.perm));

export interface LayoutDto {
  /** Чья раскладка действует: своя, роли или системная. */
  source: 'user' | 'role' | 'system';
  /** Роль, чья раскладка действует (source = role). */
  role: { id: string; name: string } | null;
  /** Версия своей раскладки (0 — своей нет). */
  version: number;
  items: LayoutItem[];
}

/** Раскладка пользователя: своя, иначе первой его роли с раскладкой (в порядке ролей), иначе системная. */
export async function myLayout(db: Db, userId: string, perms: ReadonlySet<string>): Promise<LayoutDto> {
  const elements = visibleTo(await dashboardElements(db), perms);
  const own = await db.dashboardLayout.findUnique({ where: { userId } });
  if (own) return { source: 'user', role: null, version: own.version, items: mergeLayout(own.items, elements) };
  const roles = await db.userRole.findMany({ where: { userId }, include: { role: { include: { dashboardLayout: true } } }, orderBy: { role: { createdAt: 'asc' } } });
  const withLayout = roles.find((r) => r.role.dashboardLayout);
  if (withLayout?.role.dashboardLayout) {
    return { source: 'role', role: { id: withLayout.role.id, name: withLayout.role.name }, version: 0, items: mergeLayout(withLayout.role.dashboardLayout.items, elements) };
  }
  return { source: 'system', role: null, version: 0, items: mergeLayout(null, elements) };
}

type ItemsIn = { key: string; hidden: boolean; size: string }[];

const hiddenCount = (items: LayoutItem[]) => items.filter((i) => i.hidden).length;

export async function saveMyLayout(db: Db, actor: Actor, perms: ReadonlySet<string>, version: number, input: ItemsIn): Promise<LayoutDto> {
  const items = checkLayout(input, visibleTo(await dashboardElements(db), perms));
  await withTx(db, async (tx) => {
    const own = await tx.dashboardLayout.findUnique({ where: { userId: actor.id } });
    if (own) {
      const res = await tx.dashboardLayout.updateMany({ where: { id: own.id, version }, data: { items: items as unknown as Prisma.InputJsonValue, updatedBy: actor.id, version: { increment: 1 } } });
      if (!res.count) throw versionConflict();
    } else {
      if (version !== 0) throw versionConflict();
      await tx.dashboardLayout.create({ data: { userId: actor.id, items: items as unknown as Prisma.InputJsonValue, updatedBy: actor.id } });
    }
    await auditSettings(tx, actor, {
      action: 'dashboard.layout.saved', entity: 'dashboard_layout', entityId: actor.id,
      summary: `Своя раскладка дашборда: элементов ${items.length}, скрыто ${hiddenCount(items)}`,
      after: { items },
    });
  });
  return myLayout(db, actor.id, perms);
}

/** «Сбросить»: своя раскладка удаляется физически (настройка интерфейса), снова действует раскладка роли или системная. */
export async function resetMyLayout(db: Db, actor: Actor, perms: ReadonlySet<string>): Promise<LayoutDto> {
  await withTx(db, async (tx) => {
    const own = await tx.dashboardLayout.findUnique({ where: { userId: actor.id } });
    if (!own) return;
    await tx.dashboardLayout.delete({ where: { id: own.id } });
    await auditSettings(tx, actor, {
      action: 'dashboard.layout.reset', entity: 'dashboard_layout', entityId: actor.id,
      summary: 'Своя раскладка дашборда сброшена', before: { items: own.items },
    });
  });
  return myLayout(db, actor.id, perms);
}

// ---------------------------------------------------------------- раскладки ролей (settings.manage)

/**
 * Роли, которым можно задать раскладку по умолчанию, — все, кроме настенного монитора: роль без ib.work
 * («Начальник ИБ» — только согласование) задаёт раскладку тем, кто видит дашборд через другую свою роль.
 */
export async function roleLayouts(db: Db) {
  const roles = await db.role.findMany({
    where: { permissions: { none: { permissionCode: 'monitor.kiosk' } } },
    include: { dashboardLayout: { select: { id: true } } }, orderBy: { createdAt: 'asc' },
  });
  return roles.map((r) => ({ id: r.id, name: r.name, hasLayout: !!r.dashboardLayout }));
}

async function roleOrThrow(db: Db, roleId: string) {
  const role = await db.role.findUnique({ where: { id: roleId }, include: { dashboardLayout: true, permissions: true } });
  if (!role) throw notFound('Роль');
  if (role.permissions.some((p) => p.permissionCode === 'monitor.kiosk')) throw badRequest('NO_DASHBOARD', `Роль «${role.name}» — настенный монитор: дашборда у неё нет`);
  return role;
}

/** Раскладка роли — для всех, кто видит дашборд: элементы по праву ib.work (права самой роли не важны). */
const rolePerms = () => new Set<string>(['ib.work']);

export async function getRoleLayout(db: Db, roleId: string) {
  const role = await roleOrThrow(db, roleId);
  const elements = visibleTo(await dashboardElements(db), rolePerms());
  return { role: { id: role.id, name: role.name }, version: role.dashboardLayout?.version ?? 0, custom: !!role.dashboardLayout, items: mergeLayout(role.dashboardLayout?.items ?? null, elements) };
}

export async function saveRoleLayout(db: Db, actor: Actor, roleId: string, version: number, input: ItemsIn) {
  const role = await roleOrThrow(db, roleId);
  const items = checkLayout(input, visibleTo(await dashboardElements(db), rolePerms()));
  await withTx(db, async (tx) => {
    const row = role.dashboardLayout;
    if (row) {
      const res = await tx.dashboardLayout.updateMany({ where: { id: row.id, version }, data: { items: items as unknown as Prisma.InputJsonValue, updatedBy: actor.id, version: { increment: 1 } } });
      if (!res.count) throw versionConflict();
    } else {
      if (version !== 0) throw versionConflict();
      await tx.dashboardLayout.create({ data: { roleId, items: items as unknown as Prisma.InputJsonValue, updatedBy: actor.id } });
    }
    await auditSettings(tx, actor, {
      action: 'dashboard.role_layout.saved', entity: 'dashboard_layout', entityId: roleId,
      summary: `Раскладка дашборда по умолчанию для роли «${role.name}»: элементов ${items.length}, скрыто ${hiddenCount(items)}`,
      before: { items: row?.items ?? null }, after: { items },
    });
  });
  return getRoleLayout(db, roleId);
}

export async function resetRoleLayout(db: Db, actor: Actor, roleId: string) {
  const role = await roleOrThrow(db, roleId);
  if (role.dashboardLayout) {
    await withTx(db, async (tx) => {
      await tx.dashboardLayout.delete({ where: { id: role.dashboardLayout?.id } });
      await auditSettings(tx, actor, {
        action: 'dashboard.role_layout.reset', entity: 'dashboard_layout', entityId: roleId,
        summary: `Раскладка дашборда по умолчанию для роли «${role.name}» сброшена — действует системная`,
        before: { items: role.dashboardLayout?.items ?? null },
      });
    });
  }
  return getRoleLayout(db, roleId);
}
