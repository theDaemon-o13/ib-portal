// Однократные шаги seed для конструктора реестров (отметки в seed_markers).
import type { Prisma } from '../../src/generated/prisma/client.js';
import { INCIDENT_DATE_KEY, INCIDENT_REGISTER_KEY } from '../../src/modules/dashboard/incidents.js';

type Tx = Prisma.TransactionClient;

export async function once(tx: Tx, key: string, fn: () => Promise<string>): Promise<void> {
  if (await tx.seedMarker.findUnique({ where: { key } })) return;
  const summary = await fn();
  await tx.seedMarker.create({ data: { key } });
  console.log(summary);
}

type FieldDef = {
  label: string;
  type: 'text' | 'select' | 'date' | 'user';
  isTitle?: boolean;
  isStatus?: boolean;
  analyticsRole?: 'dimension' | 'date';
  options?: string[];
  closed?: string[];
};

/** Структура «Реестра инцидентов» из прототипа, без записей. */
const INCIDENTS: { name: string; description: string; fields: FieldDef[] } = {
  name: 'Реестр инцидентов',
  description: 'Инциденты информационной безопасности',
  fields: [
    { label: 'Инцидент', type: 'text', isTitle: true },
    { label: 'Тип', type: 'select', analyticsRole: 'dimension', options: ['Фишинг', 'Вредоносное ПО', 'Утечка данных', 'Несанкц. доступ', 'DDoS'] },
    { label: 'Уровень', type: 'select', analyticsRole: 'dimension', options: ['Высокий', 'Средний', 'Низкий'] },
    { label: 'Дата выявления', type: 'date', analyticsRole: 'date' },
    { label: 'Статус', type: 'select', isStatus: true, analyticsRole: 'dimension', options: ['Новый', 'Расследование', 'Закрыт'], closed: ['Закрыт'] },
    { label: 'Ответственный', type: 'user' },
  ],
};

export async function seedRegisters(tx: Tx): Promise<void> {
  // На уже установленных порталах роль «Супер-администратор» получает новое право один раз;
  // дальше состав роли меняет только администратор в матрице прав.
  await once(tx, 'grant.super_admin.registers_manage.v1', async () => {
    const role = await tx.role.findUniqueOrThrow({ where: { code: 'super_admin' } });
    const res = await tx.rolePermission.createMany({
      data: [{ roleId: role.id, permissionCode: 'registers.manage' }],
      skipDuplicates: true,
    });
    return `Право registers.manage выдано роли «${role.name}»: ${res.count ? 'да' : 'уже было'}`;
  });

  await once(tx, 'starter.register.incidents.v1', async () => {
    const clash = await tx.register.findFirst({
      where: { archivedAt: null, name: { equals: INCIDENTS.name, mode: 'insensitive' } },
    });
    if (clash) return `«${INCIDENTS.name}» уже есть — стартовый реестр не создан`;
    const reg = await tx.register.create({ data: { name: INCIDENTS.name, description: INCIDENTS.description } });
    for (const [i, f] of INCIDENTS.fields.entries()) {
      await tx.registerField.create({
        data: {
          registerId: reg.id,
          label: f.label,
          type: f.type,
          sortOrder: i + 1,
          isTitle: f.isTitle ?? false,
          isStatus: f.isStatus ?? false,
          analyticsRole: f.analyticsRole ?? null,
          options: f.options
            ? { create: f.options.map((label, j) => ({ label, sortOrder: j + 1, isClosed: f.closed?.includes(label) ?? false })) }
            : undefined,
        },
      });
    }
    return `Стартовый реестр «${INCIDENTS.name}»: полей ${INCIDENTS.fields.length}`;
  });

  // Этап 8: стартовый реестр инцидентов — системный (KPI «Инциденты за 30 дней»). Один раз; если реестр
  // удалён, архивирован или переименован администратором — не трогаем, KPI покажет «не настроен».
  await once(tx, 'system.register.incidents.v1', async () => {
    if (await tx.register.findUnique({ where: { systemKey: INCIDENT_REGISTER_KEY } })) return 'Реестр инцидентов уже системный';
    const candidates = await tx.register.findMany({
      where: { systemKey: null, archivedAt: null, name: { equals: INCIDENTS.name, mode: 'insensitive' } },
      include: { fields: { where: { label: 'Дата выявления', type: 'date', deletedAt: null, archivedAt: null } } },
    });
    const reg = candidates.length === 1 ? candidates[0] : undefined;
    const date = reg?.fields.length === 1 ? reg.fields[0] : undefined;
    if (!reg || !date) return `«${INCIDENTS.name}» с полем «Дата выявления» не найден — KPI «Инциденты за 30 дней» не настроен`;
    await tx.register.update({ where: { id: reg.id }, data: { systemKey: INCIDENT_REGISTER_KEY, version: { increment: 1 } } });
    await tx.registerField.update({ where: { id: date.id }, data: { systemKey: INCIDENT_DATE_KEY, version: { increment: 1 } } });
    return `«${reg.name}» — системный реестр (KPI «Инциденты за 30 дней»), поле «${date.label}» — системное`;
  });
}

/**
 * Релиз 1.1.0, задача 4: ключ импорта — ключ сравнения по умолчанию. Миграция register_compare_settings
 * переносит его в существующей базе; при установке с нуля реестры с ключом импорта (устройства DLP) создаёт
 * seed после миграций — тот же перенос здесь. Однократно; заданный ключ сравнения не трогается.
 */
export async function seedCompareKeys(tx: Tx): Promise<void> {
  await once(tx, 'registers.compare-key-from-import-key.v1', async () => {
    const keys = await tx.registerField.findMany({ where: { isImportKey: true, deletedAt: null }, select: { id: true, registerId: true } });
    const done: string[] = [];
    for (const k of keys) {
      const reg = await tx.register.findUnique({ where: { id: k.registerId }, select: { name: true, compareKeyFieldIds: true } });
      if (!reg || reg.compareKeyFieldIds.length) continue;
      await tx.register.update({ where: { id: k.registerId }, data: { compareKeyFieldIds: [k.id], version: { increment: 1 } } });
      await tx.auditLog.create({
        data: {
          userId: null, action: 'register.updated', entity: 'register', entityId: k.registerId,
          diff: { summary: `Seed 1.1.0: «${reg.name}» — ключ сравнения = ключ импорта`, before: { compareKeyFieldIds: [] }, after: { compareKeyFieldIds: [k.id] } },
        },
      });
      done.push(`«${reg.name}»`);
    }
    return done.length ? `Ключ сравнения из ключа импорта: ${done.join(', ')}` : 'Ключ сравнения: переносить нечего';
  });
}
