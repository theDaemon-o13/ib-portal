// Стартовые несистемные значения. Создаются только при первой установке (отметка в seed_markers):
// повторный seed не восстанавливает то, что администратор удалил или отправил в архив.
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { CatalogCode } from '../../src/lib/catalogs.js';
import type { Tone } from '../../src/lib/tones.js';

type Tx = Prisma.TransactionClient;

const STARTER_ITEMS: { catalog: CatalogCode; value: string; color?: Tone; keywords?: string[] }[] = [
  { catalog: 'task_categories', value: 'Проект', color: 'accent' },
  { catalog: 'task_categories', value: 'Оперплан', color: 'low' },
  ...['АБС', 'Интернет-банк', 'Процессинг', 'AD', 'Почта'].map((value) => ({ catalog: 'systems' as const, value })),
  ...['Политика', 'Процедура', 'Инструкция', 'Регламент', 'Положение', 'План', 'Методика'].map((value) => ({
    catalog: 'document_types' as const,
    value,
  })),
  // Ответственных администратор назначает сам: пользователи из прототипа — примерные.
  { catalog: 'mail_rules', value: 'Доступ', keywords: ['доступ', 'учетн', 'учётн', 'увольн', 'блокир', 'права', 'пароль'] },
  { catalog: 'mail_rules', value: 'Инцидент', keywords: ['подозрит', 'фишинг', 'вирус', 'вложени', '.iso', 'взлом', 'утечк'] },
  { catalog: 'mail_rules', value: 'WAF / сеть', keywords: ['waf', 'api', 'порт', 'межсетев', 'firewall'] },
  { catalog: 'mail_rules', value: 'Аудит / регулятор', keywords: ['аудит', 'нбт', 'регулятор', 'запрос информации'] },
  { catalog: 'mail_rules', value: 'DLP', keywords: ['dlp', 'носител', 'usb', 'флеш'] },
];

const STARTER_TEMPLATES = [
  {
    name: 'Подтверждение соответствия требованиям парольной защиты',
    basis: 'Инструкция по парольной защите',
    validMonths: 12,
    fields: [
      { label: 'Минимальная длина пароля', checkKind: 'min', threshold: 12 },
      { label: 'Классов символов (A, a, 0–9, !)', checkKind: 'min', threshold: 3 },
      { label: 'Максимальный срок действия, дней', checkKind: 'max', threshold: 90 },
      { label: 'Блокировка после неудачных попыток', checkKind: 'max', threshold: 5 },
      { label: 'Запрет повтора последних паролей', checkKind: 'min', threshold: 5 },
      { label: 'MFA для привилегированных УЗ', checkKind: 'yes', threshold: null },
    ],
  },
  {
    name: 'Акт пересмотра прав доступа',
    basis: 'Политика информационной безопасности',
    validMonths: 3,
    fields: [
      { label: 'Проверено учётных записей', checkKind: 'min', threshold: 1 },
      { label: 'Отозвано лишних прав (кратко)', checkKind: 'text', threshold: null },
      { label: 'Привилегированные УЗ согласованы с ИБ', checkKind: 'yes', threshold: null },
    ],
  },
];

/** Постоянные праздники РТ. Иди Рамазон, Иди Курбон и переносы администратор добавляет сам. */
const RT_HOLIDAYS: [string, string][] = [
  ['01-01', 'Новый год'],
  ['03-08', 'День матери'],
  ['03-21', 'Навруз'],
  ['03-22', 'Навруз'],
  ['03-23', 'Навруз'],
  ['03-24', 'Навруз'],
  ['05-01', 'Международный день трудящихся'],
  ['05-09', 'День Победы'],
  ['06-27', 'День национального единства'],
  ['09-09', 'День государственной независимости'],
  ['11-06', 'День Конституции'],
];
const CALENDAR_YEARS = [2026, 2027];

/** Выполнить fn один раз за всю жизнь базы. */
async function once(tx: Tx, key: string, fn: () => Promise<string>): Promise<void> {
  const done = await tx.seedMarker.findUnique({ where: { key } });
  if (done) return;
  const summary = await fn();
  await tx.seedMarker.create({ data: { key } });
  console.log(summary);
}

export async function seedStarter(tx: Tx): Promise<void> {
  await once(tx, 'starter.catalog_items.v1', async () => {
    let created = 0;
    for (const item of STARTER_ITEMS) {
      const clash = await tx.catalogItem.findFirst({
        where: { catalogCode: item.catalog, deletedAt: null, value: { equals: item.value, mode: 'insensitive' } },
      });
      if (clash) continue;
      const max = await tx.catalogItem.aggregate({ where: { catalogCode: item.catalog }, _max: { sortOrder: true } });
      await tx.catalogItem.create({
        data: {
          catalogCode: item.catalog,
          value: item.value,
          color: item.color ?? null,
          keywords: item.keywords ?? [],
          sortOrder: (max._max.sortOrder ?? 0) + 1,
        },
      });
      created++;
    }
    return `Стартовые значения справочников: ${created}`;
  });

  await once(tx, 'starter.form_templates.v1', async () => {
    let created = 0;
    for (const t of STARTER_TEMPLATES) {
      const clash = await tx.formTemplate.findFirst({
        where: { deletedAt: null, name: { equals: t.name, mode: 'insensitive' } },
      });
      if (clash) continue;
      await tx.formTemplate.create({
        data: {
          name: t.name,
          basis: t.basis,
          validMonths: t.validMonths,
          fields: {
            create: t.fields.map((f, i) => ({ label: f.label, checkKind: f.checkKind, threshold: f.threshold, sortOrder: i + 1 })),
          },
        },
      });
      created++;
    }
    return `Стартовые шаблоны форм: ${created}`;
  });

  await once(tx, 'calendar.rt_holidays.2026-2027', async () => {
    let created = 0;
    for (const year of CALENDAR_YEARS) {
      for (const [md, title] of RT_HOLIDAYS) {
        const day = new Date(`${year}-${md}T00:00:00Z`);
        const exists = await tx.workCalendarDay.findFirst({ where: { day, deletedAt: null } });
        if (exists) continue;
        await tx.workCalendarDay.create({ data: { day, kind: 'holiday', title } });
        created++;
      }
    }
    return `Праздники РТ на ${CALENDAR_YEARS.join(' и ')}: ${created}`;
  });
}
