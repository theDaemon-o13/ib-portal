// Однократно (отметка в seed_markers): системные реестры «Сервисы», «Компоненты» и «Хосты» (релиз 1.6.0, ADR-0031),
// без записей; напоминание о пересмотре, поле «Сервис» у реестра инцидентов.
// Реестры первой редакции (отметка v1, были только на dev и в тестах) доводятся до v2 на месте: поля по ключу
// или названию переименовываются, недостающие добавляются, лишние системные уходят в архив. Записи не меняются.
// Удалённое или изменённое администратором после этого seed не восстанавливает.
import type { Prisma } from '../../src/generated/prisma/client.js';
import {
  ASSET_COMPONENTS_KEY, ASSET_HOSTS_KEY, ASSET_SERVICES_KEY, ASSET_SETTINGS_KEY, COMPONENT_FIELDS, HOST_FIELDS, REVIEW_DAYS, SERVICE_FIELDS,
  type AssetFieldSpec,
} from '../../src/modules/assets/definition.js';
import { componentInstance, componentKey } from '../../src/modules/assets/service-registry.js';
import { INCIDENT_REGISTER_KEY } from '../../src/modules/dashboard/incidents.js';
import { loadRegister, searchTextOf } from '../../src/modules/registers/definition.js';
import type { Values } from '../../src/lib/register-values.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

const LABEL = 'Активы';
const COMPONENTS_DESCRIPTION = 'Экземпляры компонентов продуктов: микросервисы, базы данных, прокси в каждой среде и на каждом адресе. Данные — реестр сервисов в Excel; ключ — «Компонент / Продукт / Среда / IP:порт»';

/** Значения первой редакции, которые переименовываются, а не заводятся заново: записи сохраняют выбор. */
const OPTION_RENAMES: Record<string, string> = { 'Operational Critical': 'Operational', 'Non-critical': 'Non-Critical' };
/** Поля первой редакции под другим названием. */
const FIELD_RENAMES: Record<string, string> = { 'Уровень системы': 'level', 'Основание уровня': 'levelBasis' };

interface Ensured { id: string; name: string; created: boolean; fields: Record<string, { id: string; options: Record<string, string> }> }

async function freeName(tx: Tx, name: string): Promise<string> {
  const clash = await tx.register.findFirst({ where: { archivedAt: null, name: { equals: name, mode: 'insensitive' } } });
  return clash ? `${name} (системный)` : name;
}

/** Реестр по ключу: нет — создаётся, есть — поля доводятся до описания. */
type Fields = Ensured['fields'];

