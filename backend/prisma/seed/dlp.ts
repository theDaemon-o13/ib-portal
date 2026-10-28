// Однократно (отметка в seed_markers): стартовые несистемные реестры «Устройства DLP» и «Разрешения на доступ»
// (этап 8б, docs/concept.md п. 10, ADR-0013) с полями, фиксацией, статусом основания, автоматизациями и плитками,
// метка получателей «Разрешения DLP» и правило разбора почты «Разрешения» (выше правила «Доступ»).
// Удалённое или изменённое администратором seed не восстанавливает.
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { BasisRule } from '../../src/lib/link-basis.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

export const DEVICES_NAME = 'Устройства DLP';
export const PERMISSIONS_NAME = 'Разрешения на доступ';
export const DLP_LABEL = 'Разрешения DLP';
export const MAIL_RULE = 'Разрешения';
export const MAIL_KEYWORDS = ['telegram', 'телеграм', 'whatsapp', 'ватсап', 'облако', 'vpn', 'впн', 'удалённ'];

interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'select' | 'date' | 'link' | 'file';
  options?: string[];
  closed?: string[];
  isTitle?: boolean;
  isStatus?: boolean;
  isImportKey?: boolean;
  analyticsRole?: 'dimension' | 'deadline';
}

/** Название, свободное от реестров администратора (как у системных реестров). */
async function freeName(tx: Tx, name: string): Promise<string> {
  const clash = await tx.register.findFirst({ where: { archivedAt: null, name: { equals: name, mode: 'insensitive' } } });
  return clash ? `${name} (стартовый)` : name;
}

async function createRegister(tx: Tx, name: string, description: string, specs: FieldSpec[], extra: (key: string) => Partial<Prisma.RegisterFieldUncheckedCreateInput> = () => ({})) {
  const reg = await tx.register.create({ data: { name: await freeName(tx, name), description } });
  const fields: Record<string, { id: string; options: Record<string, string> }> = {};
  for (const [i, f] of specs.entries()) {
    const created = await tx.registerField.create({
      data: {
        registerId: reg.id, label: f.label, type: f.type, sortOrder: i + 1,
        isTitle: f.isTitle ?? false, isStatus: f.isStatus ?? false, isImportKey: f.isImportKey ?? false, analyticsRole: f.analyticsRole ?? null,
        options: f.options?.length ? { create: f.options.map((label, j) => ({ label, sortOrder: j + 1, isClosed: f.closed?.includes(label) ?? false })) } : undefined,
        ...extra(f.key),
      },
      include: { options: true },
    });
    fields[f.key] = { id: created.id, options: Object.fromEntries(created.options.map((o) => [o.label, o.id])) };
  }
  return { reg, fields };
}

const SOC = ['Запрещены', 'Разрешён Telegram', 'Разрешён WhatsApp', 'Разрешены Telegram и WhatsApp'];
const CLOUD = ['Запрещены', 'Только чтение', 'Разрешены'];
const USB = ['Запрещён', 'Только чтение', 'Белый список устройств', 'Разрешён'];
const KINDS = ['Соцсети и мессенджеры', 'Облачные хранилища', 'Удалённый доступ (VPN)'];
const PERMISSION_STATUSES = ['Оформляется', 'Действует', 'Истекло', 'Отозвано'];
const LOCKING = ['Действует', 'Истекло', 'Отозвано'];

