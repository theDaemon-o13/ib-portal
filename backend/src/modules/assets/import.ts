// Адаптеры импорта активов (релиз 1.6.0, ADR-0032): реестр сервисов → «Компоненты», отчёт KSC → «Хосты».
// Адаптер только готовит лист с колонками по названиям полей и сведения для предпросмотра; предпросмотр,
// применение одной транзакцией и проверка версий — общий конвейер импорта реестров (excel.service.ts).
import ExcelJS from 'exceljs';
import type { Db } from '../../lib/db.js';
import { conflict } from '../../lib/errors.js';
import { linkKey, type Values } from '../../lib/register-values.js';
import { readSheets } from '../../lib/spreadsheetml.js';
import { loadRegister, type FieldMeta, type RegisterDef } from '../registers/definition.js';
import { IMPORT_MAX_ROWS, type ImportAdapter, type ImportBlock, type NewRecordGroup } from '../registers/excel.service.js';
import { readPortalParam } from '../settings/portal-params.js';
import { ASSET_COMPONENTS_KEY, ASSET_HOSTS_KEY, ASSET_SERVICES_KEY } from './definition.js';
import { hostTypeOf, parseKscReport, REPORT_NAMES, type HostTypeRules, type HostValues } from './ksc.js';
import { normalizeHostName } from './logic.js';
import { parseServiceRegistry } from './service-registry.js';

export type AssetAdapterKind = 'services' | 'ksc';

const BLOCK_ITEMS = 200;

const field = (reg: RegisterDef, key: string): FieldMeta => {
  const f = reg.fields.find((x) => x.systemKey === key && !x.archived);
  if (!f) throw conflict('ASSET_FIELD_MISSING', `В реестре «${reg.name}» нет системного поля «${key}». Обратитесь к администратору`);
  return f;
};
const optionId = (f: FieldMeta, key: string) => f.options.find((o) => o.systemKey === key && !o.archived)?.id;
const optionLabel = (f: FieldMeta, key: string) => f.options.find((o) => o.systemKey === key && !o.archived)?.label ?? '';
const knownLabel = (f: FieldMeta, label: string) => f.options.some((o) => !o.archived && o.label.trim().toLowerCase() === label.trim().toLowerCase());

/** Лист для конвейера: строка 1 — названия полей, дальше значения как в ячейках Excel. */
function sheetOf(fields: FieldMeta[], rows: (string | Date | null)[][]): { wb: ExcelJS.Workbook; ws: ExcelJS.Worksheet } {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Реестр');
  ws.addRow(fields.map((f) => f.label));
  for (const r of rows) ws.addRow(r);
  return { wb, ws };
}
const asDate = (iso: string | undefined) => (iso ? new Date(`${iso}T00:00:00Z`) : null);

function block(code: string, title: string, items: string[], hint: string | null, optional: boolean): ImportBlock {
  return { code, title, hint, items: items.slice(0, BLOCK_ITEMS), total: items.length, optional };
}

/** Новые значения списков: незнакомая метка → токен (значение создаётся при применении). */
function optionTokens() {
  const list: ImportAdapter['newOptions'] = [];
  return {
    list,
    add(f: FieldMeta, label: string) {
      if (!label || knownLabel(f, label) || list.some((o) => o.fieldId === f.id && o.label.toLowerCase() === label.toLowerCase())) return;
      list.push({ fieldId: f.id, label, token: `new:option:${list.length + 1}` });
    },
  };
}

export async function assetImportAdapter(db: Db, registerId: string, kind: AssetAdapterKind, buffer: Buffer): Promise<ImportAdapter> {
  const reg = await loadRegister(db, registerId);
  const expected = kind === 'services' ? ASSET_COMPONENTS_KEY : ASSET_HOSTS_KEY;
  if (reg.systemKey !== expected) {
    throw conflict('WRONG_ADAPTER', kind === 'services' ? 'Реестр сервисов загружается в реестр «Компоненты»' : 'Отчёты Kaspersky Security Center загружаются в реестр «Хосты»');
  }
  const sheets = await readSheets(buffer, IMPORT_MAX_ROWS + 20);
  return kind === 'services' ? servicesAdapter(db, reg, sheets) : kscAdapter(db, reg, sheets);
}

// ---------------------------------------------------------------- отчёт KSC → хосты

