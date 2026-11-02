// Массовые действия с записями реестра (релиз 1.1.0, ADR-0016): архивировать, вернуть из архива, удалить —
// выбранные записи, все по фильтру списка или все записи реестра.
//
// Два шага, как у импорта Excel: предпросмотр (сколько затронет и почему) → применение с теми же числами
// в expected. Сервер заново считает выборку; если числа разошлись — 409 и ничего не меняется.
// Применение — пакетами по BULK_BATCH записей, каждый пакет в своей транзакции; по каждой записи —
// та же запись журнала, что и у одиночного действия (история карточки), плюс одна сводная запись.
// Удаление мягкое (раздел 3.4); запись с зависимостями (dependencies.ts) уходит в архив.
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import { withTx, type Db } from '../../lib/db.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { assertNotArchived, loadRegister, type RegisterDef } from './definition.js';
import { DEPENDENCY_REASONS, recordDependencies, type DependencyReason } from './dependencies.js';
import { deletedSnapshot, selectRecordIds, type SelectionQuery } from './records.service.js';
import { releaseVulnKeys } from '../vulns/keys.js';
import { isVulnRegister } from '../vulns/definition.js';
import { checkRecordReason, createDeletion, reasonText, vulnSnapshot, type RecordReason } from '../trash/service.js';

export const BULK_BATCH = 200;
/** Явный список id — не больше; больше — выбор «все по фильтру». */
export const BULK_MAX_IDS = 5000;

