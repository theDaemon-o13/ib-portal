// Сверка активов (релиз 1.6.0, ADR-0031): только чтение, считается при каждом запросе и нигде не хранится.
// Каждая проверка возвращает единую структуру факта (logic.ts): её же возьмёт «Что видит портал» в самооценке.
import type { Methodology } from '../../lib/assessment-score.js';
import type { Db } from '../../lib/db.js';
import type { Values } from '../../lib/register-values.js';
import { addDaysIso, todayIso } from '../../lib/today.js';
import { dateOf, isClosed, loadRegister, type FieldMeta, type RegisterDef } from '../registers/definition.js';
import { readPortalParam } from '../settings/portal-params.js';
import { RISK_REGISTER_KEY } from '../risks/definition.js';
import { deletedVulns } from '../trash/service.js';
import { nodeLabel } from '../vulns/groups.service.js';
import { formatDateRu } from '../../lib/register-values.js';
import { getVulnSettings, iso, scanFreshness } from '../vulns/profiles.js';
import { ASSET_COMPONENTS_KEY, ASSET_HOSTS_KEY, ASSET_SERVICES_KEY, ASSET_SETTINGS_KEY, CATEGORIES, DLP_DEVICES_NAME, SIGNIFICANT_LEVELS } from './definition.js';
import { checkedFact, nameCollisions, noDataFact, normalizeHostName, type AssetFact, type FactDef, type FactRecord, type FactWarning } from './logic.js';

const SCAN_WINDOW_DAYS = 90;
const SILENT_VISIBLE_DAYS = 7;
const SILENT_CONNECT_DAYS = 30;
const DEPLOYMENT_MAX_AGE_DAYS = 35;

/** Окно проверки «Удалённые открытые уязвимости» (5.3). */
const DELETED_WINDOW_MONTHS = 12;
const DEFS = {
  withoutCategory: { code: 'products.without_category', section: '2.3', title: 'У продукта и компонента задана категория критичности' },
  workingWithoutCategory: { code: 'products.working_without_category', section: '2.3', title: 'Работающий продукт классифицирован' },
  ownership: { code: 'products.ownership', section: '2.2', title: 'У значимого продукта есть бизнес- и ИТ-владелец и назначение' },
  riskLink: { code: 'products.risk_link', section: '2.3', title: 'У значимого продукта указана связь с ключевыми рисками' },
  rtoRpo: { code: 'products.rto_rpo', section: '2.3', title: 'У значимого продукта заданы RTO и RPO' },
  review: { code: 'products.review', section: '2.3', title: 'Пересмотр классификации задан и не просрочен' },
  documented: { code: 'products.documented', section: '2.2', relatedSections: ['2.3'], title: 'Классификация задокументирована: дата и согласование руководителем ИБ' },
  aboveProduct: { code: 'components.above_product', section: '2.3', title: 'Компонент не критичнее своего продукта' },
  withoutComponents: { code: 'products.without_components', section: '2.2', title: 'У значимого продукта указаны компоненты' },
  withoutHosts: { code: 'products.without_hosts', section: '2.2', title: 'У значимого продукта указаны хосты' },
  systemsWithoutProduct: { code: 'systems.without_product', section: '2.2', title: 'У системы из справочника есть продукт' },
  productsWithoutSystem: { code: 'products.without_system', section: '2.2', title: 'Продукт связан с системой из справочника' },
  unsupportedOs: { code: 'assets.unsupported_os', section: '8.2', title: 'Неподдерживаемая ОС — только с планом в продукте' },
  legacyPlan: { code: 'products.legacy_without_plan', section: '8.2', title: 'У устаревшей системы есть план' },
  osFromScan: { code: 'hosts.os_from_scan', section: '2.2', title: 'ОС хоста указана, если её видит сканер' },
  notScanned: { code: 'products.not_scanned', section: '5.2', title: `Хосты значимого продукта были в сканах за ${SCAN_WINDOW_DAYS} дней` },
  nodesScanned: { code: 'vuln_nodes.without_recent_scan', section: '5.2', title: 'Узел уязвимостей сканировали в пределах порога' },
  deletedOpen: { code: 'vulns.deleted_open', section: '5.3', title: `Открытые уязвимости не удалялись (за ${DELETED_WINDOW_MONTHS} месяцев)` },
  notInRegistry: { code: 'scan_hosts.not_in_registry', section: '2.2', title: 'Хост из сканов есть в реестре' },
  withoutRisk: { code: 'products.without_risk', section: '2.3', relatedSections: ['1.2'], title: 'Для значимого продукта есть риск в реестре рисков' },
  notMonitored: { code: 'products.not_monitored', section: '3.2', title: 'Значимый продукт подключён к мониторингу' },
  testShare: { code: 'products.test_share', section: '9.3', title: 'Компоненты значимых продуктов работают в среде Prod' },
  testProdMixed: { code: 'hosts.test_prod_mixed', section: '9.3', title: 'На хосте не смешаны компоненты Test и Prod' },
  envAddressClash: { code: 'components.env_address_clash', section: '9.3', title: 'На одном IP:порт нет компонентов разных сред' },
  serversCoverage: { code: 'ksc.servers_coverage', section: '9.2', title: 'На сервере есть агент и защита Kaspersky' },
  workstationsCoverage: { code: 'ksc.workstations_coverage', section: '9.2', title: 'На рабочей станции есть агент и защита Kaspersky' },
  basesOutdated: { code: 'ksc.bases_outdated', section: '9.2', title: 'Антивирусные базы обновлены за 7 дней' },
  agentSilent: { code: 'ksc.agent_silent', section: '9.2', title: `Агент на связи с Сервером администрирования (не молчит дольше ${SILENT_CONNECT_DAYS} дней при устройстве в сети)` },
  versionBelowMin: { code: 'ksc.version_below_min', section: '9.2', title: 'Версия защиты не ниже минимальной' },
  withoutDlp: { code: 'workstations.without_dlp', section: '9.2', title: 'На рабочей станции есть агент DLP' },
  dlpWithoutHost: { code: 'dlp.without_host', section: '9.2', title: 'Агент DLP стоит на хосте из реестра' },
  deploymentStale: { code: 'ksc.deployment_stale', section: '9.2', title: `Отчёт о развёртывании защиты загружен за ${DEPLOYMENT_MAX_AGE_DAYS} дней` },
} satisfies Record<string, FactDef>;

