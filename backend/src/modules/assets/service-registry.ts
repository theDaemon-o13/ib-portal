// Реестр сервисов в Excel (форма владельца, v3) → строки реестра «Компоненты» (релиз 1.6.0, ADR-0032).
// Чистые функции без БД: поиск заголовков, перевод шкалы и «Класификации», IP:порт, нормализация ОС, продукт по команде.
import { badRequest } from '../../lib/errors.js';
import { cellString, type SheetData } from '../../lib/spreadsheetml.js';

const SHEET = 'Список активов';
const TITLE_HEADER = 'Наименование актива';
const HEADER_SCAN_ROWS = 12;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Старая шкала → категория процедуры. Mission и Business Critical — как есть; другое — предупреждение, поле пустое. */
const SCALE: Record<string, string> = {
  'mission critical': 'Mission Critical',
  'business critical': 'Business Critical',
  'business operatinal': 'Operational',
  'business operational': 'Operational',
  operational: 'Operational',
  'office productivity': 'Non-Critical',
  'non-critical': 'Non-Critical',
};

/** «Класификация» в файле — на деле статус: среда и статус компонента. */
const CLASSIFICATION: Record<string, { env: 'Prod' | 'Test'; status: string }> = {
  'в эксплуатации': { env: 'Prod', status: 'Работает' },
  'тест/внедрение': { env: 'Test', status: 'Работает' },
  тест: { env: 'Test', status: 'Работает' },
};

export function translateCategory(raw: string): { value: string; known: boolean } {
  const s = norm(raw);
  if (!s) return { value: '', known: true };
  const hit = SCALE[s];
  return hit ? { value: hit, known: true } : { value: '', known: false };
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** «IP:порт» → IP и порт. Неполный адрес (меньше четырёх октетов) остаётся как есть, с признаком. */
export function splitAddress(raw: string): { ip: string; port: string; complete: boolean } {
  const s = raw.trim();
  if (!s) return { ip: '', port: '', complete: true };
  const m = /^(.+?):(\d{1,5})$/.exec(s);
  const ip = (m ? m[1] : s)?.trim() ?? '';
  return { ip, port: m?.[2] ?? '', complete: IPV4.test(ip) };
}

/** Написание ОС → вид из таблицы (без учёта регистра и лишних пробелов); нет в таблице — как есть. */
export function normalizeOs(raw: string, table: Record<string, string>): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const hit = Object.entries(table).find(([k]) => norm(k) === norm(s));
  return hit ? hit[1] : s;
}

/** Ключ компонента: «Компонент / Продукт» без регистра и пробелов по краям. */
export function componentKey(component: string, product: string): string {
  return `${component.trim().toLowerCase()} / ${product.trim().toLowerCase()}`;
}

/** Продукт по команде: таблица «команды → продукты»; команды нет в таблице — продукт с тем же именем. */
export function productOf(team: string, table: Record<string, string>): string {
  const t = team.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return Object.entries(table).find(([k]) => norm(k) === norm(t))?.[1].trim() ?? t;
}

export interface ComponentRow {
  /** Строка файла (для сообщений). */
  row: number;
  component: string;
  product: string;
  team: string;
  assetType: string;
  category: string;
  location: string;
  description: string;
  os: string;
  osSource: string;
  ip: string;
  port: string;
  ipComplete: boolean;
  owner: string;
  env: string;
  status: string;
  key: string;
}

export interface ServiceRegistryParsed {
  sheet: string;
  headerRow: number;
  rows: ComponentRow[];
  warnings: string[];
}

const COLUMNS = {
  component: [TITLE_HEADER],
  assetType: ['Тип актива'],
  category: ['Важность/Критичность', 'Важность / Критичность', 'Критичность'],
  location: ['Местоположение'],
  description: ['Описание/назначение', 'Описание / назначение', 'Описание'],
  os: ['Операционная система/ПО', 'Операционная система / ПО', 'ОС/ПО'],
  address: ['IP-адрес', 'IP адрес'],
  owner: ['Владелец'],
  classification: ['Класификация', 'Классификация'],
  team: ['Команда'],
} as const;

export function parseServiceRegistry(sheets: SheetData[], tables: { teams: Record<string, string>; os: Record<string, string> }): ServiceRegistryParsed {
  const hasTitle = (s: SheetData) => s.rows.slice(0, HEADER_SCAN_ROWS).findIndex((r) => r.some((c) => norm(cellString(c)) === norm(TITLE_HEADER)));
  const sheet = sheets.find((s) => norm(s.name) === norm(SHEET) && hasTitle(s) >= 0) ?? sheets.find((s) => hasTitle(s) >= 0);
  if (!sheet) throw badRequest('SERVICES_FORMAT', `Не найден лист с колонкой «${TITLE_HEADER}» в первых ${HEADER_SCAN_ROWS} строках. Нужна форма реестра сервисов, лист «${SHEET}»`);
  const headerIndex = hasTitle(sheet);
  const headers = (sheet.rows[headerIndex] ?? []).map((c) => norm(cellString(c)));
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, headers.findIndex((h) => names.some((n) => norm(n) === h))])) as Record<keyof typeof COLUMNS, number>;
  const warnings: string[] = [];
  const unknownScale = new Set<string>();
  const unknownClass = new Set<string>();
  const partialIp: number[] = [];
  const rows: ComponentRow[] = [];

  for (const [i, r] of sheet.rows.slice(headerIndex + 1).entries()) {
    const at = (k: keyof typeof COLUMNS) => (col[k] < 0 ? '' : cellString(r[col[k]]));
    const component = at('component');
    if (!component) continue;
    const row = headerIndex + 2 + i;
    const cat = translateCategory(at('category'));
    if (!cat.known) unknownScale.add(at('category'));
    const cls = CLASSIFICATION[norm(at('classification'))];
    if (!cls && at('classification')) unknownClass.add(at('classification'));
    const addr = splitAddress(at('address'));
    if (!addr.complete) partialIp.push(row);
    const team = at('team');
    const product = productOf(team, tables.teams);
    const osRaw = at('os');
    rows.push({
      row, component, product, team,
      assetType: at('assetType'),
      category: cat.value,
      location: at('location'),
      description: at('description'),
      os: normalizeOs(osRaw, tables.os),
      osSource: osRaw,
      ip: addr.ip, port: addr.port, ipComplete: addr.complete,
      owner: at('owner'),
      env: cls?.env ?? '',
      status: cls?.status ?? '',
      key: componentKey(component, product),
    });
  }
  if (unknownScale.size) warnings.push(`Неизвестные значения «Важность/Критичность» — категория не заполнена: ${[...unknownScale].join(', ')}`);
  if (unknownClass.size) warnings.push(`Неизвестные значения «Класификация» — среда и статус не заполнены: ${[...unknownClass].join(', ')}`);
  if (partialIp.length) warnings.push(`Неполный IP-адрес сохранён как есть, хост не создаётся — строки ${partialIp.slice(0, 20).join(', ')}${partialIp.length > 20 ? '…' : ''}`);
  const noTeam = rows.filter((r) => !r.product).map((r) => r.row);
  if (noTeam.length) warnings.push(`Без команды — продукт не указан: строки ${noTeam.slice(0, 20).join(', ')}${noTeam.length > 20 ? '…' : ''}`);
  return { sheet: sheet.name, headerRow: headerIndex + 1, rows, warnings };
}
