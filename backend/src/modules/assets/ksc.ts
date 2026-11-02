// Отчёты Kaspersky Security Center → строки реестра «Хосты» (релиз 1.6.0, ADR-0032). Чистые функции без БД.
// Каждый отчёт обновляет только свои поля; ключ — имя устройства без домена; дубли внутри отчёта — свежая запись.
import { badRequest, conflict } from '../../lib/errors.js';
import { cellString, type SheetCell, type SheetData } from '../../lib/spreadsheetml.js';
import { normalizeHostName } from './logic.js';

export type KscReportType = 'deployment' | 'bases' | 'versions';

/** Название отчёта (строка 2 листа Summary) → тип. Сравнение без регистра, кавычек и «ё». */
const REPORTS: { type: KscReportType; titles: string[] }[] = [
  { type: 'deployment', titles: ['Отчет о развертывании защиты'] },
  { type: 'bases', titles: ['Отчет о статусе антивирусных баз', 'Отчет об используемых антивирусных базах'] },
  { type: 'versions', titles: ['Отчет о версиях программ Лаборатории Касперского'] },
];
const NOT_NEEDED = ['Отчет о владельцах устройств', 'Отчет о реестре оборудования'];
export const REPORT_NAMES: Record<KscReportType, string> = {
  deployment: 'Отчёт о развёртывании защиты',
  bases: 'Отчёт о статусе антивирусных баз',
  versions: 'Отчёт о версиях программ «Лаборатории Касперского»',
};
/** Известные лимиты детальной части отчёта: ровно столько строк — вероятно, отчёт обрезан. */
export const KSC_ROW_LIMITS = [1000, 5000, 10000, 100000];

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/["«»“”„']/g, '').replace(/\s+/g, ' ').trim();
const UNKNOWN = 'неизвестно';
/** «Неизвестно» в отчёте — значения нет. */
const value = (v: SheetCell | undefined) => {
  const s = cellString(v);
  return norm(s) === UNKNOWN ? '' : s;
};
const dateOf = (v: SheetCell | undefined): string => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const s = cellString(v);
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
};

/** Поля хоста, которые ставит отчёт (ключи — системные ключи полей «Хостов»). */
export type HostValues = Partial<Record<
  'kscGroup' | 'agentVersion' | 'protectionProduct' | 'protectionVersion' | 'inKsc' | 'coverage' | 'basesStatus' | 'basesDate'
  | 'ip' | 'domain' | 'seen' | 'lastVisible' | 'installedOn', string>>;

export interface KscDevice {
  key: string;
  /** Имя для нового хоста: «Устройство» без домена, как написано. */
  name: string;
  values: HostValues;
  /** Для правил типа нового хоста. */
  product: string;
  group: string;
}

export interface KscDuplicate {
  key: string;
  kept: string;
  stale: string[];
}

export interface KscParsed {
  type: KscReportType;
  title: string;
  /** Итог сводки (сумма «Количество устройств»); null — однозначно не посчитать. */
  summaryTotal: number | null;
  detailsRows: number;
  devices: KscDevice[];
  duplicates: KscDuplicate[];
  warnings: string[];
  /** «Нет в файле» можно считать: отчёт о развёртывании, не обрезан. */
  missingAllowed: boolean;
}

function sheetByName(sheets: SheetData[], name: string): SheetData | undefined {
  return sheets.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
}

/** Тип отчёта по строке 2 листа Summary. Ненужный или неизвестный отчёт — понятная ошибка. */
export function detectReport(sheets: SheetData[]): { type: KscReportType; title: string } {
  const summary = sheetByName(sheets, 'Summary');
  if (!summary || !sheetByName(sheets, 'Details')) {
    throw badRequest('KSC_UNKNOWN', 'Это не отчёт Kaspersky Security Center: нужны листы Summary и Details');
  }
  const title = cellString(summary.rows[1]?.find((c) => cellString(c) !== ''));
  const t = norm(title);
  const hit = REPORTS.find((r) => r.titles.some((x) => t.startsWith(norm(x))));
  if (hit) return { type: hit.type, title };
  if (NOT_NEEDED.some((x) => t.startsWith(norm(x)))) {
    throw badRequest('KSC_NOT_NEEDED', `«${title}» для реестра хостов не нужен. Загрузите отчёт о развёртывании защиты, о статусе антивирусных баз или о версиях программ`);
  }
  throw badRequest('KSC_UNKNOWN', `Неизвестный отчёт KSC${title ? `: «${title}»` : ''}. Принимаются отчёты о развёртывании защиты, о статусе антивирусных баз и о версиях программ`);
}

