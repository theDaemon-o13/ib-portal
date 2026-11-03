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
