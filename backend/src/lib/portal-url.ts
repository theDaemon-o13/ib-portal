// Адрес портала (PORTAL_URL): с ним backend сверяет Origin изменяющих запросов из браузера.
// Заголовок Host для этого не годится — его присылает клиент, и он же решает, что считать «своим» адресом.

/**
 * Проверяет PORTAL_URL и возвращает origin (схема, хост, порт; порт по умолчанию отбрасывается, как в Origin
 * браузера) или текст ошибки. http — только вне production (dev через Vite на http://localhost).
 */
export function parsePortalUrl(v: string, production: boolean): { origin: string } | { error: string } {
  if (!v) {
    return { error: 'не задан. Укажите полный адрес, по которому пользователи открывают портал, со схемой и портом (если не 443), например https://ib-portal.bank.local' };
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return { error: `«${v}» — не адрес. Пример: https://ib-portal.bank.local` };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) {
    return { error: `«${v}»: нужен адрес https://${production ? '' : ' (http:// — только для разработки)'}` };
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    return { error: `«${v}»: только схема, имя сервера и порт — без пути, параметров и учётных данных` };
  }
  return { origin: url.origin };
}

/** Совпадает ли заголовок Origin с адресом портала. Непонятный Origin (в том числе «null») — не совпадает. */
export function sameOrigin(origin: string, portalOrigin: string): boolean {
  try {
    return new URL(origin).origin === portalOrigin;
  } catch {
    return false;
  }
}