/** Итог сводки: сумма колонки «Количество устройств» под её заголовком, без строк «Всего» и «Итого». */
export function summaryTotal(summary: SheetData): number | null {
  for (const [i, row] of summary.rows.entries()) {
    const col = row.findIndex((c) => norm(cellString(c)) === 'количество устройств');
    if (col < 0) continue;
    let sum = 0;
    let found = false;
    for (const r of summary.rows.slice(i + 1)) {
      if (r.every((c) => cellString(c) === '')) {
        if (found) break;
        continue;
      }
      if (r.some((c) => /^(всего|итого)/.test(norm(cellString(c))))) continue;
      const v = r[col];
      const n = typeof v === 'number' ? v : Number(cellString(v).replace(/\s/g, ''));
      if (Number.isFinite(n) && cellString(v) !== '') {
        sum += n;
        found = true;
      }
    }
    return found ? sum : null;
  }
  return null;
}

/** Колонки листа Details по названию заголовка (строка 1). */
function columns(details: SheetData): (name: string) => number {
  const headers = (details.rows[0] ?? []).map((c) => norm(cellString(c)));
  return (name: string) => headers.indexOf(norm(name));
}

interface RawRow { raw: string; key: string; date: string; device: KscDevice }

/** Строки одного устройства → одна (самая свежая по дате), остальные — дубли, если имя в KSC написано иначе. */
function dedupe(rows: RawRow[]): { devices: KscDevice[]; duplicates: KscDuplicate[] } {
  const byKey = new Map<string, RawRow[]>();
  for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  const devices: KscDevice[] = [];
  const duplicates: KscDuplicate[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => b.date.localeCompare(a.date));
    const kept = sorted[0] as RawRow;
    devices.push(kept.device);
    const stale = [...new Set(sorted.slice(1).map((r) => r.raw))].filter((r) => r !== kept.raw);
    if (stale.length) duplicates.push({ key, kept: kept.raw, stale });
  }
  return { devices, duplicates };
}

const nameOf = (raw: string) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : (raw.split('.')[0] ?? raw));