const NO_SERVICES = 'Нет данных: реестр сервисов не заполнен';
const NO_COMPONENTS = 'Нет данных: реестр компонентов не заполнен';
const NO_HOSTS = 'Нет данных: реестр хостов не заполнен';
const NO_RISKS = 'Нет данных: реестр рисков не заполнен';
const NO_DLP = 'Нет данных: реестр устройств DLP не заполнен';
const NO_SCANS = 'Нет данных: сканы не загружены';
const NO_SYSTEMS = 'Нет данных: справочник «Системы» не заполнен';
const NO_SIGNIFICANT = 'Нет данных: нет значимых продуктов — категория критичности не задана';
const NO_DEPLOYMENT = 'Нет данных: отчёт о развёртывании защиты не загружен';

export interface AssetSettings {
  significantLevelOptionIds: string[];
  dlpRegisterId: string | null;
}

interface Row { id: string; values: Values }
interface Loaded { reg: RegisterDef; active: Row[]; retired: Row[] }

const recordHref = (registerId: string, recordId: string) => `/registers?record=${recordId}#${registerId}/records`;
const textOf = (values: Values, field: FieldMeta | undefined) => {
  const v = field ? values[field.id] : undefined;
  return typeof v === 'string' ? v.trim() : '';
};
const linksOf = (values: Values, field: FieldMeta | undefined): string[] => {
  const v = field ? values[field.id] : undefined;
  return Array.isArray(v) ? (v as string[]) : [];
};
const byKey = (reg: RegisterDef, key: string) => reg.fields.find((f) => f.systemKey === key);
const titleOf = (reg: RegisterDef, values: Values) => textOf(values, reg.fields.find((f) => f.isTitle)) || 'Без названия';
const optionKey = (field: FieldMeta | undefined, values: Values) => field?.options.find((o) => o.id === values[field.id])?.systemKey ?? null;
/** Ранг категории: 0 — Mission Critical; по ключу значения, иначе по названию; не задана — null. */
const rankOf = (field: FieldMeta | undefined, values: Values): number | null => {
  const opt = field?.options.find((o) => o.id === values[field.id]);
  if (!opt) return null;
  const keys = ['mission', 'business', 'operational', 'non_critical'];
  const byKeyRank = opt.systemKey ? keys.indexOf(opt.systemKey) : -1;
  if (byKeyRank >= 0) return byKeyRank;
  const byLabel = (CATEGORIES as readonly string[]).findIndex((c) => c.toLowerCase() === opt.label.toLowerCase());
  return byLabel >= 0 ? byLabel : null;
};
/** Версия «12.5.0.1» → числа для сравнения. */
const versionParts = (s: string) => s.split(/[^\d]+/).filter(Boolean).map(Number);
export function versionBelow(version: string, min: string): boolean {
  const a = versionParts(version);
  const b = versionParts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Активные — не удалены, не в архиве, статус не закрытый. Остальные нужны, только чтобы исключить их из сверки. */
async function loadRows(db: Db, reg: RegisterDef): Promise<Loaded> {
  const rows = await db.registerRecord.findMany({ where: { registerId: reg.id }, select: { id: true, values: true, deletedAt: true, archivedAt: true } });
  const active: Row[] = [];
  const retired: Row[] = [];
  for (const r of rows) {
    const row = { id: r.id, values: r.values as Values };
    (r.deletedAt || r.archivedAt || isClosed(reg, row.values) ? retired : active).push(row);
  }
  return { reg, active, retired };
}

async function loadByKey(db: Db, systemKey: string): Promise<Loaded | null> {
  const r = await db.register.findUnique({ where: { systemKey }, select: { id: true, archivedAt: true } });
  return r && !r.archivedAt ? loadRows(db, await loadRegister(db, r.id)) : null;
}

/** Значение по умолчанию: категории Mission и Business Critical, реестр устройств DLP по названию. Его же показывает «Параметры портала». */
export async function assetDefaults(db: Db): Promise<AssetSettings> {
  const row = await db.register.findUnique({ where: { systemKey: ASSET_SERVICES_KEY }, select: { id: true } });
  const level = row ? (await loadRegister(db, row.id)).fields.find((f) => f.systemKey === 'level') : undefined;
  const dlp = await db.register.findFirst({ where: { archivedAt: null, deletedAt: null, systemKey: null, name: { equals: DLP_DEVICES_NAME, mode: 'insensitive' } }, select: { id: true } });
  return {
    significantLevelOptionIds: (level?.options ?? []).filter((o) => SIGNIFICANT_LEVELS.includes(o.label)).map((o) => o.id),
    dlpRegisterId: dlp?.id ?? null,
  };
}

export async function getAssetSettings(db: Db): Promise<AssetSettings & { version: number }> {
  const row = await db.appSetting.findUnique({ where: { key: ASSET_SETTINGS_KEY } });
  if (!row) return { ...(await assetDefaults(db)), version: 0 };
  const v = row.value as Partial<AssetSettings>;
  return { significantLevelOptionIds: v.significantLevelOptionIds ?? [], dlpRegisterId: v.dlpRegisterId ?? null, version: row.version };
}

interface ScanHost { name: string; scanId: string; ip: string; os: string }

/** Хосты из сканов за окно: новые сканы — vuln_scans.hosts, перенесённые — scan_hosts. Ключи — имя и IP. */
async function recentScanHosts(db: Db, since: string): Promise<Map<string, ScanHost>> {
  // Аннулированный скан (1.13.12) — не источник хостов.
  const annulled = (await db.deletion.findMany({ where: { entity: 'vuln_scan', restoredAt: null }, select: { entityId: true } })).map((d) => d.entityId);
  const scans = await db.vulnScan.findMany({
    where: { scanDate: { gte: new Date(`${since}T00:00:00Z`) }, node: { deletedAt: null, group: { deletedAt: null } }, ...(annulled.length ? { id: { notIn: annulled } } : {}) },
    orderBy: { scanDate: 'desc' },
    select: { id: true, hosts: true, legacyReportId: true },
  });
  const out = new Map<string, ScanHost>();
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const add = (h: { name?: unknown; ip?: unknown; os?: unknown }, scanId: string) => {
    const name = str(h.name);
    const key = normalizeHostName(name);
    if (key && !out.has(key)) out.set(key, { name, scanId, ip: str(h.ip), os: str(h.os) });
  };
  const legacy = new Map<string, string>();
  for (const s of scans) {
    if (s.legacyReportId) legacy.set(s.legacyReportId, s.id);
    for (const h of Array.isArray(s.hosts) ? (s.hosts as { name?: unknown; ip?: unknown; os?: unknown }[]) : []) add(h ?? {}, s.id);
  }
  if (legacy.size) {
    const rows = await db.scanHost.findMany({ where: { reportId: { in: [...legacy.keys()] } }, select: { reportId: true, name: true, ip: true, os: true } });
    for (const h of rows) add(h, legacy.get(h.reportId) as string);
  }
  return out;
}

export async function assetFacts(db: Db, now: Date = new Date()): Promise<AssetFact[]> {
  const at = now.toISOString();
  const today = todayIso(now);
  const settings = await getAssetSettings(db);
  const unsupported = new Set((await readPortalParam<string[]>(db, 'assets.unsupportedOs')).map((s) => s.trim().toLowerCase()));
  const minVersion = await readPortalParam<string>(db, 'assets.minProtectionVersion');
  const services = await loadByKey(db, ASSET_SERVICES_KEY);
  const components = await loadByKey(db, ASSET_COMPONENTS_KEY);
  const hosts = await loadByKey(db, ASSET_HOSTS_KEY);
  const risks = await loadByKey(db, RISK_REGISTER_KEY);
  const dlpReg = settings.dlpRegisterId ? await db.register.findFirst({ where: { id: settings.dlpRegisterId, archivedAt: null, deletedAt: null }, select: { id: true } }) : null;
  const dlp = dlpReg ? await loadRows(db, await loadRegister(db, dlpReg.id)) : null;
  const systems = await db.catalogItem.findMany({ where: { catalogCode: 'systems', deletedAt: null, archivedAt: null }, select: { id: true, value: true } });
  const annulledScans = (await db.deletion.findMany({ where: { entity: 'vuln_scan', restoredAt: null }, select: { entityId: true } })).map((d) => d.entityId);
  const scansTotal = await db.vulnScan.count({ where: { node: { deletedAt: null, group: { deletedAt: null } }, ...(annulledScans.length ? { id: { notIn: annulledScans } } : {}) } });
  const scanned = await recentScanHosts(db, addDaysIso(today, -SCAN_WINDOW_DAYS));

  const facts: AssetFact[] = [];
  const empty = (def: FactDef, message: string) => facts.push(noDataFact(def, at, message));
  const push = (def: FactDef, input: Parameters<typeof checkedFact>[2]) => facts.push(checkedFact(def, at, input));

  const svc = services && services.active.length ? services : null;
  const cmp = components && components.active.length ? components : null;
  const hst = hosts && hosts.active.length ? hosts : null;
  const S = (key: string) => (services ? byKey(services.reg, key) : undefined);
  const C = (key: string) => (components ? byKey(components.reg, key) : undefined);
  const H = (key: string) => (hosts ? byKey(hosts.reg, key) : undefined);
  const ref = (l: Loaded) => (r: Row, detail: string | null = null): FactRecord => ({ id: r.id, title: titleOf(l.reg, r.values), href: recordHref(l.reg.id, r.id), detail });
  const svcRef = services ? ref(services) : () => ({ id: '', title: '', href: null, detail: null });
  const cmpRef = components ? ref(components) : svcRef;
  const hostRef = hosts ? ref(hosts) : svcRef;
  const significant = svc ? svc.active.filter((r) => settings.significantLevelOptionIds.includes(textOf(r.values, S('level')))) : [];
  const productById = new Map((svc?.active ?? []).map((r) => [r.id, r]));

  // Связи: компоненты продукта, хосты продукта (через компоненты и напрямую), продукты хоста.
  const componentsOf = new Map<string, Row[]>();
  const hostIdsOf = new Map<string, Set<string>>();
  const productsOfHost = new Map<string, Set<string>>();
  const link = (productId: string, hostId: string) => {
    hostIdsOf.set(productId, (hostIdsOf.get(productId) ?? new Set()).add(hostId));
    productsOfHost.set(hostId, (productsOfHost.get(hostId) ?? new Set()).add(productId));
  };
  for (const c of components?.active ?? []) {
    for (const p of linksOf(c.values, C('product'))) {
      componentsOf.set(p, [...(componentsOf.get(p) ?? []), c]);
      for (const h of linksOf(c.values, C('host'))) link(p, h);
    }
  }
  for (const h of hosts?.active ?? []) for (const p of linksOf(h.values, H('services'))) link(p, h.id);
  const hostById = new Map((hosts?.active ?? []).map((r) => [r.id, r]));

  // Имена хостов; выведенные исключаются из сверки по имени, совпавшие — предупреждение, без склейки.
  const hostName = (r: Row) => textOf(r.values, H('name'));
  const activeHostNames = new Set((hosts?.active ?? []).flatMap((r) => [normalizeHostName(hostName(r)), textOf(r.values, H('ip'))]).filter(Boolean));
  const retiredHostNames = new Set((hosts?.retired ?? []).map((r) => normalizeHostName(hostName(r))).filter((n) => !activeHostNames.has(n)));
  const hostWarnings: FactWarning[] = hst ? nameCollisions(hst.active.map((r) => ({ name: hostName(r), ref: hostRef(r) })), 'Реестр хостов') : [];

  // ---- классификация (2.2, 2.3)
  if (!svc && !cmp) empty(DEFS.withoutCategory, NO_SERVICES);
  else {
    const violators = [
      ...(svc?.active ?? []).filter((r) => !textOf(r.values, S('level'))).map((r) => svcRef(r, 'Продукт')),
      ...(cmp?.active ?? []).filter((r) => !textOf(r.values, C('level'))).map((r) => cmpRef(r, 'Компонент')),
    ];
    push(DEFS.withoutCategory, { checked: (svc?.active.length ?? 0) + (cmp?.active.length ?? 0), violators, emptyMessage: NO_SERVICES });
  }
  if (!svc) empty(DEFS.workingWithoutCategory, NO_SERVICES);
  else {
    const working = svc.active.filter((r) => optionKey(S('status'), r.values) === 'working');
    push(DEFS.workingWithoutCategory, { checked: working.length, violators: working.filter((r) => !textOf(r.values, S('level'))).map((r) => svcRef(r)), emptyMessage: 'Нет данных: нет продуктов со статусом «Работает»' });
  }
  const significantCheck = (def: FactDef, gapsOf: (r: Row) => string[]) => {
    if (!svc) return empty(def, NO_SERVICES);
    const violators = significant.flatMap((r) => {
      const gaps = gapsOf(r);
      return gaps.length ? [svcRef(r, `Нет: ${gaps.join(', ')}`)] : [];
    });
    push(def, { checked: significant.length, violators, emptyMessage: NO_SIGNIFICANT });
  };
  const missing = (r: Row, list: [string, string][]) => list.filter(([key]) => !textOf(r.values, S(key))).map(([, label]) => label);
  significantCheck(DEFS.ownership, (r) => missing(r, [['ownerBusiness', 'бизнес-владельца'], ['ownerIt', 'ИТ-владельца'], ['purpose', 'назначения']]));
  significantCheck(DEFS.riskLink, (r) => missing(r, [['levelBasis', 'связи с ключевыми рисками']]));
  significantCheck(DEFS.rtoRpo, (r) => missing(r, [['rto', 'RTO'], ['rpo', 'RPO']]));

  // Пересмотр: «Пересмотр до» вычисляется от даты классификации; даты нет — регулярность ничем не подтверждена.
  if (!svc) empty(DEFS.review, NO_SERVICES);
  else {
    const field = S('reviewDue');
    const violators = svc.active.flatMap((r) => {
      const due = field ? dateOf(svc.reg, field, r.values, null) : null;
      if (!due) return [svcRef(r, 'Пересмотр не задан: нет даты классификации или категории')];
      return due < today ? [svcRef(r, `Пересмотр просрочен: ${due}`)] : [];
    });
    push(DEFS.review, { checked: svc.active.length, violators, emptyMessage: NO_SERVICES });
  }
  if (!svc) empty(DEFS.documented, NO_SERVICES);
  else {
    push(DEFS.documented, {
      checked: svc.active.length,
      violators: svc.active.flatMap((r) => {
        const gaps = missing(r, [['classifiedOn', 'даты классификации'], ['approvedOn', 'согласования руководителем ИБ']]);
        return gaps.length ? [svcRef(r, `Нет: ${gaps.join(', ')}`)] : [];
      }),
      emptyMessage: NO_SERVICES,
    });
  }

  // Компонент критичнее продукта.
  if (!cmp) empty(DEFS.aboveProduct, NO_COMPONENTS);
  else {
    const pairs = cmp.active.flatMap((c) => {
      const rank = rankOf(C('level'), c.values);
      const products = linksOf(c.values, C('product')).map((id) => productById.get(id)).filter((p): p is Row => !!p);
      return rank === null ? [] : products.flatMap((p) => {
        const pr = rankOf(S('level'), p.values);
        return pr === null ? [] : [{ c, p, above: rank < pr }];
      });
    });
    const violators = pairs.filter((x) => x.above).map((x) => cmpRef(x.c, `${textOf(x.c.values, C('level')) && C('level')?.options.find((o) => o.id === x.c.values[C('level')?.id ?? ''])?.label} при продукте «${titleOf((services as Loaded).reg, x.p.values)}» — ${S('level')?.options.find((o) => o.id === x.p.values[S('level')?.id ?? ''])?.label}`));
    push(DEFS.aboveProduct, { checked: pairs.length, violators, emptyMessage: 'Нет данных: нет компонентов с категорией у продуктов с категорией' });
  }

  // Компоненты и хосты значимых продуктов.
  if (!svc) empty(DEFS.withoutComponents, NO_SERVICES);
  else if (!cmp) empty(DEFS.withoutComponents, NO_COMPONENTS);
  else push(DEFS.withoutComponents, { checked: significant.length, violators: significant.filter((r) => !componentsOf.has(r.id)).map((r) => svcRef(r)), emptyMessage: NO_SIGNIFICANT });
  if (!svc) empty(DEFS.withoutHosts, NO_SERVICES);
  else if (!hst) empty(DEFS.withoutHosts, NO_HOSTS);
  else push(DEFS.withoutHosts, { checked: significant.length, violators: significant.filter((r) => !hostIdsOf.get(r.id)?.size).map((r) => svcRef(r)), emptyMessage: NO_SIGNIFICANT });

  // Система ↔ продукт. Система, у которой только выведенные продукты, не проверяется: она тоже выведена.
  if (!svc) empty(DEFS.systemsWithoutProduct, NO_SERVICES);
  else if (!systems.length) empty(DEFS.systemsWithoutProduct, NO_SYSTEMS);
  else {
    const withActive = new Set(svc.active.map((r) => textOf(r.values, S('system'))));
    const onlyRetired = new Set(svc.retired.map((r) => textOf(r.values, S('system'))).filter((id) => !withActive.has(id)));
    const checked = systems.filter((s) => !onlyRetired.has(s.id));
    const violators = checked.filter((s) => !withActive.has(s.id)).map((s) => ({ id: s.id, title: s.value, href: '/settings/catalogs', detail: null }));
    push(DEFS.systemsWithoutProduct, { checked: checked.length, violators, emptyMessage: NO_SYSTEMS });
  }
  if (!svc) empty(DEFS.productsWithoutSystem, NO_SERVICES);
  else push(DEFS.productsWithoutSystem, { checked: svc.active.length, violators: svc.active.filter((r) => !textOf(r.values, S('system'))).map((r) => svcRef(r)), emptyMessage: NO_SERVICES });

  // ---- устаревшие ОС и системы (8.2)
  const planned = (productIds: Iterable<string>) => [...productIds].some((id) => {
    const p = productById.get(id);
    return !!p && !!textOf(p.values, S('legacyPlan'));
  });
  if (!cmp && !hst) empty(DEFS.unsupportedOs, NO_HOSTS);
  else if (!unsupported.size) empty(DEFS.unsupportedOs, 'Нет данных: список неподдерживаемых ОС пуст');
  else {
    const withOs = [
      ...(cmp?.active ?? []).filter((r) => textOf(r.values, C('os'))).map((r) => ({ r, os: textOf(r.values, C('os')), products: linksOf(r.values, C('product')), ref: cmpRef })),
      ...(hst?.active ?? []).filter((r) => textOf(r.values, H('os'))).map((r) => ({ r, os: textOf(r.values, H('os')), products: [...(productsOfHost.get(r.id) ?? [])], ref: hostRef })),
    ];
    const violators = withOs.filter((x) => unsupported.has(x.os.toLowerCase()) && !planned(x.products)).map((x) => x.ref(x.r, `${x.os}${x.products.length ? ', в продукте нет плана' : ', продукт не указан'}`));
    push(DEFS.unsupportedOs, { checked: withOs.length, violators, emptyMessage: 'Нет данных: ОС у компонентов и хостов не указана' });
  }
  if (!svc) empty(DEFS.legacyPlan, NO_SERVICES);
  else {
    const legacy = svc.active.filter((r) => optionKey(S('legacy'), r.values) === 'yes');
    push(DEFS.legacyPlan, { checked: legacy.length, violators: legacy.filter((r) => !textOf(r.values, S('legacyPlan'))).map((r) => svcRef(r)), emptyMessage: 'Нет данных: устаревшие системы не отмечены' });
  }

  // ОС из сканов: хост найден в скане, у хоста ОС пуста, а сканер её видит — подсказка, сама ОС не подставляется.
  if (!hst) empty(DEFS.osFromScan, NO_HOSTS);
  else if (!scansTotal) empty(DEFS.osFromScan, NO_SCANS);
  else {
    const inScans = hst.active.flatMap((r) => {
      const s = scanned.get(normalizeHostName(hostName(r)));
      return s?.os ? [{ r, os: s.os }] : [];
    });
    push(DEFS.osFromScan, {
      checked: inScans.length, violators: inScans.filter((x) => !textOf(x.r.values, H('os'))).map((x) => hostRef(x.r, `Можно взять из скана: ${x.os}`)),
      emptyMessage: `Нет данных: хосты реестра не встречались в сканах за ${SCAN_WINDOW_DAYS} дней`,
    });
  }

  // ---- сканы (5.2, 2.2)
  if (!svc) empty(DEFS.notScanned, NO_SERVICES);
  else if (!hst) empty(DEFS.notScanned, NO_HOSTS);
  else if (!scansTotal) empty(DEFS.notScanned, NO_SCANS);
  else {
    const checked = significant.filter((r) => hostIdsOf.get(r.id)?.size);
    const violators = checked.flatMap((r) => {
      const missed = [...(hostIdsOf.get(r.id) ?? [])].map((id) => hostById.get(id)).filter((h): h is Row => !!h)
        .filter((h) => !scanned.has(normalizeHostName(hostName(h))) && ![...scanned.values()].some((s) => s.ip && s.ip === textOf(h.values, H('ip'))))
        .map(hostName);
      return missed.length ? [svcRef(r, `Не было в сканах: ${missed.join(', ')}`)] : [];
    });
    push(DEFS.notScanned, { checked: checked.length, violators, emptyMessage: 'Нет данных: у значимых продуктов не указаны хосты', warnings: hostWarnings });
  }
  if (!hst) empty(DEFS.notInRegistry, NO_HOSTS);
  else if (!scansTotal) empty(DEFS.notInRegistry, NO_SCANS);
  else {
    const checked = [...scanned.entries()].filter(([key]) => !retiredHostNames.has(key));
    const violators = checked.filter(([key, h]) => !activeHostNames.has(key) && !(h.ip && activeHostNames.has(h.ip)))
      .map(([key, h]) => ({ id: key, title: h.name, href: `/vulns/scan/${h.scanId}`, detail: 'Кандидат на добавление' }));
    push(DEFS.notInRegistry, { checked: checked.length, violators, emptyMessage: `Нет данных: за ${SCAN_WINDOW_DAYS} дней сканов с хостами не было`, warnings: hostWarnings });
  }

  // ---- риски (2.3, 1.2) и мониторинг (3.2)
  const riskField = risks?.reg.fields.find((f) => f.type === 'catalog' && f.catalogCode === 'systems' && !f.archived);
  if (!svc) empty(DEFS.withoutRisk, NO_SERVICES);
  else if (!risks?.active.length || !riskField) empty(DEFS.withoutRisk, NO_RISKS);
  else {
    const covered = new Set(risks.active.map((r) => textOf(r.values, riskField)));
    push(DEFS.withoutRisk, { checked: significant.length, violators: significant.filter((r) => !covered.has(textOf(r.values, S('system')))).map((r) => svcRef(r)), emptyMessage: NO_SIGNIFICANT });
  }
  // «Частично» — подключён; значение не указано — как «Нет», подключение ничем не подтверждено.
  if (!svc) empty(DEFS.notMonitored, NO_SERVICES);
  else {
    const violators = significant.flatMap((r) => {
      if (!textOf(r.values, S('monitoring'))) return [svcRef(r, 'Не указано')];
      return optionKey(S('monitoring'), r.values) === 'no' ? [svcRef(r)] : [];
    });
    push(DEFS.notMonitored, { checked: significant.length, violators, emptyMessage: NO_SIGNIFICANT });
  }

  // ---- среды (9.3)
  if (!svc) empty(DEFS.testShare, NO_SERVICES);
  else if (!cmp) empty(DEFS.testShare, NO_COMPONENTS);
  else {
    const list = significant.flatMap((p) => (componentsOf.get(p.id) ?? []).filter((c) => optionKey(C('env'), c.values)));
    push(DEFS.testShare, { checked: list.length, violators: list.filter((c) => optionKey(C('env'), c.values) === 'test').map((c) => cmpRef(c, 'Среда Test')), emptyMessage: 'Нет данных: у компонентов значимых продуктов не указана среда' });
  }
  if (!cmp) empty(DEFS.testProdMixed, NO_COMPONENTS);
  else if (!hst) empty(DEFS.testProdMixed, NO_HOSTS);
  else {
    const envs = new Map<string, Set<string>>();
    for (const c of cmp.active) {
      const env = optionKey(C('env'), c.values);
      if (!env) continue;
      for (const h of linksOf(c.values, C('host'))) if (hostById.has(h)) envs.set(h, (envs.get(h) ?? new Set()).add(env));
    }
    const violators = [...envs.entries()].filter(([, s]) => s.has('test') && s.has('prod')).map(([id]) => hostRef(hostById.get(id) as Row, 'Компоненты Test и Prod'));
    push(DEFS.testProdMixed, { checked: envs.size, violators, emptyMessage: 'Нет данных: у компонентов не указаны хост и среда' });
  }
  // Один IP:порт у компонентов Prod и Test — в реестре сервисов так записаны компоненты двух продуктов: похоже на ошибку заполнения.
  // Только адреса с портом: на одном IP без порта разные среды — обычное дело (общий хост).
  if (!cmp) empty(DEFS.envAddressClash, NO_COMPONENTS);
  else {
    const byAddress = new Map<string, { env: string; row: Row }[]>();
    for (const c of cmp.active) {
      const env = optionKey(C('env'), c.values);
      const ip = textOf(c.values, C('ip'));
      const port = textOf(c.values, C('port'));
      if (!env || !ip || !port) continue;
      const address = `${ip.toLowerCase()}:${port}`;
      byAddress.set(address, [...(byAddress.get(address) ?? []), { env, row: c }]);
    }
    const violators = [...byAddress].filter(([, list]) => new Set(list.map((x) => x.env)).size > 1)
      .flatMap(([address, list]) => list.map((x) => cmpRef(x.row, `${address}: компоненты Prod и Test`)));
    push(DEFS.envAddressClash, { checked: [...byAddress.values()].reduce((n, list) => n + list.length, 0), violators, emptyMessage: 'Нет данных: у компонентов не указаны среда, IP и порт' });
  }

  // ---- Kaspersky (9.2)
  const typed = (key: string) => (hosts?.active ?? []).filter((r) => optionKey(H('type'), r.values) === key);
  const anyCoverage = (hosts?.active ?? []).some((r) => textOf(r.values, H('coverage')));
  const coverageCheck = (def: FactDef, list: Row[], none: string) => {
    if (!list.length) return empty(def, none);
    if (!anyCoverage) return empty(def, NO_DEPLOYMENT);
    const violators = list.flatMap((r) => {
      const key = optionKey(H('coverage'), r.values);
      if (key === 'full') return [];
      return [hostRef(r, key === 'agent' ? 'Только агент' : key === 'none' ? 'Нет агента' : 'Нет в отчёте о развёртывании')];
    });
    push(def, { checked: list.length, violators, emptyMessage: none, warnings: hostWarnings });
  };
  coverageCheck(DEFS.serversCoverage, typed('server'), 'Нет данных: в реестре хостов нет серверов');
  coverageCheck(DEFS.workstationsCoverage, typed('workstation'), 'Нет данных: в реестре хостов нет рабочих станций');

  const withBases = (hosts?.active ?? []).filter((r) => textOf(r.values, H('basesStatus')));
  if (!withBases.length) empty(DEFS.basesOutdated, 'Нет данных: отчёт о статусе антивирусных баз не загружен');
  else push(DEFS.basesOutdated, { checked: withBases.length, violators: withBases.filter((r) => optionKey(H('basesStatus'), r.values) === 'outdated').map((r) => hostRef(r, `Базы от ${textOf(r.values, H('basesDate')) || '?'}`)), emptyMessage: '' });

  const visibleSince = addDaysIso(today, -SILENT_VISIBLE_DAYS);
  const connectSince = addDaysIso(today, -SILENT_CONNECT_DAYS);
  const visible = (hosts?.active ?? []).filter((r) => textOf(r.values, H('lastVisible')) >= visibleSince);
  if (!(hosts?.active ?? []).some((r) => textOf(r.values, H('lastVisible')))) empty(DEFS.agentSilent, 'Нет данных: отчёт о версиях программ не загружен');
  else {
    const violators = visible.flatMap((r) => {
      const seen = textOf(r.values, H('seen'));
      return !seen || seen < connectSince ? [hostRef(r, `В сети ${textOf(r.values, H('lastVisible'))}, связь с Сервером ${seen || 'не указана'}`)] : [];
    });
    push(DEFS.agentSilent, { checked: visible.length, violators, emptyMessage: `Нет данных: за ${SILENT_VISIBLE_DAYS} дней устройства в сети не появлялись` });
  }

  const withVersion = (hosts?.active ?? []).filter((r) => textOf(r.values, H('protectionVersion')));
  if (!minVersion) empty(DEFS.versionBelowMin, 'Нет данных: минимальная версия защиты не задана в «Параметрах портала»');
  else if (!withVersion.length) empty(DEFS.versionBelowMin, NO_DEPLOYMENT);
  else {
    push({ ...DEFS.versionBelowMin, title: `Версия защиты не ниже ${minVersion}` }, {
      checked: withVersion.length,
      violators: withVersion.filter((r) => versionBelow(textOf(r.values, H('protectionVersion')), minVersion)).map((r) => hostRef(r, textOf(r.values, H('protectionVersion')))),
      emptyMessage: NO_DEPLOYMENT,
    });
  }

  // DLP.
  const stations = typed('workstation');
  const noStations = 'Нет данных: в реестре хостов нет рабочих станций';
  const dlpName = (r: Row) => titleOf((dlp as Loaded).reg, r.values);
  const dlpRef = (r: Row): FactRecord => ({ id: r.id, title: dlpName(r), href: recordHref((dlp as Loaded).reg.id, r.id), detail: null });
  if (!stations.length) empty(DEFS.withoutDlp, noStations);
  else if (!dlp?.active.length) empty(DEFS.withoutDlp, NO_DLP);
  else {
    const agents = new Set(dlp.active.map((r) => normalizeHostName(dlpName(r))));
    push(DEFS.withoutDlp, { checked: stations.length, violators: stations.filter((r) => !agents.has(normalizeHostName(hostName(r)))).map((r) => hostRef(r)), emptyMessage: noStations, warnings: hostWarnings });
  }
  if (!hst) empty(DEFS.dlpWithoutHost, NO_HOSTS);
  else if (!dlp?.active.length) empty(DEFS.dlpWithoutHost, NO_DLP);
  else {
    const checked = dlp.active.filter((r) => !retiredHostNames.has(normalizeHostName(dlpName(r))));
    const violators = checked.filter((r) => !activeHostNames.has(normalizeHostName(dlpName(r)))).map(dlpRef);
    const warnings = [...hostWarnings, ...nameCollisions(dlp.active.map((r) => ({ name: dlpName(r), ref: dlpRef(r) })), 'Устройства DLP')];
    push(DEFS.dlpWithoutHost, { checked: checked.length, violators, emptyMessage: NO_DLP, warnings });
  }

  // Свежесть отчёта о развёртывании: последний применённый импорт этого типа (register_imports.summary.source).
  if (!hosts) empty(DEFS.deploymentStale, NO_HOSTS);
  else {
    const last = await db.registerImport.findFirst({
      where: { registerId: hosts.reg.id, status: 'applied', summary: { path: ['source', 'reportType'], equals: 'deployment' } },
      orderBy: { appliedAt: 'desc' },
      select: { id: true, appliedAt: true, fileName: true },
    });
    if (!last?.appliedAt) empty(DEFS.deploymentStale, NO_DEPLOYMENT);
    else {
      const day = todayIso(last.appliedAt);
      const stale = day < addDaysIso(today, -DEPLOYMENT_MAX_AGE_DAYS);
      push(DEFS.deploymentStale, {
        checked: 1,
        violators: stale ? [{ id: last.id, title: last.fileName, href: `/registers#${hosts.reg.id}/records`, detail: `Загружен ${day}` }] : [],
        emptyMessage: NO_DEPLOYMENT,
      });
    }
  }

  // Регулярность сканирования: узлы «Без группы» сканов не получают и не считаются.
  const { scanMaxAgeDays } = await getVulnSettings(db);
  const nodes = await db.vulnNode.findMany({
    where: { systemKey: null, deletedAt: null, group: { deletedAt: null } },
    include: { group: true, systemType: true, scans: { select: { scanDate: true }, orderBy: { scanDate: 'desc' }, take: 1 } },
  });
  const staleNodes = nodes.flatMap((n) => {
    const last = n.scans[0] ? iso(n.scans[0].scanDate) : null;
    const { ageDays, stale } = scanFreshness(last, today, scanMaxAgeDays);
    return stale ? [{ id: n.id, title: nodeLabel(n), href: `/vulns/node/${n.id}`, detail: last ? `Последний скан: ${last}, ${ageDays} дн. назад` : 'Сканов нет' }] : [];
  });
  push({ ...DEFS.nodesScanned, title: `Узел уязвимостей сканировали за ${scanMaxAgeDays} дней` }, { checked: nodes.length, violators: staleNodes, emptyMessage: 'Нет данных: узлов уязвимостей нет' });

  // Удалённые открытые уязвимости (5.3, 1.6.1): удаление открытой записи снимает её с просрочек и эскалаций п. 7.4.
  // Знаменатель — все записи уязвимостей, удалённые за окно (не восстановленные); нарушения — открытые на момент удаления.
  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - DELETED_WINDOW_MONTHS);
  const deleted = await deletedVulns(db, since);
  push(DEFS.deletedOpen, {
    checked: deleted.length,
    violators: deleted.filter((d) => d.open).map((d) => ({
      id: `${d.deletionId}:${d.recordId}`,
      title: `#${d.number} ${d.title}`,
      href: `/settings/trash?id=${d.deletionId}`,
      detail: `${d.status || 'без статуса'}${d.due ? `, срок ${formatDateRu(d.due)}` : ''}. Удалена ${formatDateRu(d.deletedAt.slice(0, 10))}, ${d.deletedBy}: ${d.reason}`,
    })),
    emptyMessage: `Нет данных: записи уязвимостей за ${DELETED_WINDOW_MONTHS} месяцев не удалялись`,
  });

  return facts;
}