async function kscAdapter(db: Db, hosts: RegisterDef, sheets: Awaited<ReturnType<typeof readSheets>>): Promise<ImportAdapter> {
  const parsed = parseKscReport(sheets);
  const rules = await readPortalParam<HostTypeRules>(db, 'assets.hostTypeRules');
  const H = (key: string) => field(hosts, key);
  const byReport: Record<string, (keyof HostValues)[]> = {
    deployment: ['kscGroup', 'agentVersion', 'protectionProduct', 'protectionVersion', 'inKsc', 'coverage'],
    bases: ['basesStatus', 'basesDate', 'ip', 'domain'],
    versions: ['seen', 'lastVisible', 'installedOn', 'agentVersion'],
  };
  const keys = byReport[parsed.type] ?? [];
  const cols: FieldMeta[] = [H('name'), H('type'), H('source'), ...keys.map((k) => H(k))];
  const options = optionTokens();
  const unknownStatus = new Set<string>();
  const typeLabel = { server: optionLabel(H('type'), 'server'), workstation: optionLabel(H('type'), 'workstation'), other: optionLabel(H('type'), 'other') };

  const rows = parsed.devices.map((d) => {
    const status = d.values.basesStatus;
    if (status && !knownLabel(H('basesStatus'), status)) {
      unknownStatus.add(status);
      options.add(H('basesStatus'), status);
    }
    return [
      d.name, typeLabel[hostTypeOf(d, rules)] || null, optionLabel(H('source'), 'ksc') || null,
      ...keys.map((k) => {
        const v = d.values[k];
        return H(k).type === 'date' ? asDate(v) : v ?? null;
      }),
    ];
  });

  // Совпадение с хостом другого источника: поля KSC пишутся в него же (ключ один), о совпадении — предупреждение.
  const warnings = [...parsed.warnings];
  const existing = await db.registerRecord.findMany({ where: { registerId: hosts.id, deletedAt: null }, select: { values: true } });
  const kscId = optionId(H('source'), 'ksc');
  const deviceKeys = new Set(parsed.devices.map((d) => d.key));
  const others = existing.map((r) => r.values as Values).filter((v) => {
    const name = typeof v[H('name').id] === 'string' ? (v[H('name').id] as string) : '';
    return deviceKeys.has(normalizeHostName(name)) && v[H('source').id] && v[H('source').id] !== kscId;
  }).map((v) => String(v[H('name').id]));
  if (others.length) warnings.push(`Совпали с хостами из других источников (поля Kaspersky запишутся в них): ${others.slice(0, 20).join(', ')}${others.length > 20 ? '…' : ''}`);
  if (unknownStatus.size) warnings.push(`Новые значения «Статус антивирусных баз» добавятся в список: ${[...unknownStatus].join(', ')}`);
  if (parsed.type !== 'deployment') warnings.push('«Нет в файле» строится только по отчёту о развёртывании защиты');

  const inKscYes = optionId(H('inKsc'), 'yes');
  const blocks = parsed.duplicates.length
    ? [block('ksc_duplicates', 'Дубли в KSC — удалите устаревшие записи в консоли',
      parsed.duplicates.map((x) => `${x.stale.join(', ')} → оставлена ${x.kept}`), 'В хост записана самая свежая запись; устаревшие показаны слева', false)]
    : [];
  return {
    ...sheetOf(cols, rows),
    managedWritable: [H('coverage').id],
    createOnly: [H('name').id, H('type').id, H('source').id],
    missing: parsed.missingAllowed && inKscYes ? { fieldId: H('inKsc').id, optionId: inKscYes } : false,
    newOptions: options.list,
    newRecords: [],
    linkTokens: {},
    source: {
      adapter: 'ksc', reportType: parsed.type, reportTitle: parsed.title, reportName: REPORT_NAMES[parsed.type],
      summaryTotal: parsed.summaryTotal, detailsRows: parsed.detailsRows, devices: parsed.devices.length, duplicates: parsed.duplicates.length,
      missingAllowed: parsed.missingAllowed,
    },
    warnings,
    blocks,
  };
}

// ---------------------------------------------------------------- реестр сервисов → компоненты