export function parseKscReport(sheets: SheetData[]): KscParsed {
  const { type, title } = detectReport(sheets);
  const summary = sheetByName(sheets, 'Summary') as SheetData;
  const details = sheetByName(sheets, 'Details') as SheetData;
  const col = columns(details);
  const deviceCol = col('Устройство');
  if (deviceCol < 0) throw badRequest('KSC_UNKNOWN', 'В листе Details нет колонки «Устройство»');
  const dataRows = details.rows.slice(1).filter((r) => cellString(r[deviceCol]) !== '');
  const warnings: string[] = [];

  // Обрезанный отчёт: где итог сводки однозначен — блокировка, иначе предупреждение и без «Нет в файле».
  const total = type === 'versions' ? null : summaryTotal(summary);
  let missingAllowed = type === 'deployment';
  if (total !== null && total !== dataRows.length) {
    throw conflict('KSC_TRUNCATED', `Отчёт обрезан: в сводке ${total} устройств, в таблице ${dataRows.length}. Увеличьте в KSC лимит записей в свойствах шаблона отчёта и выгрузите заново`);
  }
  if (total === null && KSC_ROW_LIMITS.includes(dataRows.length)) {
    warnings.push(`В таблице ровно ${dataRows.length} строк — похоже на лимит KSC, отчёт может быть обрезан. Список «Нет в файле» не строится. Увеличьте лимит записей в шаблоне отчёта`);
    missingAllowed = false;
  }

  const get = (r: SheetCell[], name: string) => {
    const i = col(name);
    return i < 0 ? undefined : r[i];
  };
  const base = (r: SheetCell[]) => {
    const raw = cellString(r[deviceCol]);
    return { raw, key: normalizeHostName(raw), name: nameOf(raw), group: value(get(r, 'Группа')) };
  };
  const rows: RawRow[] = [];

  if (type === 'deployment') {
    for (const r of dataRows) {
      const b = base(r);
      const agent = value(get(r, 'Версия Агента администрирования'));
      const product = value(get(r, 'Название программы безопасности'));
      const version = value(get(r, 'Версия программы безопасности'));
      const coverage = !agent ? 'Нет агента' : product && version ? 'Агент и защита' : 'Только агент';
      // Дат в отчёте нет: из дублей свежее та запись, где больше сведений (агент, затем защита).
      const date = agent ? (product ? '2' : '1') : '0';
      rows.push({
        raw: b.raw, key: b.key, date,
        device: {
          key: b.key, name: b.name, product, group: b.group,
          values: { kscGroup: b.group, agentVersion: agent, protectionProduct: product, protectionVersion: version, inKsc: 'Да', coverage },
        },
      });
    }
  } else if (type === 'bases') {
    for (const r of dataRows) {
      const b = base(r);
      const netbios = value(get(r, 'NetBIOS-имя'));
      if (netbios && normalizeHostName(netbios) !== b.key) warnings.push(`«${b.raw}»: NetBIOS-имя «${netbios}» не совпадает с именем устройства`);
      const created = dateOf(get(r, 'Созданы'));
      rows.push({
        raw: b.raw, key: b.key, date: created,
        device: {
          key: b.key, name: b.name, product: value(get(r, 'Программа')), group: b.group,
          values: { basesStatus: value(get(r, 'Статус антивирусных баз')), basesDate: created, ip: value(get(r, 'IP-адрес')), domain: value(get(r, 'Windows-домен')) },
        },
      });
    }
  } else {
    // Строка = программа × устройство: защита даёт даты, агент — только версию, сервер администрирования пропускается.
    const agents = new Map<string, string>();
    const protection: RawRow[] = [];
    const seenOnly = new Map<string, RawRow>();
    for (const r of dataRows) {
      const b = base(r);
      const program = value(get(r, 'Программа'));
      const p = norm(program);
      const connected = dateOf(get(r, 'Последнее подключение к Серверу администрирования'));
      if (p.includes('сервер администрирования')) continue;
      if (p.includes('агент администрирования')) {
        agents.set(b.raw, value(get(r, 'Номер версии')));
        if (!seenOnly.has(b.raw)) seenOnly.set(b.raw, { raw: b.raw, key: b.key, date: connected, device: { key: b.key, name: b.name, product: '', group: b.group, values: {} } });
        continue;
      }
      if (!/endpoint security|security (для|for) windows server/.test(p)) continue;
      protection.push({
        raw: b.raw, key: b.key, date: connected,
        device: {
          key: b.key, name: b.name, product: program, group: b.group,
          values: { seen: connected, lastVisible: dateOf(get(r, 'Последнее появление в сети')), installedOn: dateOf(get(r, 'Установлено')) },
        },
      });
    }
    const withProtection = new Set(protection.map((r) => r.raw));
    for (const r of [...protection, ...[...seenOnly.values()].filter((s) => !withProtection.has(s.raw))]) {
      const agent = agents.get(r.raw);
      if (agent) r.device.values.agentVersion = agent;
      rows.push(r);
    }
  }

  const { devices, duplicates } = dedupe(rows);
  // Пустые значения не передаются: пустая ячейка не меняет поле хоста.
  for (const d of devices) d.values = Object.fromEntries(Object.entries(d.values).filter(([, v]) => v)) as HostValues;
  return { type, title, summaryTotal: total, detailsRows: dataRows.length, devices, duplicates, warnings, missingAllowed };
}

export interface HostTypeRules {
  server: { products: string[]; groups: string[]; namePatterns: string[] };
  workstation: { namePatterns: string[] };
}

/** Тип нового хоста по правилам «Параметров портала»: сервер, рабочая станция, иначе «Другое». */
export function hostTypeOf(d: Pick<KscDevice, 'name' | 'product' | 'group'>, rules: HostTypeRules): 'server' | 'workstation' | 'other' {
  const has = (patterns: string[], s: string) => patterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(s);
    } catch {
      return false;
    }
  });
  const product = d.product.toLowerCase();
  if (rules.server.products.some((p) => product.includes(p.toLowerCase()))) return 'server';
  if (rules.server.groups.some((g) => g.toLowerCase() === d.group.toLowerCase())) return 'server';
  if (has(rules.server.namePatterns, d.name)) return 'server';
  if (has(rules.workstation.namePatterns, d.name)) return 'workstation';
  return 'other';
}
