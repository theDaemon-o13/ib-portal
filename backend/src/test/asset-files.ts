// Тестовые файлы импорта активов (релиз 1.6.0): отчёты KSC в SpreadsheetML и реестр сервисов в .xlsx.
// Генерируются кодом по описанию форматов; имена, адреса и люди вымышленные (TEST-PC01NB, 10.0.0.x, «Иванов И.»).
import ExcelJS from 'exceljs';

type Cell = string | number | Date | null;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xmlCell(v: Cell): string {
  if (v === null || v === '') return '<Cell/>';
  if (typeof v === 'number') return `<Cell><Data ss:Type="Number">${v}</Data></Cell>`;
  if (v instanceof Date) return `<Cell><Data ss:Type="DateTime">${v.toISOString().slice(0, 19)}.000</Data></Cell>`;
  return `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`;
}
const xmlSheet = (name: string, rows: Cell[][]) =>
  `<Worksheet ss:Name="${name}"><Table>${rows.map((r) => `<Row>${r.map(xmlCell).join('')}</Row>`).join('')}</Table></Worksheet>`;

/** Книга SpreadsheetML, как её сохраняет KSC (.xls). */
export function spreadsheetML(sheets: { name: string; rows: Cell[][] }[]): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n`
    + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" '
    + 'xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
    + `${sheets.map((s) => xmlSheet(s.name, s.rows)).join('')}</Workbook>`);
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

export interface DeploymentDevice { name: string; group?: string; agent?: string; product?: string; version?: string }
export interface BasesDevice { name: string; status: string; created: string; ip?: string; netbios?: string; domain?: string }
export interface VersionsRow { name: string; program: string; version?: string; installed?: string; visible?: string; connected?: string }

function summary(title: string, groups: [string, number][], total?: number): Cell[][] {
  return [
    ['Kaspersky Security Center'],
    [title],
    ['Отчет сформирован для группы «Управляемые устройства»'],
    [],
    ['Статус', 'Количество устройств'],
    ...groups.map(([g, n]) => [g, n] as Cell[]),
    ...(total !== undefined ? [['Всего', total] as Cell[]] : []),
  ];
}

/** «Отчет о развертывании защиты»: сводка по покрытию, детали — по устройству. summaryTotal — иное число в сводке (обрезанный отчёт). */
export function deploymentReport(devices: DeploymentDevice[], opts: { summaryTotal?: number } = {}): Buffer {
  const full = devices.filter((d) => d.agent && d.product).length;
  const agent = devices.filter((d) => d.agent && !d.product).length;
  const none = devices.length - full - agent;
  const groups: [string, number][] = opts.summaryTotal !== undefined
    ? [['Агент и защита', opts.summaryTotal]]
    : [['Агент и защита', full], ['Только агент', agent], ['Нет агента', none]];
  return spreadsheetML([
    { name: 'Summary', rows: summary('Отчет о развертывании защиты', groups, opts.summaryTotal ?? devices.length) },
    {
      name: 'Details',
      rows: [
        ['Виртуальный Сервер администрирования', 'Группа', 'Устройство', 'Версия Агента администрирования', 'Название программы безопасности', 'Версия программы безопасности'],
        ...devices.map((d) => ['', d.group ?? 'Филиал 1', d.name, d.agent ?? 'Неизвестно', d.product ?? 'Неизвестно', d.version ?? 'Неизвестно']),
      ],
    },
  ]);
}

export function basesReport(devices: BasesDevice[], title = 'Отчет о статусе антивирусных баз'): Buffer {
  const byStatus = new Map<string, number>();
  for (const d of devices) byStatus.set(d.status, (byStatus.get(d.status) ?? 0) + 1);
  return spreadsheetML([
    { name: 'Summary', rows: summary(title, [...byStatus.entries()]) },
    {
      name: 'Details',
      rows: [
        ['Виртуальный Сервер администрирования', 'Группа', 'Устройство', 'Программа', 'Номер версии', 'Созданы', 'Статус антивирусных баз', 'IP-адрес', 'NetBIOS-имя', 'Windows-домен', 'IPv6-адрес'],
        ...devices.map((d) => ['', 'Филиал 1', d.name, 'Kaspersky Endpoint Security для Windows', '12.5.0.1', day(d.created), d.status, d.ip ?? '', d.netbios ?? '', d.domain ?? 'EXAMPLE', '']),
      ],
    },
  ]);
}

export function versionsReport(rows: VersionsRow[]): Buffer {
  return spreadsheetML([
    { name: 'Summary', rows: [['Kaspersky Security Center'], ['Отчет о версиях программ "Лаборатории Касперского"'], [], ['Программа', 'Номер версии', 'Количество'], ['Kaspersky Endpoint Security для Windows', '12.5', rows.length]] },
    {
      name: 'Details',
      rows: [
        ['Программа', 'Номер версии', 'Виртуальный Сервер администрирования', 'Группа', 'Устройство', 'Установлено', 'Последнее появление в сети',
          'Последнее подключение к Серверу администрирования', 'IP-адрес', 'Установленные обновления', 'IPv6-адрес'],
        ...rows.map((r) => [r.program, r.version ?? '', '', 'Филиал 1', r.name, r.installed ? day(r.installed) : '', r.visible ? day(r.visible) : '', r.connected ? day(r.connected) : '', '', '', '']),
      ],
    },
  ]);
}

export function kscOtherReport(title: string): Buffer {
  return spreadsheetML([{ name: 'Summary', rows: [['Kaspersky Security Center'], [title]] }, { name: 'Details', rows: [['Устройство', 'Владелец']] }]);
}

export interface ServiceRow {
  name: string; type?: string; category?: string; location?: string; description?: string; os?: string; address?: string;
  owner?: string; classification?: string; team?: string;
}

/** Реестр сервисов в форме владельца: шапка в строках 1–4, строка 5 пустая, заголовки в строке 6, лист «Список активов». */
export async function serviceRegistry(rows: ServiceRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Список активов');
  ws.addRow(['Реестр ИТ-активов']);
  ws.addRow(['Подразделение:', 'Тестовый отдел']);
  ws.addRow(['Дата заполнения:', day('2026-10-01')]);
  ws.addRow(['Версия формы:', 'v3']);
  ws.addRow([]);
  ws.addRow(['№', 'Наименование актива', 'Тип актива', 'Важность/Критичность', 'Местоположение', 'Описание/назначение', 'Операционная система/ПО', 'IP-адрес', 'Владелец', 'Класификация', 'Команда']);
  rows.forEach((r, i) => ws.addRow([i + 1, r.name, r.type ?? 'Сервис', r.category ?? '', r.location ?? '', r.description ?? '', r.os ?? '', r.address ?? '', r.owner ?? '', r.classification ?? '', r.team ?? '']));
  wb.addWorksheet('Справочник').addRow(['Mission Critical', 'Business Critical', 'Business Operational', 'Office Productivity']);
  wb.addWorksheet('контакты').addRow(['Иванов И.', 'вымышленный']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