export async function seedDlp(tx: Tx): Promise<void> {
  await once(tx, 'starter.dlp_permissions.v1', async () => {
    // Метка получателей: участников назначает администратор (сотрудники ИБ).
    let label = await tx.catalogItem.findFirst({ where: { catalogCode: 'notify_recipients', deletedAt: null, value: { equals: DLP_LABEL, mode: 'insensitive' } } });
    if (!label) {
      const max = await tx.catalogItem.aggregate({ where: { catalogCode: 'notify_recipients' }, _max: { sortOrder: true } });
      label = await tx.catalogItem.create({ data: { catalogCode: 'notify_recipients', value: DLP_LABEL, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
    }
    const recipients = [{ kind: 'label', itemId: label.id }];

    // 1. Устройства (без полей основания: им нужен реестр разрешений).
    const dev = await createRegister(tx, DEVICES_NAME,
      'Агенты InfoWatch Device Monitor: доступы по каналам. Данные — выгрузка Device Monitor в Excel, импорт по ключу «Имя хоста». '
      + 'Статус основания по каналу сверяется с действующими разрешениями на это устройство', [
        { key: 'host', label: 'Имя хоста', type: 'text', isTitle: true, isImportKey: true },
        { key: 'ip', label: 'IP-адрес', type: 'text' },
        { key: 'employee', label: 'Сотрудник', type: 'text' },
        { key: 'dept', label: 'Подразделение', type: 'select', analyticsRole: 'dimension' },
        { key: 'group', label: 'Группа Device Monitor', type: 'select' },
        { key: 'soc', label: 'Соцсети и мессенджеры', type: 'select', options: SOC },
        { key: 'cloud', label: 'Облачные хранилища', type: 'select', options: CLOUD },
        { key: 'usb', label: 'USB', type: 'select', options: USB },
        { key: 'seen', label: 'Последняя связь агента', type: 'date' },
        { key: 'status', label: 'Статус', type: 'select', isStatus: true, options: ['Активно', 'Выведено'], closed: ['Выведено'] },
      ]);

    // 2. Разрешения: фиксация документа и его реквизитов статусами «Действует», «Истекло», «Отозвано».
    const perm = await createRegister(tx, PERMISSIONS_NAME,
      'Документы-разрешения руководства: соцсети и мессенджеры, облачные хранилища, удалённая работа через VPN. '
      + 'Действует не дольше 31.12 года документа. После статуса «Действует» документ и реквизиты не меняются — только новым разрешением', [
        { key: 'employee', label: 'Сотрудник', type: 'text', isTitle: true },
        { key: 'dept', label: 'Подразделение', type: 'select', analyticsRole: 'dimension' },
        { key: 'kind', label: 'Вид', type: 'select', options: KINDS, analyticsRole: 'dimension' },
        { key: 'services', label: 'Сервисы', type: 'text' },
        { key: 'devices', label: 'Устройства', type: 'link' },
        { key: 'doc', label: 'Документ-основание', type: 'file' },
        { key: 'docNo', label: '№ документа', type: 'text' },
        { key: 'docDate', label: 'Дата документа', type: 'date' },
        { key: 'signer', label: 'Кто разрешил', type: 'text' },
        { key: 'until', label: 'Действует до', type: 'date', analyticsRole: 'deadline' },
        { key: 'done', label: 'Исполнено', type: 'select', options: ['Ожидает настройки', 'Настроено в DLP', 'Настроено в VPN'], analyticsRole: 'dimension' },
        { key: 'origPlace', label: 'Место хранения оригинала', type: 'text' },
        { key: 'origDate', label: 'Оригинал передан в архив', type: 'date' },
        { key: 'status', label: 'Статус', type: 'select', isStatus: true, options: PERMISSION_STATUSES, closed: ['Истекло', 'Отозвано'] },
      ],
      (key) => (key === 'devices' ? { linkRegisterId: dev.reg.id } : {}));
    const p = perm.fields;
    const lockIds = LOCKING.map((l) => p.status?.options[l] as string);
    const lock = (mode: 'locked' | 'reason') => ({ lock: { statusOptionIds: lockIds, mode } });
    for (const key of ['doc', 'docNo', 'docDate', 'signer', 'kind', 'services']) {
      await tx.registerField.update({ where: { id: p[key]?.id }, data: { settings: lock('locked') } });
    }
    await tx.registerField.update({ where: { id: p.devices?.id }, data: { settings: lock('reason') } });
    await tx.registerField.update({
      where: { id: p.until?.id },
      data: { settings: { ...lock('locked'), date: { notAfterYearEndOfFieldId: p.docDate?.id, defaultEndOfYear: true } } },
    });

    // 3. Статус основания на устройствах: по связи «Устройства», вид — по каналу.
    const basis = (channel: 'soc' | 'cloud', kind: string): BasisRule => ({
      kind: 'link_basis',
      channelFieldId: dev.fields[channel]?.id as string,
      closedOptionIds: [dev.fields[channel]?.options['Запрещены'] as string],
      sourceRegisterId: perm.reg.id,
      linkFieldId: p.devices?.id as string,
      kindFieldId: p.kind?.id as string,
      kindOptionIds: [p.kind?.options[kind] as string],
      statusFieldId: p.status?.id as string,
      activeOptionIds: [p.status?.options['Действует'] as string],
      untilFieldId: p.until?.id as string,
      numberFieldId: p.docNo?.id as string,
    });
    const basisFields = [];
    for (const [i, [label, rule]] of ([
      ['Основание: соцсети', basis('soc', 'Соцсети и мессенджеры')],
      ['Основание: облако', basis('cloud', 'Облачные хранилища')],
    ] as const).entries()) {
      basisFields.push(await tx.registerField.create({
        data: { registerId: dev.reg.id, label, type: 'calc', calcRule: rule as unknown as Prisma.InputJsonValue, sortOrder: 20 + i },
      }));
    }

    // 4. Автоматизации.
    const rules: { registerId: string; condition: Prisma.InputJsonValue; action: Prisma.InputJsonValue }[] = [
      {
        registerId: perm.reg.id,
        condition: { kind: 'yearly', month: 12, day: 1, statusOptionIds: [p.status?.options['Действует'] as string] },
        action: { eventType: 'notify', recipients, title: 'Продление разрешений на {год}' },
      },
      {
        registerId: perm.reg.id,
        condition: { kind: 'overdue', fieldId: p.until?.id as string },
        action: { eventType: 'set_option', fieldId: p.status?.id as string, optionId: p.status?.options['Истекло'] as string, fromOptionIds: [p.status?.options['Действует'] as string], recipients: [] },
      },
      {
        registerId: perm.reg.id,
        condition: { kind: 'before', fieldId: p.until?.id as string, days: 14, skipYearEnd: true },
        action: { eventType: 'remind', recipients },
      },
      ...basisFields.map((f) => ({
        registerId: dev.reg.id,
        condition: { kind: 'basis_missing', fieldId: f.id },
        action: { eventType: 'notify', recipients, title: 'Закрыть доступ в Device Monitor или получить разрешение' },
      })),
    ];
    for (const r of rules) await tx.registerAutomation.create({ data: r });

    // 5. Плитки дашборда (автор — система): открытые записи с доступом по каналу, действующие разрешения, «ожидают настройки».
    const max = await tx.dashboardTile.aggregate({ where: { deletedAt: null }, _max: { sortOrder: true } });
    let order = max._max.sortOrder ?? 0;
    const tile = (registerId: string, fieldId: string, title: string, optionIds: string[]) =>
      tx.dashboardTile.create({ data: { registerId, fieldId, title, optionIds, sortOrder: ++order, createdBy: null } });
    const open = (f: { id: string; options: Record<string, string> } | undefined, except: string) =>
      Object.entries(f?.options ?? {}).filter(([l]) => l !== except).map(([, id]) => id);
    await tile(dev.reg.id, dev.fields.soc?.id as string, 'Доступ к соцсетям', open(dev.fields.soc, 'Запрещены'));
    await tile(dev.reg.id, dev.fields.cloud?.id as string, 'Доступ к облаку', open(dev.fields.cloud, 'Запрещены'));
    await tile(dev.reg.id, dev.fields.usb?.id as string, 'Доступ к USB', open(dev.fields.usb, 'Запрещён'));
    await tile(perm.reg.id, p.kind?.id as string, 'Действующие разрешения по видам', Object.values(p.kind?.options ?? {}));
    await tile(perm.reg.id, p.done?.id as string, 'Ожидают настройки', [p.done?.options['Ожидает настройки'] as string]);

    // 6. Правило почты «Разрешения» — выше «Доступа»: при равном числе совпадений выигрывает первое.
    const rulesExists = await tx.catalogItem.findFirst({ where: { catalogCode: 'mail_rules', deletedAt: null, value: { equals: MAIL_RULE, mode: 'insensitive' } } });
    if (!rulesExists) {
      const access = await tx.catalogItem.findFirst({ where: { catalogCode: 'mail_rules', deletedAt: null, value: 'Доступ' } });
      let sortOrder: number;
      if (access) {
        await tx.catalogItem.updateMany({ where: { catalogCode: 'mail_rules', sortOrder: { gte: access.sortOrder } }, data: { sortOrder: { increment: 1 } } });
        sortOrder = access.sortOrder;
      } else {
        sortOrder = ((await tx.catalogItem.aggregate({ where: { catalogCode: 'mail_rules' }, _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1;
      }
      await tx.catalogItem.create({ data: { catalogCode: 'mail_rules', value: MAIL_RULE, keywords: MAIL_KEYWORDS, sortOrder } });
    }
    return `Стартовые реестры «${dev.reg.name}» и «${perm.reg.name}»: правил ${rules.length}, плиток 5; метка «${DLP_LABEL}», правило почты «${MAIL_RULE}»`;
  });
}
