// Файлы полей «Файл» записей реестров (этап 8б, ADR-0013): привязка и мягкая отвязка (право records.edit).
// Зафиксированное поле (статус записи из settings.lock) — файл не отвязывается и второй не добавляется;
// то же проверяет триггер register_record_files_guard. История — в журнале аудита записи.
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, unprocessable, versionConflict } from '../../lib/errors.js';
import type { Values } from '../../lib/register-values.js';
import { claimFiles, deleteIfUnreferenced } from '../files/links.js';
import { auditSettings, ensureVersioned, type Actor } from '../settings/common.js';
import { assertNotArchived, loadRegister, recordLocks, type FieldMeta, type RegisterDef } from './definition.js';
import { getRecord } from './records.service.js';

/** Не больше файлов в одном поле записи. */
export const FILES_PER_FIELD_MAX = 20;

async function recordAndField(tx: Db, recordId: string, fieldId: string, version: number) {
  const row = await tx.registerRecord.findFirst({ where: { id: recordId, deletedAt: null }, select: { id: true, registerId: true, number: true, values: true, version: true, archivedAt: true } });
  if (!row) throw notFound('Запись');
  const reg = await loadRegister(tx, row.registerId);
  assertNotArchived(reg);
  if (row.archivedAt) throw conflict('RECORD_ARCHIVED', 'Запись в архиве. Верните её, чтобы изменить');
  if (row.version !== version) throw versionConflict();
  const field = reg.fields.find((f) => f.id === fieldId);
  if (!field || field.type !== 'file') throw badRequest('NOT_FILE_FIELD', 'Поле не найдено или это не поле «Файл». Обновите страницу');
  return { row, reg, field };
}

function lockMessage(reg: RegisterDef, field: FieldMeta, values: Values): string {
  const status = reg.fields.find((f) => f.isStatus);
  const name = status?.options.find((o) => o.id === values[status.id])?.label ?? '';
  return `«${field.label}» зафиксировано статусом «${name}» — заменить или отвязать документ нельзя, только новой записью`;
}

/** Отметить изменение записи: версия +1 (параллельная правка получит 409). */
async function bumpVersion(tx: Db, id: string, version: number) {
  const res = await tx.registerRecord.updateMany({ where: { id, version, deletedAt: null }, data: { version: { increment: 1 } } });
  await ensureVersioned(res.count, () => tx.registerRecord.findFirst({ where: { id, deletedAt: null } }), 'Запись');
}

export async function attachFiles(db: Db, actor: Actor, recordId: string, input: { fieldId: string; fileIds: string[]; version: number }) {
  return withTx(db, async (tx) => {
    const { row, reg, field } = await recordAndField(tx, recordId, input.fieldId, input.version);
    if (field.archived) throw badRequest('ARCHIVED_FIELD', `Поле «${field.label}» в архиве`);
    const current = await tx.registerRecordFile.findMany({ where: { recordId, fieldId: field.id, removedAt: null }, select: { fileId: true } });
    const values = (row.values ?? {}) as Values;
    if (recordLocks(reg, values).get(field.id) === 'locked' && current.length > 0) throw unprocessable('FIELD_LOCKED', lockMessage(reg, field, values));
    const fresh = [...new Set(input.fileIds)].filter((id) => !current.some((c) => c.fileId === id));
    if (!fresh.length) throw badRequest('NO_FILES', 'Эти файлы уже приложены');
    if (current.length + fresh.length > FILES_PER_FIELD_MAX) throw badRequest('TOO_MANY_FILES', `В поле — не больше ${FILES_PER_FIELD_MAX} файлов`);
    const files = await claimFiles(tx, actor.id, fresh, { what: field.label });
    await tx.registerRecordFile.createMany({ data: files.map((f) => ({ recordId, fieldId: field.id, fileId: f.id, addedBy: actor.id })) });
    await bumpVersion(tx, recordId, input.version);
    const names = files.map((f) => f.originalName);
    await auditSettings(tx, actor, {
      action: 'register_record.updated', entity: 'register_record', entityId: recordId,
      summary: `«${reg.name}», запись #${row.number}: в «${field.label}» приложено: ${names.map((n) => `«${n}»`).join(', ')}`,
      after: {
        changes: [{ fieldId: field.id, label: field.label, from: '', to: names.join('; ') }],
        via: 'files',
        files: files.map((f) => ({ id: f.id, name: f.originalName, sha256: f.sha256 })),
      },
    });
    return getRecord(tx, recordId);
  });
}

/** Отвязка мягкая: ссылка остаётся в истории (removed_at), файл помечается удалённым, только если ссылок больше нет. */
export async function detachFile(db: Db, actor: Actor, recordId: string, linkId: string, version: number) {
  return withTx(db, async (tx) => {
    const link = await tx.registerRecordFile.findFirst({ where: { id: linkId, recordId, removedAt: null }, include: { file: { select: { id: true, originalName: true, sha256: true } } } });
    if (!link) throw notFound('Файл записи');
    const { row, reg, field } = await recordAndField(tx, recordId, link.fieldId, version);
    const values = (row.values ?? {}) as Values;
    if (recordLocks(reg, values).get(field.id) === 'locked') throw unprocessable('FIELD_LOCKED', lockMessage(reg, field, values));
    await tx.registerRecordFile.update({ where: { id: linkId }, data: { removedAt: new Date(), removedBy: actor.id } });
    await bumpVersion(tx, recordId, version);
    await auditSettings(tx, actor, {
      action: 'register_record.updated', entity: 'register_record', entityId: recordId,
      summary: `«${reg.name}», запись #${row.number}: из «${field.label}» отвязан «${link.file.originalName}»`,
      after: {
        changes: [{ fieldId: field.id, label: field.label, from: link.file.originalName, to: '' }],
        via: 'files',
        files: [{ id: link.file.id, name: link.file.originalName, sha256: link.file.sha256, removed: true }],
      },
    });
    await deleteIfUnreferenced(tx, actor, link.file.id, `отвязан от записи #${row.number} «${reg.name}»`);
    return getRecord(tx, recordId);
  });
}
