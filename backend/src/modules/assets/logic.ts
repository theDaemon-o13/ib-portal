// Чистая логика сверки активов (ADR-0031): имена хостов и единая структура факта.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Имя хоста для сравнения: без регистра, пробелов и доменного суффикса. IP-адрес остаётся целиком. */
export function normalizeHostName(name: string): string {
  const s = name.trim().toLowerCase();
  return IPV4.test(s) ? s : (s.split('.')[0] ?? '');
}

export interface FactRecord {
  id: string;
  title: string;
  /** Ссылка внутри портала; null — ссылаться не на что. */
  href: string | null;
  /** Чего не хватает. */
  detail: string | null;
}

export interface FactWarning {
  code: string;
  message: string;
  records: FactRecord[];
}

export interface AssetFact {
  code: string;
  /** Раздел методики. */
  section: string;
  /** Другие разделы, которым нужен тот же факт. */
  relatedSections: string[];
  title: string;
  status: 'ok' | 'violations' | 'no_data';
  /** Сколько проверенного соответствует условию; при no_data — null. */
  numerator: number | null;
  denominator: number | null;
  /** Доля соответствующих. Округляется вниз: 84,96% не должно пройти порог 85%. */
  percent: number | null;
  records: FactRecord[];
  calculatedAt: string;
  message: string | null;
  warnings: FactWarning[];
}

export interface FactDef {
  code: string;
  section: string;
  relatedSections?: string[];
  title: string;
}

/** Источник пуст или проверять нечего: ни процента, ни списка, чтобы пустота не выглядела как 0% или 100%. */
export function noDataFact(def: FactDef, calculatedAt: string, message: string): AssetFact {
  return {
    code: def.code, section: def.section, relatedSections: def.relatedSections ?? [], title: def.title,
    status: 'no_data', numerator: null, denominator: null, percent: null, records: [], calculatedAt, message, warnings: [],
  };
}

/** Факт по проверенным записям: violators — кто не соответствует условию. denominator 0 — no_data с emptyMessage. */
export function checkedFact(def: FactDef, calculatedAt: string, input: { checked: number; violators: FactRecord[]; emptyMessage: string; warnings?: FactWarning[] }): AssetFact {
  if (input.checked === 0) return noDataFact(def, calculatedAt, input.emptyMessage);
  const numerator = input.checked - input.violators.length;
  return {
    code: def.code, section: def.section, relatedSections: def.relatedSections ?? [], title: def.title,
    status: input.violators.length ? 'violations' : 'ok',
    numerator, denominator: input.checked,
    percent: Math.floor((numerator / input.checked) * 1000) / 10,
    records: input.violators, calculatedAt, message: null, warnings: input.warnings ?? [],
  };
}

/** Совпавшие после нормализации имена: записи не склеиваются, о совпадении — предупреждение. */
export function nameCollisions<T extends { name: string; ref: FactRecord }>(items: readonly T[], where: string): FactWarning[] {
  const byName = new Map<string, T[]>();
  for (const it of items) {
    const key = normalizeHostName(it.name);
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), it]);
  }
  return [...byName.values()].filter((list) => list.length > 1).map((list) => ({
    code: 'host_name_collision',
    message: `${where}: имена совпадают при сравнении — ${list.map((i) => i.name).join(', ')}. Записи не объединены, проверьте их`,
    records: list.map((i) => i.ref),
  }));
}