async function ensureRegister(
  tx: Tx, systemKey: string, name: string, description: string, specs: AssetFieldSpec[], regIds: Record<string, string>,
  calcRules: Record<string, (fields: Fields) => object> = {},
): Promise<Ensured> {
  let reg = await tx.register.findUnique({ where: { systemKey } });
  const created = !reg;
  if (!reg) reg = await tx.register.create({ data: { name: await freeName(tx, name), description, systemKey } });
  else await tx.register.update({ where: { id: reg.id }, data: { description } });
  const existing = await tx.registerField.findMany({ where: { registerId: reg.id, deletedAt: null }, include: { options: { where: { deletedAt: null } } } });
  const used = new Set<string>();
  const out: Ensured = { id: reg.id, name: reg.name, created, fields: {} };

  for (const [i, spec] of specs.entries()) {
    const sortOrder = i + 1;
    let field = existing.find((f) => !used.has(f.id) && f.systemKey === spec.key)
      ?? existing.find((f) => !used.has(f.id) && !f.systemKey && (f.label.toLowerCase() === spec.label.toLowerCase() || FIELD_RENAMES[f.label] === spec.key));
    if (field && field.type !== spec.type) {
      // Тип изменился (первая редакция: «Пересмотр до» было датой) — прежнее поле уходит в архив с данными.
      await tx.registerField.update({ where: { id: field.id }, data: { systemKey: null, label: `${field.label} (прежнее)`, archivedAt: new Date(), version: { increment: 1 } } });
      used.add(field.id);
      field = undefined;
    }
    const data = {
      label: spec.label, sortOrder, systemKey: spec.system ? spec.key : null,
      isTitle: spec.isTitle ?? false, isStatus: spec.isStatus ?? false, isImportKey: spec.isImportKey ?? false,
      analyticsRole: spec.analyticsRole ?? null,
      linkRegisterId: spec.link ? regIds[spec.link] ?? null : null,
      ...(spec.hint ? { settings: { hint: spec.hint } } : {}),
      ...(calcRules[spec.key] ? { calcRule: calcRules[spec.key]?.(out.fields) as Prisma.InputJsonValue } : {}),
    };
    if (!field) {
      const f = await tx.registerField.create({
        data: {
          registerId: reg.id, type: spec.type, catalogCode: spec.catalogCode ?? null, ...data,
          options: spec.options?.length ? { create: spec.options.map((o, j) => ({ label: o.label, sortOrder: j + 1, isClosed: o.closed ?? false, systemKey: o.key ?? null })) } : undefined,
        },
        include: { options: true },
      });
      used.add(f.id);
      out.fields[spec.key] = { id: f.id, options: Object.fromEntries(f.options.map((o) => [o.label, o.id])) };
      continue;
    }
    used.add(field.id);
    const changed = field.label !== spec.label || field.systemKey !== data.systemKey;
    await tx.registerField.update({ where: { id: field.id }, data: { ...data, ...(changed ? { version: { increment: 1 } } : {}) } });
    const options: Record<string, string> = {};
    for (const [j, o] of (spec.options ?? []).entries()) {
      const hit = field.options.find((x) => (o.key && x.systemKey === o.key) || x.label.toLowerCase() === o.label.toLowerCase() || OPTION_RENAMES[x.label] === o.label);
      if (hit) {
        await tx.registerFieldOption.update({ where: { id: hit.id }, data: { label: o.label, sortOrder: j + 1, isClosed: o.closed ?? hit.isClosed, systemKey: o.key ?? hit.systemKey } });
        options[o.label] = hit.id;
      } else {
        const x = await tx.registerFieldOption.create({ data: { fieldId: field.id, label: o.label, sortOrder: j + 1, isClosed: o.closed ?? false, systemKey: o.key ?? null } });
        options[o.label] = x.id;
      }
    }
    out.fields[spec.key] = { id: field.id, options };
  }
  // Системные поля первой редакции, которых нет в описании («Состояние защиты»), — в архив: данные остаются.
  for (const f of existing.filter((x) => !used.has(x.id) && x.systemKey && !x.archivedAt)) {
    await tx.registerField.update({ where: { id: f.id }, data: { systemKey: null, archivedAt: new Date(), version: { increment: 1 } } });
  }
  return out;
}

