import { z } from 'zod';

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export type PageQuery = z.infer<typeof PageQuery>;

/** Берём limit + 1 строку: лишняя означает, что есть следующая страница. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? cursorOf(last) : null };
}

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
