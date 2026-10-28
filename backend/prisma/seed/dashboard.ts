// Релиз 1.1.0, задача 5: раскладка дашборда по умолчанию для роли «Начальник ИБ» (однократно, seed_markers).
// Остальные роли с ib.work («Сотрудник ИБ», «Супер-администратор») — системная раскладка, строки не нужны.
// Дальше раскладки ролей меняет администратор (settings.manage); удалённую или изменённую seed не восстанавливает.
import type { Prisma } from '../../src/generated/prisma/client.js';
import { HEAD_FIRST_KPIS, mergeLayout } from '../../src/modules/dashboard/layout.js';
import { dashboardElements } from '../../src/modules/dashboard/layout.service.js';
import { listWidgets } from '../../src/modules/dashboard/service.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

export async function seedDashboardLayouts(tx: Tx): Promise<void> {
  await once(tx, 'dashboard.role-layouts.v1', async () => {
    const role = await tx.role.findUnique({ where: { code: 'ib_head' }, include: { dashboardLayout: true } });
    if (!role) return 'Роли «Начальник ИБ» нет — раскладка не нужна';
    if (role.dashboardLayout) return `«${role.name}»: раскладка дашборда уже задана`;
    const deadlines = (await listWidgets(tx)).filter((w) => w.kind === 'deadline').map((w) => `widget:${w.key}`);
    // Сначала просроченное и требующее решения, остальное — в системном порядке; виджеты сроков — во всю ширину.
    const items = mergeLayout([
      ...HEAD_FIRST_KPIS.map((k) => ({ key: `kpi:${k}`, hidden: false, size: 's' })),
      ...deadlines.map((key) => ({ key, hidden: false, size: 'l' })),
    ], await dashboardElements(tx));
    const kpis = items.filter((i) => i.key.startsWith('kpi:'));
    const rest = items.filter((i) => !i.key.startsWith('kpi:'));
    await tx.dashboardLayout.create({ data: { roleId: role.id, items: [...kpis, ...rest] as unknown as Prisma.InputJsonValue } });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'dashboard.role_layout.saved', entity: 'dashboard_layout', entityId: role.id,
        diff: { summary: `Seed 1.1.0: раскладка дашборда по умолчанию для роли «${role.name}» — сначала просроченное и требующее решения` },
      },
    });
    return `«${role.name}»: раскладка дашборда по умолчанию`;
  });
}
