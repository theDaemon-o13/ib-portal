// Однократные шаги seed для конструктора реестров (отметки в seed_markers).
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

async function once(tx: Tx, key: string, fn: () => Promise<string>): Promise<void> {
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
}
