// Разделы сайдбара как в прототипе. Скрытие по правам — только удобство:
// доступ всегда проверяет backend.

export type IconName = 'dash' | 'monitor' | 'builder' | 'tasks' | 'docs' | 'evidence' | 'settings';

export interface NavItem {
  path: string;
  title: string;
  icon: IconName;
  /** Право, без которого пункт скрыт. undefined — виден всем вошедшим. */
  perm?: 'ib.work';
  /** Доступен учётной записи настенного монитора (monitor.kiosk). */
  kiosk?: boolean;
}

/** Право настенного монитора: видит только /monitor (ADR-0012). */
export const KIOSK_PERMISSION = 'monitor.kiosk';
export const isKiosk = (permissions: readonly string[]) => permissions.includes(KIOSK_PERMISSION);

export const NAV: NavItem[] = [
  { path: '/dashboard', title: 'Дашборд', icon: 'dash', perm: 'ib.work' },
  { path: '/monitor', title: 'Мониторинг', icon: 'monitor', perm: 'ib.work', kiosk: true },
  { path: '/registers', title: 'Конструктор реестров', icon: 'builder', perm: 'ib.work' },
  { path: '/tasks', title: 'Задачи', icon: 'tasks', perm: 'ib.work' },
  { path: '/documents', title: 'Документы', icon: 'docs' },
  { path: '/evidence', title: 'Доказательства', icon: 'evidence', perm: 'ib.work' },
  { path: '/settings', title: 'Настройки', icon: 'settings', perm: 'ib.work' },
];

export function canSee(item: NavItem, permissions: readonly string[]): boolean {
  if (isKiosk(permissions)) return item.kiosk === true;
  return item.perm === undefined || permissions.includes(item.perm);
}

export function visibleNav(permissions: readonly string[]): NavItem[] {
  return NAV.filter((item) => canSee(item, permissions));
}

/** Куда вести после входа: первый доступный раздел. */
export function homePath(permissions: readonly string[]): string {
  return visibleNav(permissions)[0]?.path ?? '/documents';
}
