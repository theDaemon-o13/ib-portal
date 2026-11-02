// Системные реестры активов (релиз 1.6.0, ADR-0031): «Сервисы» (продукты) → «Компоненты» → «Хосты».
// Поля, на которые опираются сверка и адаптеры импорта, системные: их находят по ключу, не по названию;
// переименовать можно, удалить и архивировать нельзя.
export const ASSET_SERVICES_KEY = 'asset_services';
export const ASSET_COMPONENTS_KEY = 'asset_components';
export const ASSET_HOSTS_KEY = 'asset_hosts';
/** app_settings: значимые категории, реестр устройств DLP. */
export const ASSET_SETTINGS_KEY = 'assets';
export const DLP_DEVICES_NAME = 'Устройства DLP';

/** Категории критичности по процедуре классификации ИТ-активов, в этом порядке: чем раньше, тем критичнее. */
export const CATEGORIES = ['Mission Critical', 'Business Critical', 'Operational', 'Non-Critical'] as const;
export const SIGNIFICANT_LEVELS = ['Mission Critical', 'Business Critical'];
/** Пересмотр классификации — раз в 6 месяцев (активы ЦОД по процедуре). */
export const REVIEW_DAYS = 183;

/** Приложение 3 процедуры: подсказка у полей RTO и RPO. */
export const RTO_HINT = 'Максимальный простой по категории: Mission Critical — 2 ч; Business Critical — 12 ч; Operational — 72 ч; Non-Critical — не задано';
export const RPO_HINT = 'Допустимая потеря данных по категории: Mission Critical — до 4 ч; Business Critical — 4–24 ч; Operational — 1–7 дн.; Non-Critical — не задано';

export interface AssetFieldSpec {
  key: string;
  label: string;
  type: 'text' | 'select' | 'date' | 'catalog' | 'link' | 'user' | 'calc';
  system?: boolean;
  catalogCode?: string;
  isTitle?: boolean;
  isStatus?: boolean;
  isImportKey?: boolean;
  analyticsRole?: 'dimension' | 'deadline';
  /** Реестр связи по ключу. */
  link?: string;
  hint?: string;
  options?: { label: string; key?: string; closed?: boolean }[];
}

const labels = (...list: readonly string[]) => list.map((label) => ({ label }));
const categories = () => CATEGORIES.map((label, i) => ({ label, key: ['mission', 'business', 'operational', 'non_critical'][i] }));

export const SERVICE_FIELDS: AssetFieldSpec[] = [
  { key: 'title', label: 'Сервис', type: 'text', system: true, isTitle: true, isImportKey: true },
  { key: 'system', label: 'Система', type: 'catalog', system: true, catalogCode: 'systems', analyticsRole: 'dimension' },
  { key: 'purpose', label: 'Назначение и бизнес-процессы', type: 'text', system: true },
  { key: 'ownerBusiness', label: 'Бизнес-владелец', type: 'text', system: true },
  { key: 'ownerIt', label: 'ИТ-владелец', type: 'text', system: true },
  { key: 'ownerPosition', label: 'Владелец (должность)', type: 'text' },
  { key: 'dept', label: 'Подразделение', type: 'select', analyticsRole: 'dimension' },
  { key: 'level', label: 'Категория критичности', type: 'select', system: true, analyticsRole: 'dimension', options: categories() },
  { key: 'rto', label: 'RTO', type: 'text', system: true, hint: RTO_HINT },
  { key: 'rpo', label: 'RPO', type: 'text', system: true, hint: RPO_HINT },
  { key: 'levelBasis', label: 'Связь с ключевыми рисками', type: 'text', system: true },
  { key: 'data', label: 'Обрабатываемые данные', type: 'text' },
  { key: 'internet', label: 'Доступ из интернета', type: 'select', analyticsRole: 'dimension', options: labels('Да', 'Нет') },
  { key: 'monitoring', label: 'Подключён к мониторингу', type: 'select', system: true, analyticsRole: 'dimension', options: [{ label: 'Да' }, { label: 'Частично' }, { label: 'Нет', key: 'no' }] },
  { key: 'legacy', label: 'Устаревшая система', type: 'select', system: true, analyticsRole: 'dimension', options: [{ label: 'Нет' }, { label: 'Да', key: 'yes' }] },
  { key: 'legacyPlan', label: 'План по устаревшей системе', type: 'text', system: true },
  { key: 'classifiedOn', label: 'Дата классификации', type: 'date', system: true },
  { key: 'classifiedBy', label: 'Классифицировал', type: 'user', system: true },
  { key: 'approvedOn', label: 'Согласовано руководителем ИБ', type: 'date', system: true },
  // Вычисляемый срок: «Дата классификации» + 183 дня по любой категории. Без категории срока нет — это ловит сверка.
  { key: 'reviewDue', label: 'Пересмотр до', type: 'calc', system: true, analyticsRole: 'deadline' },
  {
    key: 'status', label: 'Статус', type: 'select', system: true, isStatus: true, analyticsRole: 'dimension',
    options: [{ label: 'Планируется' }, { label: 'Работает', key: 'working' }, { label: 'Выводится' }, { label: 'Выведен', closed: true }],
  },
];

