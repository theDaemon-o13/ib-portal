// Разделы сайдбара как в прототипе. Скрытие по правам — только удобство:
// доступ всегда проверяет backend.

export type IconName = 'dash' | 'monitor' | 'builder' | 'bug' | 'assets' | 'tasks' | 'docs' | 'evidence' | 'journal' | 'assess' | 'settings';

export interface NavItem {
  path: string;
  title: string;
  icon: IconName;
  /** Право (или любое из прав), без которого пункт скрыт. undefined — виден всем вошедшим. */
  perm?: NavPerm | readonly NavPerm[];
  /** Доступен учётной записи настенного монитора (monitor.kiosk). */
  kiosk?: boolean;
  /** Доступен служебной учётной записи «Администратор портала» (1.8.0, ADR-0036). */
  service?: boolean;
}

type NavPerm = 'ib.work' | 'audit.view' | 'assessment.manage' | 'settings.manage' | 'users.manage';

/** Право настенного монитора: видит только /monitor (ADR-0012). */
export const KIOSK_PERMISSION = 'monitor.kiosk';
export const isKiosk = (permissions: readonly string[]) => permissions.includes(KIOSK_PERMISSION);

export const NAV: NavItem[] = [
  { path: '/dashboard', title: 'Дашборд', icon: 'dash', perm: 'ib.work' },
  { path: '/monitor', title: 'Мониторинг', icon: 'monitor', perm: 'ib.work', kiosk: true },
  { path: '/registers', title: 'Конструктор реестров', icon: 'builder', perm: 'ib.work' },
  { path: '/vulns', title: 'Уязвимости', icon: 'bug', perm: 'ib.work' },
  { path: '/assets', title: 'Активы', icon: 'assets', perm: 'ib.work' },
  { path: '/tasks', title: 'Задачи', icon: 'tasks', perm: 'ib.work' },
  { path: '/documents', title: 'Документы', icon: 'docs' },
  { path: '/evidence', title: 'Доказательства', icon: 'evidence', perm: 'ib.work' },
  // Журнал действий (релиз 1.2.0, ADR-0021): только по праву «Журнал действий», ib.work не нужен.
  { path: '/audit', title: 'Журнал', icon: 'journal', perm: 'audit.view' },
  // Самооценка (этап Д, ADR-0026): личный раздел, только по праву «Самооценка», ib.work не нужен.
  { path: '/assessment', title: 'Самооценка', icon: 'assess', perm: 'assessment.manage' },
  // Настройки: сотрудники ИБ и те, кто ведёт настройки или пользователей (служебный администратор, ADR-0036).
  { path: '/settings', title: 'Настройки', icon: 'settings', perm: ['ib.work', 'settings.manage', 'users.manage'], service: true },
];

/** service — служебная учётная запись (/auth/me): видит только пункты с service (backend закрывает остальное). */
export function canSee(item: NavItem, permissions: readonly string[], service = false): boolean {
  if (isKiosk(permissions)) return item.kiosk === true;
  if (service) return item.service === true;
  if (item.perm === undefined) return true;
  const any = typeof item.perm === 'string' ? [item.perm] : item.perm;
  return any.some((p) => permissions.includes(p));
}

export function visibleNav(permissions: readonly string[], service = false): NavItem[] {
  return NAV.filter((item) => canSee(item, permissions, service));
}

/**
 * Путь, на который вернуть после входа (from — путь страницы, с которой отправили на вход; его задаёт ссылка).
 * Только внутренний путь портала: «//host» и «/\\host» браузер и роутер могут понять как другой сайт.
 */
export function safeReturnPath(from: unknown): string | null {
  if (typeof from !== 'string' || !from.startsWith('/') || from === '/login') return null;
  if (from.startsWith('//') || from.includes('\\') || [...from].some((c) => c < ' ')) return null;
  return from;
}

/** Куда вести после входа: первый доступный раздел. */
export function homePath(permissions: readonly string[], service = false): string {
  return visibleNav(permissions, service)[0]?.path ?? (service ? '/settings' : '/documents');
}
