// Строки лога при старте backend (1.13.7): с какими списками адресов он работает. Адреса — не секреты; по ним
// DevOps без SQL видит, почему не входит настенный монитор или администратор. Пароли и ключи здесь не выводятся.
import type { IpList } from './ip-list.js';

export interface StartupLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export function reportAddressLists(log: StartupLog, lists: { trustedProxies: IpList; kiosk: IpList; admin: IpList }): void {
  log.info({
    event: 'startup.address_lists',
    trustedProxyIps: lists.trustedProxies.entries,
    monitorAllowedIps: lists.kiosk.entries,
    adminAllowedIps: lists.admin.empty ? 'без ограничения' : lists.admin.entries,
  }, 'списки адресов: TRUSTED_PROXY_IPS, MONITOR_ALLOWED_IPS, ADMIN_ALLOWED_IPS');
  if (lists.trustedProxies.empty) {
    log.warn({ event: 'startup.trusted_proxies_empty' },
      'TRUSTED_PROXY_IPS пуста — X-Forwarded-For не принимается: за nginx все пользователи видны с адреса nginx');
  }
  if (lists.kiosk.empty) {
    log.warn({ event: 'startup.monitor_ips_empty' },
      'MONITOR_ALLOWED_IPS пуста — вход настенного монитора запрещён с любого адреса (пользователь видит «Неверный логин или пароль»)');
  }
}