export const COMPONENT_FIELDS: AssetFieldSpec[] = [
  // Запись — экземпляр компонента (1.6.1): один компонент бывает в Prod и Test и в нескольких экземплярах на разных IP.
  // Заголовок «b2b-api · Prod · 10.0.0.1:8070» и ключ ставит адаптер (service-registry.ts).
  { key: 'instance', label: 'Экземпляр', type: 'text', system: true, isTitle: true },
  { key: 'title', label: 'Компонент', type: 'text', system: true },
  { key: 'product', label: 'Продукт', type: 'link', system: true, link: ASSET_SERVICES_KEY },
  // «Компонент / Продукт / Среда / IP:порт» без регистра и пробелов по краям.
  { key: 'key', label: 'Ключ компонента', type: 'text', system: true, isImportKey: true },
  { key: 'assetType', label: 'Тип актива', type: 'select', system: true, analyticsRole: 'dimension', options: labels('Сервис', 'База данных', 'NoSQL база данных', 'Прокси-сервер', 'Web-сервис') },
  { key: 'level', label: 'Категория критичности', type: 'select', system: true, analyticsRole: 'dimension', options: categories() },
  { key: 'env', label: 'Среда', type: 'select', system: true, analyticsRole: 'dimension', options: [{ label: 'Prod', key: 'prod' }, { label: 'Test', key: 'test' }] },
  { key: 'status', label: 'Статус', type: 'select', system: true, isStatus: true, analyticsRole: 'dimension', options: [{ label: 'Работает', key: 'working' }, { label: 'Выводится' }, { label: 'Выведен', closed: true }] },
  { key: 'description', label: 'Описание', type: 'text', system: true },
  { key: 'os', label: 'ОС / ПО', type: 'text', system: true },
  { key: 'osSource', label: 'ОС / ПО в источнике', type: 'text', system: true },
  { key: 'ip', label: 'IP-адрес', type: 'text', system: true },
  { key: 'port', label: 'Порт', type: 'text', system: true },
  { key: 'host', label: 'Хост', type: 'link', system: true, link: ASSET_HOSTS_KEY },
  { key: 'location', label: 'Местоположение', type: 'select', system: true, analyticsRole: 'dimension' },
  { key: 'owner', label: 'Владелец', type: 'text', system: true },
  { key: 'team', label: 'Команда', type: 'text', system: true },
];

export const BASES_OUTDATED = 'Обновлены более 7 дней назад';

export const HOST_FIELDS: AssetFieldSpec[] = [
  { key: 'name', label: 'Имя хоста', type: 'text', system: true, isTitle: true, isImportKey: true },
  { key: 'ip', label: 'IP-адрес', type: 'text', system: true },
  { key: 'domain', label: 'Домен', type: 'text', system: true },
  {
    key: 'type', label: 'Тип', type: 'select', system: true, analyticsRole: 'dimension',
    options: [{ label: 'Рабочая станция', key: 'workstation' }, { label: 'Сервер', key: 'server' }, { label: 'Сетевое', key: 'network' }, { label: 'Другое', key: 'other' }],
  },
  { key: 'os', label: 'ОС', type: 'text', system: true },
  { key: 'services', label: 'Сервисы', type: 'link', system: true, link: ASSET_SERVICES_KEY },
  { key: 'dept', label: 'Подразделение', type: 'select', analyticsRole: 'dimension' },
  {
    key: 'source', label: 'Источник', type: 'select', system: true, analyticsRole: 'dimension',
    options: [{ label: 'Kaspersky', key: 'ksc' }, { label: 'Реестр сервисов', key: 'services' }, { label: 'Сканер', key: 'scanner' }, { label: 'Вручную', key: 'manual' }],
  },
  { key: 'inKsc', label: 'В KSC', type: 'select', system: true, analyticsRole: 'dimension', options: [{ label: 'Да', key: 'yes' }, { label: 'Нет', key: 'no' }] },
  { key: 'kscGroup', label: 'Группа KSC', type: 'text', system: true },
  { key: 'agentVersion', label: 'Версия агента', type: 'text', system: true },
  { key: 'protectionProduct', label: 'Продукт защиты', type: 'text', system: true },
  { key: 'protectionVersion', label: 'Версия защиты', type: 'text', system: true },
  {
    key: 'coverage', label: 'Покрытие защиты', type: 'select', system: true, analyticsRole: 'dimension',
    options: [{ label: 'Агент и защита', key: 'full' }, { label: 'Только агент', key: 'agent' }, { label: 'Нет агента', key: 'none' }],
  },
  {
    key: 'basesStatus', label: 'Статус антивирусных баз', type: 'select', system: true, analyticsRole: 'dimension',
    options: [
      { label: 'Актуальные' }, { label: 'Обновлены в последние 24 часа' }, { label: 'Обновлены в последние 3 дня' },
      { label: 'Обновлены в последние 7 дней' }, { label: BASES_OUTDATED, key: 'outdated' },
    ],
  },
  { key: 'basesDate', label: 'Дата баз', type: 'date', system: true },
  { key: 'seen', label: 'Последняя связь с Kaspersky', type: 'date', system: true },
  { key: 'lastVisible', label: 'Последнее появление в сети', type: 'date', system: true },
  { key: 'installedOn', label: 'Защита установлена', type: 'date', system: true },
  { key: 'cluster', label: 'Кластер', type: 'text' },
  { key: 'inventory', label: 'Инвентарный номер', type: 'text' },
  { key: 'location', label: 'Местоположение', type: 'select', system: true, analyticsRole: 'dimension' },
  { key: 'status', label: 'Статус', type: 'select', system: true, isStatus: true, analyticsRole: 'dimension', options: [{ label: 'Активен' }, { label: 'Выведен', closed: true }] },
];

/** Служебные поля: значение ставит адаптер импорта, вручную (форма, обратный импорт Excel) не меняется. */
export const ASSET_MANAGED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [ASSET_COMPONENTS_KEY]: ['instance', 'key', 'osSource'],
  [ASSET_HOSTS_KEY]: ['coverage'],
};
