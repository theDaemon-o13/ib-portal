// Фиксированный список кодов прав (CLAUDE.md, раздел 5).
// Меняется только по согласованию с владельцем проекта.

export const PERMISSIONS = [
  { code: 'ib.work', name: 'Работа в разделах ИБ', description: 'Дашборд, мониторинг, реестры, задачи, доказательная база' },
  { code: 'records.edit', name: 'Записи реестров: добавление и правка', description: 'Карточка записи, импорт из Excel' },
  { code: 'records.delete', name: 'Записи реестров: удаление', description: '' },
  { code: 'registers.manage', name: 'Реестры: создание и настройка полей', description: 'Конструктор реестров: реестры, поля, списки, смена типа поля' },
  { code: 'tasks.delete', name: 'Задачи: удаление', description: 'Архивировать задачу может любой сотрудник ИБ' },
  { code: 'evidence.review', name: 'Доказательства: проверка', description: 'Принять или отклонить доказательство' },
  { code: 'docs.manage', name: 'Документы: управление', description: 'Создание, запуск пересмотра, отправка на согласование за автора' },
  { code: 'docs.approve.head', name: 'Документы: этап «Начальник ИБ»', description: 'Согласование этапа' },
  { code: 'docs.approve.legal', name: 'Документы: этап «Юридический отдел»', description: 'Согласование этапа' },
  { code: 'docs.approve.board', name: 'Документы: этап «Утверждение правлением»', description: 'Утверждение документа' },
  { code: 'settings.manage', name: 'Настройки: справочники и шаблоны форм', description: '' },
  { code: 'users.manage', name: 'Настройки: пользователи, роли и права', description: '' },
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

/** Права этапов согласования: не входят в роль супер-администратора (разделение полномочий). */
export const APPROVAL_PERMISSIONS: readonly PermissionCode[] = [
  'docs.approve.head',
  'docs.approve.legal',
  'docs.approve.board',
];

export const SYSTEM_ROLES = [
  {
    code: 'super_admin',
    name: 'Супер-администратор',
    description: 'Полный доступ к настройкам, удаление задач и записей',
    permissions: [
      'ib.work', 'records.edit', 'records.delete', 'registers.manage', 'tasks.delete', 'evidence.review',
      'docs.manage', 'settings.manage', 'users.manage',
    ],
  },
  {
    code: 'ib_staff',
    name: 'Сотрудник ИБ',
    description: 'Повседневная работа отдела',
    permissions: ['ib.work', 'records.edit', 'evidence.review'],
  },
  {
    code: 'ib_head',
    name: 'Начальник ИБ',
    description: 'Согласует документы на этапе «Начальник ИБ»',
    permissions: ['docs.approve.head'],
  },
  {
    code: 'legal',
    name: 'Юрист',
    description: 'Согласует документы на этапе «Юридический отдел»',
    permissions: ['docs.approve.legal'],
  },
  {
    code: 'board',
    name: 'Правление',
    description: 'Утверждает документы',
    permissions: ['docs.approve.board'],
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