export async function seedAssets(tx: Tx): Promise<void> {
  await once(tx, 'system.register.assets.v2', async () => {
    const ids: Record<string, string> = {};
    for (const key of [ASSET_SERVICES_KEY, ASSET_COMPONENTS_KEY, ASSET_HOSTS_KEY]) {
      const r = await tx.register.findUnique({ where: { systemKey: key }, select: { id: true } });
      if (r) ids[key] = r.id;
    }
    // Порядок важен для связей: продукты, затем хосты, затем компоненты (ссылаются на оба).
    // «Пересмотр до» = «Дата классификации» + 183 дня при любой категории: конструктор считает срок по значению списка.
    const reviewRule = (f: Fields) => ({
      kind: 'due_date', fromFieldId: f.classifiedOn?.id, byFieldId: f.level?.id,
      days: Object.fromEntries(Object.values(f.level?.options ?? {}).map((id) => [id, REVIEW_DAYS])), overrideFieldId: null,
    });
    const services = await ensureRegister(tx, ASSET_SERVICES_KEY, 'Сервисы',
      'Продукты и информационные системы по процедуре классификации ИТ-активов: владельцы, категория критичности, RTO и RPO, пересмотр раз в 6 месяцев',
      SERVICE_FIELDS, ids, { reviewDue: reviewRule });
    ids[ASSET_SERVICES_KEY] = services.id;
    const hosts = await ensureRegister(tx, ASSET_HOSTS_KEY, 'Хосты',
      'Серверы, рабочие станции и сетевое оборудование. Данные — отчёты Kaspersky Security Center, реестр сервисов и вручную; ключ — имя хоста без домена',
      HOST_FIELDS, ids);
    ids[ASSET_HOSTS_KEY] = hosts.id;
    const components = await ensureRegister(tx, ASSET_COMPONENTS_KEY, 'Компоненты',
      COMPONENTS_DESCRIPTION,
      COMPONENT_FIELDS, ids);

    // Ключи сравнения с реестром.
    await tx.register.update({ where: { id: services.id }, data: { compareKeyFieldIds: [services.fields.title?.id as string] } });
    await tx.register.update({ where: { id: components.id }, data: { compareKeyFieldIds: [components.fields.key?.id as string] } });
    await tx.register.update({ where: { id: hosts.id }, data: { compareKeyFieldIds: [hosts.fields.name?.id as string], compareScopeFieldIds: [hosts.fields.type?.id as string] } });

    // Метка получателей: участников назначает администратор.
    let label = await tx.catalogItem.findFirst({ where: { catalogCode: 'notify_recipients', deletedAt: null, value: { equals: LABEL, mode: 'insensitive' } } });
    if (!label) {
      const max = await tx.catalogItem.aggregate({ where: { catalogCode: 'notify_recipients' }, _max: { sortOrder: true } });
      label = await tx.catalogItem.create({ data: { catalogCode: 'notify_recipients', value: LABEL, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
    }
    // Напоминание о пересмотре: правило первой редакции переводится на новое поле, нет — создаётся.
    const reminders = await tx.registerAutomation.findMany({ where: { registerId: services.id } });
    const remind = reminders.find((a) => (a.condition as { kind?: string }).kind === 'before');
    const condition = { kind: 'before', fieldId: services.fields.reviewDue?.id as string, days: 30 };
    if (remind) await tx.registerAutomation.update({ where: { id: remind.id }, data: { condition } });
    else {
      await tx.registerAutomation.create({
        data: { registerId: services.id, condition, action: { eventType: 'remind', recipients: [{ kind: 'label', itemId: label.id }] } },
      });
    }

    // Настройки первой редакции: «плохие состояния защиты» больше не нужны.
    const setting = await tx.appSetting.findUnique({ where: { key: ASSET_SETTINGS_KEY } });
    if (setting) {
      const { badProtectionOptionIds: _drop, ...rest } = setting.value as Record<string, unknown>;
      void _drop;
      await tx.appSetting.update({ where: { key: ASSET_SETTINGS_KEY }, data: { value: rest as Prisma.InputJsonValue, version: { increment: 1 } } });
    }

    // Инциденты: необязательная связь с сервисом. Реестра нет, он в архиве или поле уже есть — пропускаем.
    const incidents = await tx.register.findUnique({ where: { systemKey: INCIDENT_REGISTER_KEY }, select: { id: true, archivedAt: true } });
    let incidentField = false;
    if (incidents && !incidents.archivedAt) {
      const has = await tx.registerField.findFirst({ where: { registerId: incidents.id, type: 'link', linkRegisterId: services.id, deletedAt: null } });
      if (!has) {
        const max = await tx.registerField.aggregate({ where: { registerId: incidents.id }, _max: { sortOrder: true } });
        await tx.registerField.create({ data: { registerId: incidents.id, label: 'Сервис', type: 'link', linkRegisterId: services.id, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
        incidentField = true;
      }
    }
    const upgraded = !services.created;
    return `Системные реестры «${services.name}», «${components.name}», «${hosts.name}»${upgraded ? ' (первая редакция доведена до v2)' : ''}, метка «${LABEL}»${incidentField ? ', поле «Сервис» у инцидентов' : ''}`;
  });
}

/**
 * 1.6.1, однократно: запись «Компонентов» — экземпляр. Поле «Экземпляр» становится заголовком, ключ и заголовок
 * существующих записей пересчитываются по новому правилу. Совпали новые ключи у неудалённых записей — записи не
 * склеиваются: seed останавливается со списком (транзакция откатывается, ничего не меняется).
 */
export async function seedComponentInstances(tx: Tx): Promise<void> {
  await once(tx, 'system.register.assets.components_instance.v1', async () => {
    const reg = await tx.register.findUnique({ where: { systemKey: ASSET_COMPONENTS_KEY }, select: { id: true, name: true } });
    if (!reg) return 'Реестра «Компоненты» нет — пересчёт не нужен';
    await tx.register.update({ where: { id: reg.id }, data: { description: COMPONENTS_DESCRIPTION } });
    const fields = await tx.registerField.findMany({ where: { registerId: reg.id, deletedAt: null } });
    const byKey = (k: string) => fields.find((f) => f.systemKey === k);
    let instance = byKey('instance');
    if (!instance) {
      await tx.registerField.updateMany({ where: { registerId: reg.id, isTitle: true }, data: { isTitle: false, version: { increment: 1 } } });
      instance = await tx.registerField.create({ data: { registerId: reg.id, label: 'Экземпляр', type: 'text', systemKey: 'instance', isTitle: true, sortOrder: 0 } });
    }
    const [title, product, key, env, ip, port] = ['title', 'product', 'key', 'env', 'ip', 'port'].map(byKey);
    if (!title || !key) return `«${reg.name}»: нет системных полей «Компонент» или «Ключ компонента» — пересчёт пропущен`;

    const def = await loadRegister(tx, reg.id);
    const envLabels = new Map((def.fields.find((f) => f.id === env?.id)?.options ?? []).map((o) => [o.id, o.label]));
    const services = await tx.register.findUnique({ where: { systemKey: ASSET_SERVICES_KEY }, include: { fields: { where: { systemKey: 'title', deletedAt: null } } } });
    const serviceTitle = services?.fields[0]?.id;
    const productNames = new Map<string, string>();
    if (services && serviceTitle) {
      for (const r of await tx.registerRecord.findMany({ where: { registerId: services.id }, select: { id: true, values: true } })) {
        const t = (r.values as Values)[serviceTitle];
        if (typeof t === 'string') productNames.set(r.id, t);
      }
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const rows = await tx.registerRecord.findMany({ where: { registerId: reg.id }, select: { id: true, number: true, values: true, deletedAt: true }, orderBy: { number: 'asc' } });
    const planned = rows.map((r) => {
      const v = r.values as Values;
      const comp = str(v[title.id]);
      const linked = product ? v[product.id] : undefined;
      const prod = Array.isArray(linked) ? linked.map((id) => productNames.get(String(id)) ?? '').filter(Boolean).join(', ') : '';
      const e = env ? envLabels.get(str(v[env.id])) ?? '' : '';
      const a = ip ? str(v[ip.id]) : '';
      const p = port ? str(v[port.id]) : '';
      // Ключ — только у записей с ключом (их завёл адаптер): компонент, заведённый вручную, ключа не получает (1.6.0).
      const hadKey = typeof v[key.id] === 'string' && v[key.id] !== '';
      return { r, comp, key: comp && hadKey ? componentKey(comp, prod, e, a, p) : '', instance: comp ? componentInstance(comp, e, a, p) : '' };
    });
    const groups = new Map<string, number[]>();
    for (const x of planned) if (x.key && !x.r.deletedAt) groups.set(x.key, [...(groups.get(x.key) ?? []), x.r.number]);
    const clashes = [...groups].filter(([, nums]) => nums.length > 1);
    if (clashes.length) {
      throw new Error(`«${reg.name}»: при пересчёте ключа по правилу «Компонент / Продукт / Среда / IP:порт» совпали ключи у ${clashes.length} групп записей — записи не склеиваются, seed остановлен. `
        + `Удалите или исправьте повторы и повторите migrate: ${clashes.map(([k, nums]) => `«${k}» — #${nums.join(', #')}`).join('; ')}`);
    }
    let changed = 0;
    for (const x of planned) {
      const v = x.r.values as Values;
      if (!x.comp || ((!x.key || v[key.id] === x.key) && v[instance.id] === x.instance)) continue;
      const values: Values = { ...v, ...(x.key ? { [key.id]: x.key } : {}), [instance.id]: x.instance };
      await tx.registerRecord.update({
        where: { id: x.r.id },
        data: { values: values as Prisma.InputJsonValue, searchText: searchTextOf(def, x.r.number, values, new Map()), version: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          userId: null, action: 'register_record.updated', entity: 'register_record', entityId: x.r.id,
          diff: {
            summary: `«${reg.name}», запись #${x.r.number}: ${x.key ? 'ключ и заголовок пересчитаны' : 'заголовок заполнен'} при обновлении на 1.6.1`,
            after: { via: 'seed', changes: [
              ...(x.key ? [{ fieldId: key.id, label: key.label, from: str(v[key.id]), to: x.key }] : []),
              { fieldId: instance.id, label: instance.label, from: str(v[instance.id]), to: x.instance },
            ] },
          } as Prisma.InputJsonValue,
        },
      });
      changed++;
    }
    return `«${reg.name}»: заголовок «Экземпляр», ключ «Компонент / Продукт / Среда / IP:порт» — пересчитано записей ${changed} из ${rows.length}`;
  });
}
