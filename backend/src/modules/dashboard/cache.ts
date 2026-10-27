// Кэш расчётов дашборда и мониторинга на 1 минуту (в памяти backend: экземпляр один).
// Права проверяются до кэша (guard маршрута); в кэше — только данные, одинаковые для всех, кому они видны.
// Одновременные запросы одного ключа ждут один расчёт; ошибка не кэшируется.

export const CACHE_TTL_MS = 60_000;
const MAX_KEYS = 1000;

export interface Cached<T> {
  value: T;
  /** Когда посчитано (ISO): «Обновлено в …» на экране. */
  computedAt: string;
}

export function createCache(ttlMs = CACHE_TTL_MS, now: () => Date = () => new Date()) {
  const entries = new Map<string, { at: number; promise: Promise<Cached<unknown>> }>();

  function prune(t: number) {
    for (const [k, e] of entries) if (t - e.at >= ttlMs) entries.delete(k);
    // Ключи — виджеты и плитки, их немного; предел — на случай перебора несуществующих ключей.
    while (entries.size >= MAX_KEYS) entries.delete(entries.keys().next().value as string);
  }

  return {
    async get<T>(key: string, compute: () => Promise<T>): Promise<Cached<T>> {
      const t = now().getTime();
      const hit = entries.get(key);
      if (hit && t - hit.at < ttlMs) return hit.promise as Promise<Cached<T>>;
      prune(t);
      const promise = compute().then((value) => ({ value, computedAt: new Date(t).toISOString() }));
      entries.set(key, { at: t, promise });
      promise.catch(() => {
        if (entries.get(key)?.promise === promise) entries.delete(key);
      });
      return promise;
    },
    /** Сбросить ключ (или все ключи с префиксом): правка плитки видна сразу. */
    invalidate(prefix: string) {
      for (const k of [...entries.keys()]) if (k === prefix || k.startsWith(prefix)) entries.delete(k);
    },
    clear() {
      entries.clear();
    },
  };
}

export type DashboardCache = ReturnType<typeof createCache>;