/** Адреса реестров для ссылок с экрана сверки. */
export async function assetRegisterIds(db: Db): Promise<{ services: string | null; components: string | null; hosts: string | null }> {
  const rows = await db.register.findMany({ where: { systemKey: { in: [ASSET_SERVICES_KEY, ASSET_COMPONENTS_KEY, ASSET_HOSTS_KEY] } }, select: { id: true, systemKey: true } });
  const idOf = (key: string) => rows.find((r) => r.systemKey === key)?.id ?? null;
  return { services: idOf(ASSET_SERVICES_KEY), components: idOf(ASSET_COMPONENTS_KEY), hosts: idOf(ASSET_HOSTS_KEY) };
}

/** Текст разделов методики, на которые ссылаются проверки. Только методика: оценки и баллы самооценки сюда не попадают (ADR-0026). */
export async function assetSections(db: Db, facts: readonly AssetFact[]) {
  const row = await db.assessmentMethodology.findFirst({ where: { isActive: true, archivedAt: null }, orderBy: { version: 'desc' } });
  if (!row) return [];
  const m = row.content as unknown as Methodology;
  const codes = new Set(facts.flatMap((f) => [f.section, ...f.relatedSections]));
  return m.domains.flatMap((d) => d.sections.filter((s) => codes.has(s.code)).map((s) => ({
    code: s.code,
    name: s.name,
    domainNo: d.no,
    domainName: d.name,
    key: s.key ?? false,
    target: s.target,
    levels: m.scale.map((l) => ({ level: l.level, name: l.name, criteria: s.criteria[String(l.level)] ?? '' })),
  })));
}

/** Настройки сверки и варианты для выбора. */
export async function assetSettingsView(db: Db) {
  const s = await getAssetSettings(db);
  const r = await db.register.findUnique({ where: { systemKey: ASSET_SERVICES_KEY }, select: { id: true } });
  const level = r ? byKey(await loadRegister(db, r.id), 'level') : undefined;
  return {
    significantLevelOptionIds: s.significantLevelOptionIds,
    version: s.version,
    levelOptions: level?.options.filter((o) => !o.archived).map((o) => ({ id: o.id, label: o.label })) ?? [],
  };
}
