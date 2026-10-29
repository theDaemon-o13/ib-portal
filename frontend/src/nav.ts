// Разделы сайдбара как в прототипе. Скрытие по правам — только удобство:
// доступ всегда проверяет backend.

export type IconName = 'dash' | 'monitor' | 'builder' | 'tasks' | 'docs' | 'evidence' | 'journal' | 'settings';

export interface NavItem {
  path: string;
  title: string;
  icon: IconName;
  /** Право, без которого пункт скрыт. undefined — виден всем вошедшим. */
  perm?: 'ib.work' | 'audit.view';
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
  // Журнал действий (релиз 1.2.0, ADR-0021): только по праву «Журнал действий», ib.work не нужен.
  { path: '/audit', title: 'Журнал', icon: 'journal', perm: 'audit.view' },
  { path: '/settings', title: 'Настройки', icon: 'settings', perm: 'ib.work' },
];

export function canSee(item: NavItem, permissions: readonly string[]): boolean {
  if (isKiosk(permissions)) return item.kiosk === true;
  return item.perm === undefined || permissions.includes(item.perm);
}

export function visibleNav(permissions: readonly string[]): NavItem[] {
  return NAV.filter((item) => canSee(item, permissions));
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
export function homePath(permissions: readonly string[]): string {
  return visibleNav(permissions)[0]?.path ?? '/documents';
}
