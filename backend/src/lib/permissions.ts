// Фиксированный список кодов прав (CLAUDE.md, раздел 5).
// Меняется только по согласованию с владельцем проекта.

export const PERMISSIONS = [
  { code: 'ib.work', name: 'Работа в разделах ИБ', description: 'Дашборд, мониторинг, реестры, задачи, доказательная база' },
  { code: 'records.edit', name: 'Записи реестров: добавление и правка', description: 'Карточка записи, импорт из Excel' },
  { code: 'records.delete', name: 'Записи реестров: удаление', description: '' },
  { code: 'registers.manage', name: 'Реестры: создание и настройка полей', description: 'Конструктор реестров: реестры, поля, списки, смена типа поля' },
  { code: 'tasks.delete', name: 'Задачи: удаление', description: 'Архивировать задачу может любой сотрудник ИБ' },
  { code: 'tasks.assign', name: 'Задачи: постановка другим', description: 'Назначать исполнителем любого сотрудника ИБ. Без права — только себя' },
  {
    code: 'tasks.review', name: 'Задачи: проверка',
    description: 'Не используется с 1.4.0: задачу принимает проверяющий — руководитель исполнителя. Действует только для задач, отправленных на проверку до 1.4.0 без руководителя у исполнителя. Остаётся ради отката на 1.3.0',
  },
  { code: 'tasks.status.override', name: 'Задачи: свободная смена статуса', description: 'Перетаскивание карточек и смена статуса в обход процесса, «Заменить проверяющего». Из «На проверке» — только проверяющий; «В работе» → «Выполнено» — только без руководителя у исполнителя' },
  { code: 'tasks.report', name: 'Задачи: отчёт', description: 'Выгрузка отчёта по задачам в Excel' },
  {
    code: 'vulns.deadlines', name: 'Уязвимости: изменение сроков',
    description: 'Продление сроков по обоснованию ОИКТ и отмена продления. Никому не выдаётся автоматически, назначается в матрице',
  },
  {
    code: 'data.delete', name: 'Удаление данных',
    description: 'Удаление реестров, групп и типов систем в «Уязвимостях» и записей уязвимостей (мягкое, в корзину). Никому не выдаётся автоматически, назначается в матрице',
  },
  { code: 'evidence.review', name: 'Доказательства: проверка', description: 'Принять или отклонить доказательство' },
  { code: 'docs.manage', name: 'Документы: управление', description: 'Создание, запуск пересмотра, отправка на согласование за автора' },
  { code: 'docs.delete', name: 'Документы: удаление', description: 'Только неподписанные документы; подписанные — в архив' },
  {
    code: 'docs.approve.head', name: 'Документы: начальник ИБ',
    description: 'Не используется с 1.4.0: этап «Начальник ИБ» выполняет пользователь с отметкой «Является начальником ИБ». Остаётся ради отката на 1.3.0',
  },
  { code: 'settings.manage', name: 'Настройки: справочники и шаблоны форм', description: '' },
  { code: 'users.manage', name: 'Настройки: пользователи, роли и права', description: '' },
  { code: 'history.view', name: 'История в карточках', description: 'История изменений задач, записей реестров, документов и доказательств' },
  { code: 'audit.view', name: 'Журнал действий', description: 'Раздел «Журнал»: все действия пользователей, выгрузка в Excel' },
  {
    code: 'assessment.manage', name: 'Самооценка',
    description: 'Личный раздел «Самооценка». Только в системной роли «Самооценка»: другим ролям не выдаётся, раздел — без ib.work',
  },
  {
    code: 'monitor.kiosk', name: 'Настенный монитор',
    description: 'Только экран мониторинга, вход с адресов MONITOR_ALLOWED_IPS. Не сочетается с другими правами и ролями',
  },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]['code'];

export const PERMISSION_CODES: readonly PermissionCode[] = PERMISSIONS.map((p) => p.code);

/** Права, которые нельзя снять с системной роли «Супер-администратор». */
export const SUPER_ADMIN_LOCKED: readonly PermissionCode[] = ['settings.manage', 'users.manage'];
/** Привилегированные права: с ними вход только с адресов ADMIN_ALLOWED_IPS, если список задан (ADR-0015). */
export const ADMIN_PERMISSIONS: readonly PermissionCode[] = ['settings.manage', 'users.manage'];

/**
 * Учётная запись настенного монитора: видит только /monitor. Право исключительное —
 * роль с ним не содержит других прав, а пользователь с такой ролью не получает других ролей.
 */
export const KIOSK_PERMISSION = 'monitor.kiosk' as const satisfies PermissionCode;

/**
 * Самооценка (этап Д, ADR-0026): право только у системной роли «Самооценка» — другой роли не выдаётся (в том числе
 * «Супер-администратору»), с этой роли не снимается.
 */
