// Уведомления в портале (релиз 1.2.0, ADR-0023): видит только адресат. Типы — из сгенерированной схемы OpenAPI.
import { request, type JsonOf } from './client';
import type { paths } from './generated/schema';

export type NotificationPage = JsonOf<paths['/api/v1/notifications']['get']['responses'][200]>;
export type PortalNotification = NotificationPage['items'][number];

/** Что ждёт действия пользователя (1.4.0): задачи на его проверке, документы «ждут вас», сумма — колокольчик. */
export type Attention = JsonOf<paths['/api/v1/me/attention']['get']['responses'][200]>;

export const notificationsApi = {
  attention: () => request<Attention>('GET', '/api/v1/me/attention'),
  list: (unread: boolean, cursor?: string) =>
    request<NotificationPage>('GET', `/api/v1/notifications?limit=20${unread ? '&unread=true' : ''}${cursor ? `&cursor=${cursor}` : ''}`),
  count: () => request<{ unread: number }>('GET', '/api/v1/notifications/count'),
  read: (id: string) => request<undefined>('POST', `/api/v1/notifications/${id}/read`),
  readAll: () => request<{ marked: number }>('POST', '/api/v1/notifications/read-all'),
};

export const nkeys = {
  all: ['notifications'] as const,
  /** Меню и колокольчик делят один запрос; после любого успешного действия обновляется (main.tsx). */
  attention: ['attention'] as const,
  count: ['notifications', 'count'] as const,
  list: (unread: boolean) => ['notifications', 'list', unread] as const,
};

/** Опрос значка: раз в 45 с; в скрытой вкладке TanStack Query опрос не ведёт. */
export const NOTIFY_POLL_MS = 45_000;
const PORTAL_TITLE = 'Портал ИБ';

/** Заголовок вкладки: «(3) Портал ИБ» — сколько ждёт вашего действия; ничего — «Портал ИБ». */
export function tabTitle(waiting: number): string {
  return waiting > 0 ? `(${waiting > 99 ? '99+' : waiting}) ${PORTAL_TITLE}` : PORTAL_TITLE;
}

export const badge = (n: number) => (n > 99 ? '99+' : String(n));

/** «только что», «5 мин назад», «сегодня, 14:20», «вчера, 14:20», «27.10.2026, 14:20». */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const min = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return `сегодня, ${hm}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (day(d) === day(y)) return `вчера, ${hm}`;
  return `${d.toLocaleDateString('ru-RU')}, ${hm}`;
}
