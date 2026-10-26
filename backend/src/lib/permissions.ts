// Фиксированный список кодов прав (CLAUDE.md, раздел 5).
// Меняется только по согласованию с владельцем проекта.

export const PERMISSIONS = [
  { code: 'ib.work', name: 'Работа в разделах ИБ', description: 'Дашборд, мониторинг, реестры, задачи, доказательная база' },
  { code: 'records.edit', name: 'Записи реестров: добавление и правка', description: 'Карточка записи, импорт из Excel' },
  { code: 'records.delete', name: 'Записи реестров: удаление', description: '' },
  { code: 'tasks.delete', name: 'Задачи: удаление', description: 'Архивировать задачу может любой сотрудник ИБ' },
  { code: 'evidence.review', name: 'Доказательства: проверка', description: 'Принять или отклонить доказательство' },
  { code: 'docs.manage', name: 'Документы: управление', description: 'Создание, запуск пересмотра, отправка на согласование за автора' },
  { code: 'docs.approve.head', name: 'Документы: этап «Начальник ИБ»', description: 'Согласование этапа' },
  { code: 'docs.approve.legal', name: 'Документы: этап «Юридический отдел»', description: 'Согласование этапа' },
  { code: 'docs.approve.board', name: 'Документы: этап «Утверждение правлением»', description: 'Утверждение документа' },
  { code: 'settings.manage', name: 'Настройки: справочники и шаблоны форм', description: '' },
  { code: 'users.manage', name: 'Настройки: пользователи, роли и права', description: '' },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]['code'];

export const PERMISSION_CODES: readonly PermissionCode[] = PERMISSIONS.map((p) => p.code);

/** Права, которые нельзя снять с системной роли «Супер-администратор». */
export const SUPER_ADMIN_LOCKED: readonly PermissionCode[] = ['settings.manage', 'users.manage'];

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
      'ib.work', 'records.edit', 'records.delete', 'tasks.delete', 'evidence.review',
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
  return PERMISSION_CODES.filter((code) => result.has(code));
}
