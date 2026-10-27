// Связи между записями (поле «Связь с записью»), файлы полей «Файл» и источники статуса основания
// (этап 8б, ADR-0013). Только чтение: запись — в records.service и record-files.service.
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { isBasisRule, type SourceRecord } from '../../lib/link-basis.js';
import type { Values } from '../../lib/register-values.js';
import { fileDto, withUploader, type FileDto } from '../files/links.js';
import type { RegisterDef } from './definition.js';

export interface LinkRef {
  id: string;
  registerId: string;
  number: number;
  title: string;
  /** Запись удалена: связь осталась в значении, но открыть её нельзя. */
  deleted: boolean;
}

/** Подпись связанной записи: «#12 WS-BUH-014». */
export function linkLabel(r: Pick<LinkRef, 'number' | 'title'>): string {
  return r.title ? `#${r.number} ${r.title}` : `#${r.number}`;
}

/** id записей во всех полях «Связь с записью» реестра. */
export function linkIdsIn(reg: RegisterDef, values: readonly Values[]): string[] {
  const fields = reg.fields.filter((f) => f.type === 'link');
  const ids = new Set<string>();
  for (const v of values) for (const f of fields) {
    const x = v[f.id];
    if (Array.isArray(x)) for (const id of x) ids.add(id);
  }
  return [...ids];
}

/** Заголовки записей по id (заголовок — поле is_title их реестра). */
export async function loadLinkRefs(db: Db, ids: readonly string[]): Promise<Map<string, LinkRef>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const rows = await db.$queryRaw<{ id: string; register_id: string; number: number; title: string | null; deleted: boolean }[]>`
    SELECT r.id::text, r.register_id::text, r.number,
           r."values" ->> (SELECT f.id::text FROM register_fields f
                           WHERE f.register_id = r.register_id AND f.is_title AND f.deleted_at IS NULL LIMIT 1) AS title,
           r.deleted_at IS NOT NULL AS deleted
    FROM register_records r WHERE r.id = ANY(${uniq}::uuid[])`;
  return new Map(rows.map((r) => [r.id, { id: r.id, registerId: r.register_id, number: r.number, title: r.title ?? '', deleted: r.deleted }]));
}

/** id → подпись для displayValue и текста поиска. */
export function linkLabels(refs: ReadonlyMap<string, LinkRef>): Map<string, string> {
  return new Map([...refs.values()].map((r) => [r.id, linkLabel(r)]));
}

/**
 * Записи реестров-источников статуса основания: разрешения, которые ссылаются на recordIds
 * (null — на любую запись реестра: фильтры, дашборд, автоматизации считают по всему реестру).
 */
export async function loadBasisSources(db: Db, reg: RegisterDef, recordIds: readonly string[] | null): Promise<Map<string, SourceRecord[]>> {
  const out = new Map<string, SourceRecord[]>();
  const rules = reg.fields.map((f) => f.calcRule).filter(isBasisRule);
  if (recordIds && !recordIds.length) return out;
  for (const rule of rules) {
    if (out.has(rule.sourceRegisterId)) {
      continue;
    }
    const linkFields = [...new Set(rules.filter((r) => r.sourceRegisterId === rule.sourceRegisterId).map((r) => r.linkFieldId))];
    const rows = await db.$queryRaw<{ id: string; number: number; values: Values }[]>`
      SELECT r.id::text, r.number, r."values" FROM register_records r
      WHERE r.register_id = ${rule.sourceRegisterId}::uuid AND r.deleted_at IS NULL
        ${recordIds
          ? Prisma.sql`AND (${Prisma.join(linkFields.map((fid) => Prisma.sql`(r."values" -> ${fid}) ?| ${[...recordIds]}::text[]`), ' OR ')})`
          : Prisma.empty}`;
    out.set(rule.sourceRegisterId, rows);
  }
  return out;
}

export interface FileLinkDto {
  linkId: string;
  file: FileDto;
  addedAt: string;
  addedBy: { id: string; fullName: string };
}

/** Действующие файлы полей «Файл»: запись → поле → файлы (по порядку добавления). */
export async function loadRecordFiles(db: Db, recordIds: readonly string[]): Promise<Map<string, Map<string, FileLinkDto[]>>> {
  const out = new Map<string, Map<string, FileLinkDto[]>>();
  if (!recordIds.length) return out;
  const rows = await db.registerRecordFile.findMany({
    where: { recordId: { in: [...recordIds] }, removedAt: null },
    include: { file: { include: withUploader }, adder: { select: { id: true, fullName: true } } },
    orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
  });
  for (const r of rows) {
    const byField = out.get(r.recordId) ?? new Map<string, FileLinkDto[]>();
    byField.set(r.fieldId, [...(byField.get(r.fieldId) ?? []), {
      linkId: r.id, file: fileDto(r.file), addedAt: r.addedAt.toISOString(), addedBy: r.adder,
    }]);
    out.set(r.recordId, byField);
  }
  return out;
}

/** Поля «Связь с записью» любых реестров, которые ссылаются на реестр registerId. */
export async function linkFieldsTo(db: Db, registerId: string) {
  return db.registerField.findMany({
    where: { type: 'link', linkRegisterId: registerId, deletedAt: null, register: { archivedAt: null } },
    select: { id: true, label: true, registerId: true, register: { select: { name: true } } },
  });
}

/** Записи, которые ссылаются на recordId полем fieldId (GIN-индекс по "values"). */
export async function recordsLinkingTo(db: Db, fieldId: string, recordId: string) {
  return db.$queryRaw<{ id: string }[]>`
    SELECT r.id::text FROM register_records r
    WHERE r."values" @> ${JSON.stringify({ [fieldId]: [recordId] })}::jsonb AND r.deleted_at IS NULL
    ORDER BY r.number DESC LIMIT 500`;
}
