// Версия, коммит и дата сборки подставляются при сборке (vite.config.ts → define): в продукте — из make-release.sh
// (VERSION, git), в dev — VERSION репозитория или «dev». Вручную не вписываются.
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILD_DATE__: string;

export const BUILD = {
  name: 'Портал ИБ',
  version: __APP_VERSION__,
  commit: __APP_COMMIT__,
  /** ISO 8601 или пусто (dev). */
  date: __APP_BUILD_DATE__,
  author: 'Машарипов Искандар',
} as const;

/** Дата сборки для окна «О портале»: «28.10.2026, 09:11» или «—». */
export function buildDateText(iso: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