async function servicesAdapter(db: Db, components: RegisterDef, sheets: Awaited<ReturnType<typeof readSheets>>): Promise<ImportAdapter> {
  const teams = await readPortalParam<Record<string, string>>(db, 'assets.teamProducts');
  const osTable = await readPortalParam<Record<string, string>>(db, 'assets.osNormalization');
  const parsed = parseServiceRegistry(sheets, { teams, os: osTable });
  const C = (key: string) => field(components, key);

  const servicesRow = await db.register.findUnique({ where: { systemKey: ASSET_SERVICES_KEY }, select: { id: true, archivedAt: true } });
  const hostsRow = await db.register.findUnique({ where: { systemKey: ASSET_HOSTS_KEY }, select: { id: true, archivedAt: true } });
  if (!servicesRow || servicesRow.archivedAt || !hostsRow || hostsRow.archivedAt) throw conflict('ASSET_REGISTER_MISSING', 'Реестры «Сервисы» и «Хосты» недоступны');
  const services = await loadRegister(db, servicesRow.id);
  const hosts = await loadRegister(db, hostsRow.id);
  const S = (key: string) => field(services, key);
  const H = (key: string) => field(hosts, key);

  // Продукты: по названию (без регистра и лишних пробелов). Нет — будет создан со статусом «Работает».
  const productRows = await db.registerRecord.findMany({ where: { registerId: services.id, deletedAt: null }, select: { number: true, values: true } });
  const productByName = new Map<string, number[]>();
  for (const r of productRows) {
    const t = (r.values as Values)[S('title').id];
    if (typeof t === 'string') productByName.set(linkKey(t), [...(productByName.get(linkKey(t)) ?? []), r.number]);
  }
  // Хосты: по имени (ключ импорта) или по полю «IP-адрес».
  const hostRows = await db.registerRecord.findMany({ where: { registerId: hosts.id, deletedAt: null }, select: { number: true, values: true } });
  const hostByIp = new Map<string, number>();
  for (const r of hostRows) {
    const v = r.values as Values;
    for (const x of [v[H('name').id], v[H('ip').id]]) if (typeof x === 'string' && x.trim() && !hostByIp.has(x.trim().toLowerCase())) hostByIp.set(x.trim().toLowerCase(), r.number);
  }

  const productGroup: NewRecordGroup = { block: 'new_products', registerId: services.id, items: [] };
  const hostGroup: NewRecordGroup = { block: 'new_hosts', registerId: hosts.id, items: [] };
  const productTokens = new Map<string, string>();
  const hostTokens = new Map<string, string>();
  const linkTokens: ImportAdapter['linkTokens'] = { [C('product').id]: {}, [C('host').id]: {} };
  const options = optionTokens();
  const working = optionId(S('status'), 'working');
  const server = optionId(H('type'), 'server');
  const fromServices = optionId(H('source'), 'services');

  const productCell = (name: string): string | null => {
    if (!name) return null;
    const found = productByName.get(linkKey(name)) ?? [];
    if (found.length === 1) return `#${found[0]}`;
    if (found.length > 1) return name; // неоднозначно — ошибка строки в предпросмотре
    let token = productTokens.get(linkKey(name));
    if (!token) {
      token = `new:product:${productTokens.size + 1}`;
      productTokens.set(linkKey(name), token);
      productGroup.items.push({ token, values: { [S('title').id]: name, ...(working ? { [S('status').id]: working } : {}) } });
      (linkTokens[C('product').id] as Record<string, string>)[token] = token;
    }
    return token;
  };
  const hostCell = (ip: string, complete: boolean): string | null => {
    if (!ip || !complete) return null;
    const found = hostByIp.get(ip.toLowerCase());
    if (found !== undefined) return `#${found}`;
    let token = hostTokens.get(ip);
    if (!token) {
      token = `new:host:${hostTokens.size + 1}`;
      hostTokens.set(ip, token);
      hostGroup.items.push({
        token,
        values: { [H('name').id]: ip, [H('ip').id]: ip, ...(server ? { [H('type').id]: server } : {}), ...(fromServices ? { [H('source').id]: fromServices } : {}) },
      });
      (linkTokens[C('host').id] as Record<string, string>)[token] = token;
    }
    return token;
  };

  const cols: FieldMeta[] = [
    C('instance'), C('title'), C('product'), C('key'), C('assetType'), C('level'), C('env'), C('status'), C('description'),
    C('os'), C('osSource'), C('ip'), C('port'), C('host'), C('location'), C('owner'), C('team'),
  ];
  const rows = parsed.rows.map((r) => {
    options.add(C('location'), r.location);
    return [
      r.instance, r.component, productCell(r.product), r.key, r.assetType || null, r.category || null, r.env || null, r.status || null, r.description || null,
      r.os || null, r.osSource || null, r.ip || null, r.port || null, hostCell(r.ip, r.ipComplete), r.location || null, r.owner || null, r.team || null,
    ];
  });
  const newLocations = options.list.map((o) => o.label);
  const warnings = [...parsed.warnings];
  if (newLocations.length) warnings.push(`Новые значения «Местоположение» добавятся в список: ${newLocations.join(', ')}`);

  const productNames = productGroup.items.map((it) => String(it.values[S('title').id]));
  const blocks: ImportBlock[] = [];
  if (productNames.length) {
    blocks.push(block('new_products', `Будут созданы продукты: ${productNames.length}`, productNames,
      'Продукт без соответствия в таблице — с именем команды. Чтобы объединить команды в один продукт, заполните «Параметры портала → Активы: команды → продукты» до импорта', false));
  }
  if (hostGroup.items.length) {
    blocks.push(block('new_hosts', `Будут созданы хосты: ${hostGroup.items.length}`, [...hostTokens.keys()],
      'Тип «Сервер», источник «Реестр сервисов», имя — IP-адрес. Снимите, чтобы не создавать: компоненты останутся без хоста', true));
  }
  return {
    ...sheetOf(cols, rows),
    managedWritable: [C('instance').id, C('key').id, C('osSource').id],
    createOnly: [C('status').id],
    missing: true,
    newOptions: options.list,
    newRecords: [productGroup, hostGroup].filter((g) => g.items.length),
    linkTokens,
    source: { adapter: 'services', sheet: parsed.sheet, headerRow: parsed.headerRow, components: parsed.rows.length, newProducts: productNames.length, newHosts: hostGroup.items.length },
    warnings,
    blocks,
  };
}