export const BULK_ACTIONS = ['archive', 'restore', 'delete'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export type BulkSelection =
  | { ids: string[] }
  | { query: SelectionQuery; excludeIds?: string[] }
  | { all: true };

export interface BulkCounts {
  /** Найдено записей по выборке (удалённые и чужие id не считаются). */
  total: number;
  willDelete: number;
  willArchive: number;
  willRestore: number;
  /** Уже в нужном состоянии: архивная при «Архивировать», действующая при «Вернуть», архивная с зависимостями при «Удалить». */
  alreadyInState: number;
}

export interface BulkPreview extends BulkCounts {
  /** Сколько записей с каждой зависимостью (только у удаления; у записи их может быть несколько). */
  byReason: Record<DependencyReason, number>;
}

export interface BulkResult {
  deleted: number;
  archived: number;
  restored: number;
  skipped: number;
  byReason: Record<DependencyReason, number>;
}

interface Row {
  id: string;
  number: number;
  values: unknown;
  archivedAt: Date | null;
}

interface Plan extends BulkPreview {
  reg: RegisterDef;
  deleteRows: Row[];
  archiveRows: Row[];
  restoreRows: Row[];
  reasons: Map<string, DependencyReason[]>;
}

const emptyReasons = (): Record<DependencyReason, number> =>
  Object.fromEntries(DEPENDENCY_REASONS.map((r) => [r, 0])) as Record<DependencyReason, number>;

async function selectionIds(db: Db, reg: RegisterDef, selection: BulkSelection): Promise<string[]> {
  if ('ids' in selection) {
    if (selection.ids.length > BULK_MAX_IDS) throw badRequest('TOO_MANY_IDS', `Выбрано больше ${BULK_MAX_IDS} записей — выберите «все по фильтру»`);
    return [...new Set(selection.ids)];
  }
  if ('all' in selection) return selectRecordIds(db, reg, { includeArchived: true });
  const exclude = new Set(selection.excludeIds ?? []);
  return (await selectRecordIds(db, reg, selection.query)).filter((id) => !exclude.has(id));
}

async function loadRows(db: Db, registerId: string, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  return db.registerRecord.findMany({
    where: { registerId, deletedAt: null, id: { in: ids } },
    select: { id: true, number: true, values: true, archivedAt: true },
    orderBy: { number: 'asc' },
  });
}

/** Зависимости — частями: запрос с ANY(ids) по 1000 id. */
async function dependenciesOf(db: Db, reg: RegisterDef, rows: readonly Row[]) {
  const out = new Map<string, DependencyReason[]>();
  for (let i = 0; i < rows.length; i += 1000) {
    for (const [id, r] of await recordDependencies(db, reg, rows.slice(i, i + 1000))) out.set(id, r);
  }
  return out;
}

async function plan(db: Db, registerId: string, action: BulkAction, selection: BulkSelection): Promise<Plan> {
  const reg = await loadRegister(db, registerId);
  assertNotArchived(reg);
  const rows = await loadRows(db, reg.id, await selectionIds(db, reg, selection));
  const out: Plan = {
    reg, total: rows.length, willDelete: 0, willArchive: 0, willRestore: 0, alreadyInState: 0, byReason: emptyReasons(),
    deleteRows: [], archiveRows: [], restoreRows: [], reasons: new Map(),
  };
  if (action === 'archive') {
    out.archiveRows = rows.filter((r) => !r.archivedAt);
  } else if (action === 'restore') {
    out.restoreRows = rows.filter((r) => r.archivedAt);
  } else {
    out.reasons = await dependenciesOf(db, reg, rows);
    for (const r of rows) {
      const why = out.reasons.get(r.id);
      if (!why) out.deleteRows.push(r);
      else if (!r.archivedAt) out.archiveRows.push(r);
      for (const reason of why ?? []) out.byReason[reason]++;
    }
  }
  out.willDelete = out.deleteRows.length;
  out.willArchive = out.archiveRows.length;
  out.willRestore = out.restoreRows.length;
  out.alreadyInState = out.total - out.willDelete - out.willArchive - out.willRestore;
  return out;
}

const countsOf = (p: BulkCounts): BulkCounts =>
  ({ total: p.total, willDelete: p.willDelete, willArchive: p.willArchive, willRestore: p.willRestore, alreadyInState: p.alreadyInState });

export async function previewBulk(db: Db, registerId: string, action: BulkAction, selection: BulkSelection): Promise<BulkPreview> {
  const p = await plan(db, registerId, action, selection);
  return { ...countsOf(p), byReason: p.byReason };
}

const REASON_NAMES: Record<DependencyReason, string> = {
  locked: 'зафиксированные поля', decisions: 'решения другого отдела', evidence: 'доказательства', tasks: 'открытые задачи', links: 'ссылки из других записей',
};

function describeSelection(selection: BulkSelection): unknown {
  if ('ids' in selection) return { kind: 'ids', count: selection.ids.length };
  if ('all' in selection) return { kind: 'all' };
  return { kind: 'filter', query: selection.query, excludeIds: selection.excludeIds ?? [] };
}

/**
 * Применение. expected — числа из предпросмотра: если выборка изменилась (кто-то добавил, удалил,
 * отправил в архив, появились задачи), ответ 409 BULK_CHANGED с новыми числами, ничего не меняется.
 */
export async function applyBulk(
  db: Db, actor: Actor, registerId: string, action: BulkAction, selection: BulkSelection,
  expected: Omit<BulkCounts, 'alreadyInState'>, label = 'массовое действие', reason?: RecordReason,
): Promise<BulkResult> {
  const p = await plan(db, registerId, action, selection);
  const delReason = action === 'delete' ? checkRecordReason(reason ?? { reasonCode: '' as never }, isVulnRegister(p.reg)) : null;
  const now = countsOf(p);
  if (now.total !== expected.total || now.willDelete !== expected.willDelete || now.willArchive !== expected.willArchive || now.willRestore !== expected.willRestore) {
    throw new AppError(409, 'BULK_CHANGED', 'Записи изменились после предпросмотра — проверьте числа и подтвердите ещё раз', { preview: { ...now, byReason: p.byReason } });
  }
  const { reg } = p;
  const deletedIds: string[] = [];
  const archivedIds: string[] = [];
  const restoredIds: string[] = [];
  // Причины «не удалена»: из предпросмотра плюс появившиеся к моменту применения.
  const finalReasons = new Map(p.reasons);

  // Одно событие корзины на всё удаление (1.6.1): заводится до пакетов по окончательному составу — зависимости
  // перепроверяются здесь; появившиеся позже (внутри пакета) переводят запись в архив, как раньше.
  let deletionId: string | null = null;
  if (delReason && p.deleteRows.length) {
    const fresh = await dependenciesOf(db, reg, p.deleteRows);
    const late = p.deleteRows.filter((r) => fresh.has(r.id));
    for (const r of late) {
      p.reasons.set(r.id, fresh.get(r.id) as DependencyReason[]);
      if (!r.archivedAt) p.archiveRows.push(r);
    }
    p.deleteRows = p.deleteRows.filter((r) => !fresh.has(r.id));
    if (p.deleteRows.length) {
      const snapshot = await vulnSnapshot(db, reg, p.deleteRows);
      deletionId = await createDeletion(db, actor, {
        entity: 'register_records', entityId: reg.id, title: reg.name, ...delReason, counts: { records: p.deleteRows.length }, snapshot,
      });
    }
  }

  // Удаление: зависимости проверяются ещё раз внутри пакета — появившаяся задача переводит запись в архив.
  const work: { row: Row; op: 'delete' | 'archive' | 'restore' }[] = [
    ...p.deleteRows.map((row) => ({ row, op: 'delete' as const })),
    ...p.archiveRows.map((row) => ({ row, op: 'archive' as const })),
    ...p.restoreRows.map((row) => ({ row, op: 'restore' as const })),
  ];
  for (let i = 0; i < work.length; i += BULK_BATCH) {
    const batch = work.slice(i, i + BULK_BATCH);
    await withTx(db, async (tx) => {
      const toDelete = batch.filter((w) => w.op === 'delete').map((w) => w.row);
      const fresh = await recordDependencies(tx, reg, toDelete);
      const at = new Date();
      for (const w of batch) {
        const { row } = w;
        const why = action === 'delete' ? (w.op === 'delete' ? fresh.get(row.id) : p.reasons.get(row.id)) : undefined;
        const op = w.op === 'delete' && why ? 'archive' : w.op;
        if (w.op === 'delete' && why) finalReasons.set(row.id, why);
        if (op === 'delete') {
          const res = await tx.registerRecord.updateMany({ where: { id: row.id, deletedAt: null }, data: { deletedAt: at, deletionId, version: { increment: 1 } } });
          if (!res.count) continue;
          await releaseVulnKeys(tx, [row.id]);
          await auditSettings(tx, actor, {
            action: 'register_record.deleted', entity: 'register_record', entityId: row.id,
            summary: `«${reg.name}»: удалена запись #${row.number} (${label}). Причина: ${delReason ? reasonText(delReason.reasonCode, delReason.reason) : '—'}`,
            before: await deletedSnapshot(tx, reg, row),
            after: { deletionId },
          });
          deletedIds.push(row.id);
        } else if (op === 'archive') {
          const res = await tx.registerRecord.updateMany({ where: { id: row.id, deletedAt: null, archivedAt: null }, data: { archivedAt: at, version: { increment: 1 } } });
          if (!res.count) continue;
          const because = why ? `: не удаляется — ${why.map((r) => REASON_NAMES[r]).join(', ')}` : '';
          await auditSettings(tx, actor, {
            action: 'register_record.archived', entity: 'register_record', entityId: row.id,
            summary: `«${reg.name}», запись #${row.number}: отправлена в архив (${label}${because})`,
          });
          archivedIds.push(row.id);
        } else {
          const res = await tx.registerRecord.updateMany({ where: { id: row.id, deletedAt: null, archivedAt: { not: null } }, data: { archivedAt: null, version: { increment: 1 } } });
          if (!res.count) continue;
          await auditSettings(tx, actor, {
            action: 'register_record.restored', entity: 'register_record', entityId: row.id,
            summary: `«${reg.name}», запись #${row.number}: возвращена из архива (${label})`,
          });
          restoredIds.push(row.id);
        }
      }
    });
  }
  // Разбивка «почему не удалены»: и ушедшие в архив сейчас, и уже бывшие в архиве.
  const byReason = emptyReasons();
  const deletedSet = new Set(deletedIds);
  for (const [id, why] of finalReasons) if (!deletedSet.has(id)) for (const reason of why) byReason[reason]++;

  const result: BulkResult = {
    deleted: deletedIds.length, archived: archivedIds.length, restored: restoredIds.length,
    skipped: p.total - deletedIds.length - archivedIds.length - restoredIds.length, byReason,
  };
  const parts = [
    result.deleted ? `удалено ${result.deleted}` : '', result.archived ? `в архив ${result.archived}` : '',
    result.restored ? `возвращено ${result.restored}` : '', result.skipped ? `без изменений ${result.skipped}` : '',
  ].filter(Boolean);
  await auditSettings(db, actor, {
    action: `register_records.bulk_${action}`, entity: 'register', entityId: reg.id,
    summary: `«${reg.name}»: ${label} — ${parts.join(', ') || 'ничего не изменилось'}`,
    after: {
      count: p.total, deletedIds, archivedIds, restoredIds, ...(delReason ? { deletionId, ...delReason } : {}),
      reasons: Object.fromEntries(Object.entries(byReason).filter(([, n]) => n > 0)),
      selection: describeSelection(selection),
    },
  });
  return result;
}

/** «Удалить все записи»: подтверждение вводом названия реестра (сверяется на сервере). */
export async function deleteAllRecords(
  db: Db, actor: Actor, registerId: string, confirmName: string, expected: Omit<BulkCounts, 'alreadyInState'>, reason?: RecordReason,
): Promise<BulkResult> {
  const reg = await loadRegister(db, registerId);
  if (confirmName.trim() !== reg.name.trim()) throw conflict('CONFIRM_NAME', 'Название реестра введено неверно — записи не удалены');
  return applyBulk(db, actor, registerId, 'delete', { all: true }, expected, 'удаление всех записей', reason);
}
