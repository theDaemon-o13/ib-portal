// Ключ записи узла (релиз 1.5.0, ADR-0029): «Пакет + Идентификатор» без учёта регистра и лишних пробелов.
// Хранится в vuln_records.key_norm (уникален в узле); разделитель — U+001F: в тексте PostgreSQL нельзя U+0000.
import type { Db } from '../../lib/db.js';

export const keyNorm = (pkg: string, id: string): string =>
  `${pkg.trim().toLowerCase().replace(/\s+/g, ' ')}\u001f${id.trim().toLowerCase().replace(/\s+/g, ' ')}`;

/** Удалённая запись освобождает ключ в узле: следующий скан заведёт её заново. */
export async function releaseVulnKeys(tx: Db, recordIds: readonly string[]): Promise<void> {
  if (recordIds.length) await tx.vulnRecord.updateMany({ where: { recordId: { in: [...recordIds] }, keyNorm: { not: null } }, data: { keyNorm: null } });
}
