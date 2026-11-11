// Пакетная запись для массовых операций (1.13.9, docs/plans/release-1.13.9.md): число SQL-запросов растёт с числом
// пачек, а не записей. Содержимое строк — то же, что у построчной записи; меняется только способ вставки.
import type { Db } from './db.js';
import type { Values } from './register-values.js';

/** Параметров в одном запросе PostgreSQL — не больше 65 535 (счётчик в протоколе — 16 бит). */
export const PG_MAX_PARAMS = 65_535;
/** Строк в пачке — не больше 1000: длинные запросы хуже читаются в логах и держат память. */
export const BATCH_MAX_ROWS = 1000;

/** Размер пачки для вставки строк с columns колонками. */
export function chunkSize(columns: number): number {
  return Math.max(1, Math.min(BATCH_MAX_ROWS, Math.floor(PG_MAX_PARAMS / Math.max(1, columns))));
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** createMany пачками по chunkSize(columns), по порядку. Возвращает число вставленных строк. */
export async function createManyChunked<T>(rows: readonly T[], columns: number, insert: (data: T[]) => Promise<{ count: number }>): Promise<number> {
  let count = 0;
  for (const part of chunks(rows, chunkSize(columns))) count += (await insert(part)).count;
  return count;
}

export interface RecordValuesUpdate {
  id: string;
  values: Values;
  searchText: string;
  /** Не задано — manual_field_ids не меняется. */
  manualFieldIds?: readonly string[];
}

/**
 * Новые значения записей реестра пачками: values, search_text, при необходимости manual_field_ids, version + 1.
 * То же, что registerRecord.update на каждую запись; одна пачка — один запрос с одним параметром (JSON).
 * Запись, которой нет, — ошибка: массовые операции перед этим блокируют свои записи (FOR UPDATE).
 */
export async function updateRecordValues(db: Db, rows: readonly RecordValuesUpdate[]): Promise<void> {
  for (const part of chunks(rows, BATCH_MAX_ROWS)) {
    const json = JSON.stringify(part.map((r) => ({ id: r.id, v: r.values, s: r.searchText, m: r.manualFieldIds ?? null })));
    const count = await db.$executeRaw`
      UPDATE register_records AS r
      SET "values" = d.v, search_text = d.s,
          manual_field_ids = CASE WHEN d.m IS NULL THEN r.manual_field_ids ELSE ARRAY(SELECT jsonb_array_elements_text(d.m))::uuid[] END,
          version = r.version + 1, updated_at = now()
      FROM jsonb_to_recordset(${json}::jsonb) AS d(id uuid, v jsonb, s text, m jsonb)
      WHERE r.id = d.id`;
    if (count !== part.length) throw new Error(`updateRecordValues: обновлено ${count} записей из ${part.length}`);
  }
}

/** id в пачках для «= ANY($1::uuid[])»: один параметр на пачку. */
export function idChunks(ids: readonly string[]): string[][] {
  return chunks(ids, BATCH_MAX_ROWS);
}
