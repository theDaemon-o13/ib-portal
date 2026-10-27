// Списки адресов из переменных окружения: «10.1.2.3, 10.1.5.0/24, fd00::/8».
// Без зависимостей: net.BlockList из Node.
import { BlockList, isIP } from 'node:net';

export interface IpList {
  /** Адрес входит в список. Пустой список не содержит ничего. */
  has(ip: string | null | undefined): boolean;
  readonly empty: boolean;
  /** Нормализованные элементы — для журнала и сообщений. */
  readonly entries: readonly string[];
}

/** IPv4, отображённый в IPv6 (::ffff:10.0.0.5), сравнивается как IPv4. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
  return m?.[1] ?? ip.trim();
}

/** Разбор списка; ошибка с понятным текстом, если элемент не IP и не CIDR (проверяется при старте). */
export function parseIpList(spec: string): IpList {
  const list = new BlockList();
  const entries: string[] = [];
  for (const raw of spec.split(/[\s,;]+/)) {
    const item = raw.trim();
    if (!item) continue;
    const [addr = '', prefixRaw] = item.split('/');
    const ip = normalizeIp(addr);
    const family = isIP(ip);
    if (!family) throw new Error(`«${item}» — не IP-адрес и не подсеть`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (prefixRaw === undefined) {
      list.addAddress(ip, type);
    } else {
      const prefix = Number(prefixRaw);
      if (!/^\d+$/.test(prefixRaw) || prefix > (family === 6 ? 128 : 32)) throw new Error(`«${item}» — неверная длина префикса`);
      list.addSubnet(ip, prefix, type);
    }
    entries.push(prefixRaw === undefined ? ip : `${ip}/${prefixRaw}`);
  }
  return {
    empty: entries.length === 0,
    entries,
    has(value) {
      if (!value || entries.length === 0) return false;
      const ip = normalizeIp(value);
      const family = isIP(ip);
      if (!family) return false;
      return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
    },
  };
}
