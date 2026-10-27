// Привязка файлов к объектам и отметка «удалён» (этап 7, ADR-0011). Без зависимостей от модулей-владельцев:
// документы, доказательства и решения вызывают эти функции в своей транзакции.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import { auditSettings, type Actor } from '../settings/common.js';

/** Непривязанный файл старше суток помечается удалённым в часовом прогоне. */
export const ORPHAN_HOURS = 24;

export const withUploader = { uploader: { select: { id: true, fullName: true } } } as const;
type FileRow = Prisma.FileGetPayload<{ include: typeof withUploader }>;

export function fileDto(f: FileRow) {
  return {
    id: f.id,
    name: f.originalName,
    mime: f.mime,
    size: Number(f.size),
    sha256: f.sha256,
    uploadedAt: f.uploadedAt.toISOString(),
    uploadedBy: f.uploader,
    deleted: f.deletedAt !== null,
  };
}
export type FileDto = ReturnType<typeof fileDto>;

/**
 * Файлы, которые пользователь прикладывает к объекту: свои, не удалённые, нужного типа.
 * Блокировка строк (FOR UPDATE): часовая очистка не пометит файл удалённым, пока идёт привязка.
 */
export async function claimFiles(tx: Db, actorId: string, ids: readonly string[], opts: { mimes?: readonly string[]; what?: string } = {}) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM files WHERE id = ANY(${unique}::uuid[]) AND deleted_at IS NULL FOR UPDATE`;
  const rows = await tx.file.findMany({ where: { id: { in: locked.map((r) => r.id) } }, include: withUploader });
  for (const id of unique) {
    const f = rows.find((r) => r.id === id);
    if (!f) throw badRequest('FILE_NOT_FOUND', 'Файл не найден или удалён. Загрузите его заново');
    if (f.uploadedBy !== actorId) throw badRequest('FILE_NOT_YOURS', `Файл «${f.originalName}» загрузил другой пользователь — загрузите его сами`);
    if (opts.mimes && !opts.mimes.includes(f.mime)) throw badRequest('BAD_FILE_TYPE', `${opts.what ?? 'Файл'}: «${f.originalName}» — неподходящий тип`);
  }
  return unique.map((id) => rows.find((r) => r.id === id) as FileRow);
}

/** Пометить файл удалённым, если на него больше нет ссылок (после отвязки или замены). */
export async function deleteIfUnreferenced(tx: Db, actor: Actor | null, fileId: string, why: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string; original_name: string }[]>`
    UPDATE files SET deleted_at = now(), deleted_by = ${actor?.id ?? null}::uuid
    WHERE id = ${fileId}::uuid AND deleted_at IS NULL AND file_active_refs(id) = 0
    RETURNING id::text, original_name`;
  const f = rows[0];
  if (!f) return false;
  const entry = { action: 'file.deleted', entity: 'file', entityId: f.id, summary: `Файл «${f.original_name}» помечен удалённым: ${why}` };
  if (actor) await auditSettings(tx, actor, entry);
  else await tx.auditLog.create({ data: { userId: null, action: entry.action, entity: entry.entity, entityId: entry.entityId, diff: { summary: entry.summary } } });
  return true;
}

/**
 * Часовой прогон: непривязанные файлы старше суток (загрузили и не приложили) помечаются удалённым.
 * Содержимое остаётся на диске — физически файлы не удаляются. Запись в журнал по каждому (автор — система).
 */
export async function sweepOrphanFiles(tx: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ORPHAN_HOURS * 3_600_000);
  const rows = await tx.$queryRaw<{ id: string; original_name: string; uploaded_by: string }[]>`
    UPDATE files SET deleted_at = ${now}
    WHERE deleted_at IS NULL AND uploaded_at < ${cutoff} AND file_active_refs(id) = 0
    RETURNING id::text, original_name, uploaded_by::text`;
  for (const f of rows) {
    await tx.auditLog.create({
      data: {
        userId: null, action: 'file.orphan_deleted', entity: 'file', entityId: f.id,
        diff: { summary: `Файл «${f.original_name}» никуда не приложен больше ${ORPHAN_HOURS} ч — помечен удалённым`, uploadedBy: f.uploaded_by },
      },
    });
  }
  return rows.length;
}