export const ASSESSMENT_PERMISSION = 'assessment.manage' as const satisfies PermissionCode;
export const ASSESSMENT_ROLE = 'assessment' as const;

/** Права согласования документов: не входят в роль супер-администратора (разделение полномочий). */
export const APPROVAL_PERMISSIONS: readonly PermissionCode[] = ['docs.approve.head'];

/**
 * Коды прав маршрута до 1.2.0 (этапы юриста и правления, ADR-0024). Из кода и матрицы ушли; строки в permissions и
 * role_permissions остаются в БД до 1.3.0, чтобы работал откат на 1.1.0. В сумме прав пользователя не учитываются.
 */
export const LEGACY_PERMISSION_CODES = ['docs.approve.legal', 'docs.approve.board'] as const;

/**
 * Роли до 1.2.0, выведенные из обращения: их пользователи переходят в «Читатель документов» (seed). Сами роли (пустые)
 * остаются в БД до 1.3.0 ради отката; в интерфейсе их нет и назначить их нельзя.
 */
export const RETIRED_ROLE_CODES = ['legal', 'board'] as const;
export const isRetiredRole = (code: string | null) => code !== null && (RETIRED_ROLE_CODES as readonly string[]).includes(code);

export const SYSTEM_ROLES = [
  {
    code: 'super_admin',
    name: 'Супер-администратор',
    description: 'Полный доступ к настройкам, удаление задач и записей',
    permissions: [
      'ib.work', 'records.edit', 'records.delete', 'registers.manage', 'tasks.delete', 'evidence.review',
      'docs.manage', 'settings.manage', 'users.manage', 'history.view', 'audit.view',
    ],
  },
  {
    code: 'ib_staff',
    name: 'Сотрудник ИБ',
    description: 'Повседневная работа отдела',
    permissions: ['ib.work', 'records.edit', 'evidence.review'],
  },
  {
    code: 'soc',
    name: 'SOC',
    description: 'Сотрудник SOC: права как у «Сотрудника ИБ» (релиз 1.4.0)',
    permissions: ['ib.work', 'records.edit', 'evidence.review'],
  },
  {
    code: 'ib_head',
    name: 'Начальник ИБ',
    description: 'Проверяет задачи, видит журнал. Этап «Начальник ИБ» в документах — по отметке в карточке пользователя',
    // С 1.4.0 без docs.approve.head (только новая установка; существующая роль не перезаписывается).
    permissions: [
      'tasks.assign', 'tasks.review', 'tasks.status.override', 'tasks.report', 'docs.delete',
      'history.view', 'audit.view',
    ],
  },
  {
    code: 'doc_reader',
    name: 'Читатель документов',
    description: 'Видит подписанные документы и их файлы; других прав нет (релиз 1.2.0)',
    permissions: [],
  },
  {
    code: 'assessment',
    name: 'Самооценка',
    description: 'Личный раздел «Самооценка». Обычно назначается одному сотруднику',
    permissions: ['assessment.manage'],
  },
  {
    code: 'kiosk',
    name: 'Настенный монитор',
    description: 'Только экран мониторинга; вход с разрешённых адресов',
    permissions: ['monitor.kiosk'],
  },
] as const satisfies readonly {
  code: string;
  name: string;
  description: string;
  permissions: readonly PermissionCode[];
}[];

export type SystemRoleCode = (typeof SYSTEM_ROLES)[number]['code'];

/**
 * Права, появившиеся после первой установки: при обновлении их один раз выдаёт шаг seed
 * (снятое администратором потом не возвращается). На новой установке они уже в SYSTEM_ROLES.
 */
export const PERMISSION_GRANTS: readonly { key: string; release: string; grants: Partial<Record<SystemRoleCode, readonly PermissionCode[]>> }[] = [
  {
    key: 'rbac.permissions.v1_2',
    release: '1.2.0',
    grants: {
      ib_head: ['tasks.assign', 'tasks.review', 'tasks.status.override', 'tasks.report', 'docs.delete', 'history.view', 'audit.view'],
      super_admin: ['history.view', 'audit.view'],
    },
  },
];

export function isPermissionCode(value: string): value is PermissionCode {
  return (PERMISSION_CODES as readonly string[]).includes(value);
}

/** Пользователь получает сумму прав всех своих ролей. */
export function collectPermissions(roles: readonly { permissions: readonly string[] }[]): PermissionCode[] {
  const result = new Set<PermissionCode>();
  for (const role of roles) {
    for (const code of role.permissions) {
      if (isPermissionCode(code)) result.add(code);
    }
  }
  // Киоск не получает других прав, даже если состав ролей нарушил правило исключительности.
  if (result.has(KIOSK_PERMISSION)) return [KIOSK_PERMISSION];
  return PERMISSION_CODES.filter((code) => result.has(code));
}
