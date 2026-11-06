// Набор справочников фиксирован (CLAUDE.md, раздел 6). Значения в них настраиваются в интерфейсе.
import type { Tone } from './tones.js';

export type CatalogKind = 'values' | 'statuses' | 'mail_rules';

export interface CatalogDef {
  code: string;
  name: string;
  description: string;
  kind: CatalogKind;
  hasColor: boolean;
}

export const CATALOGS = [
  { code: 'task_categories', name: 'Категории задач', description: 'Задачи: доска, фильтры, карточка и быстрая постановка', kind: 'values', hasColor: true },
  { code: 'task_statuses', name: 'Статусы задач', description: 'Колонки доски задач. Пять системных колонок процесса можно переименовать; свои колонки — добавить. У колонки — обязателен ли комментарий при переходе вперёд и при возврате', kind: 'statuses', hasColor: false },
  { code: 'task_priorities', name: 'Приоритеты задач', description: 'Карточка задачи, черновик задачи из письма', kind: 'values', hasColor: false },
  { code: 'mail_rules', name: 'Правила разбора почты', description: 'Почта → задача: ключевые слова определяют категорию письма и ответственного', kind: 'mail_rules', hasColor: false },
  { code: 'systems', name: 'Системы', description: 'Владелец системы, поле «Система» реестров, риски ИБ (актив), формы подтверждения', kind: 'values', hasColor: false },
  { code: 'system_types', name: 'Типы систем', description: 'Раздел «Уязвимости»: узлы групп — группа × тип систем (БД, серверы, рабочие станции …)', kind: 'values', hasColor: false },
  { code: 'document_types', name: 'Типы документов', description: 'Реестр внутренних документов ИБ', kind: 'values', hasColor: false },
  { code: 'notify_recipients', name: 'Получатели уведомлений', description: 'Метки получателей событий автоматизаций: пользователи портала и e-mail', kind: 'values', hasColor: false },
] as const satisfies readonly CatalogDef[];

export type CatalogCode = (typeof CATALOGS)[number]['code'];

/** Справочник меток получателей: у значения — участники (пользователи с ib.work) и e-mail. */
export const RECIPIENTS_CATALOG = 'notify_recipients';
/** Справочник систем: у значения — владелец системы. */
export const SYSTEMS_CATALOG = 'systems';
/** Справочник типов документов: тип документа ссылается на значение по id. */
export const DOCUMENT_TYPES_CATALOG = 'document_types';
/** Метка «Владелец системы»: участников нет, получатель — владелец системы записи. */
export const SYSTEM_OWNER_KEY = 'system_owner';

export const CATALOG_CODES = CATALOGS.map((c) => c.code) as [CatalogCode, ...CatalogCode[]];

export interface SystemItemDef {
  catalog: CatalogCode;
  key: string;
  value: string;
  color?: Tone;
  /** Пояснение, почему значение системное. */
  why: string;
}

/** Системные значения: на них опирается логика портала. Не удаляются и не архивируются. */
export const SYSTEM_ITEMS: readonly SystemItemDef[] = [
  { catalog: 'task_categories', key: 'mail', value: 'Почта', color: 'info', why: 'задачи из писем создаются с этой категорией' },
  { catalog: 'task_categories', key: 'register', value: 'Реестр', color: 'crit', why: 'её ставят автоматизации реестров' },
  { catalog: 'task_categories', key: 'documents', value: 'Документы', color: 'accent', why: 'её ставят пересмотр и возврат документа на доработку' },
  { catalog: 'task_categories', key: 'evidence', value: 'Доказательства', color: 'low', why: 'её ставят отклонение доказательства и окончание срока его действия' },
  { catalog: 'task_categories', key: 'awareness', value: 'Осведомлённость', color: 'med', why: 'её ставят задачи учебных писем и расписания рассылок' },
  { catalog: 'task_categories', key: 'document_control', value: 'Контроль по документу', color: 'accent', why: 'её ставят автоматизации механизмов контроля документов' },
  // Процесс задач (релиз 1.2.0, ADR-0022): Backlog → Поставленные → В работе → На проверке → Выполнено.
  { catalog: 'task_statuses', key: 'new', value: 'Backlog', why: 'колонка процесса задач: задачи без исполнителя' },
  { catalog: 'task_statuses', key: 'assigned', value: 'Поставленные', why: 'колонка процесса задач: исполнитель назначен, работа не начата' },
  { catalog: 'task_statuses', key: 'work', value: 'В работе', why: 'колонка процесса задач' },
  { catalog: 'task_statuses', key: 'review', value: 'На проверке', why: 'колонка процесса задач' },
  { catalog: 'task_statuses', key: 'done', value: 'Выполнено', why: 'колонка процесса задач: задача закрыта' },
  { catalog: 'task_priorities', key: 'normal', value: 'Обычный', why: 'приоритет по умолчанию' },
  { catalog: 'task_priorities', key: 'high', value: 'Высокий', why: 'ставится по слову «срочно» в письме' },
  { catalog: 'notify_recipients', key: 'dikt_head', value: 'Руководитель ДИКТ', why: 'получатель системных правил реестра уязвимостей (п. 7.4)' },
  { catalog: 'notify_recipients', key: 'system_owner', value: 'Владелец системы', why: 'получатель — владелец системы записи из справочника «Системы»' },
  { catalog: 'notify_recipients', key: 'ib_head', value: 'Начальник ИБ', why: 'получатель эскалации по п. 7.4' },
  { catalog: 'notify_recipients', key: 'bank_management', value: 'Руководство Банка', why: 'получатель эскалации по п. 7.4' },
];

export function systemItemWhy(catalog: string, key: string | null): string | null {
  return SYSTEM_ITEMS.find((s) => s.catalog === catalog && s.key === key)?.why ?? null;
}
