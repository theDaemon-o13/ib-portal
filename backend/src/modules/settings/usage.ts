// Точка расширения «значение используется». Модули следующих этапов (задачи, документы,
// доказательства) регистрируют здесь счётчики ссылок на значения справочников и шаблоны.
import type { Db } from '../../lib/db.js';

export type UsageCounter = (db: Db, ids: readonly string[]) => Promise<Map<string, number>>;

function registry() {
  const counters = new Map<string, UsageCounter>();
  return {
    register(name: string, counter: UsageCounter): () => void {
      counters.set(name, counter);
      return () => counters.delete(name);
    },
    async count(db: Db, ids: readonly string[]): Promise<Map<string, number>> {
      const total = new Map<string, number>(ids.map((id) => [id, 0]));
      for (const counter of counters.values()) {
        for (const [id, n] of await counter(db, ids)) total.set(id, (total.get(id) ?? 0) + n);
      }
      return total;
    },
  };
}

export const catalogItemUsage = registry();
export const formTemplateUsage = registry();
