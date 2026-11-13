// Системные цепочки автозадач реестров (1.14.0, ADR-0053). Сознательное исключение из правила 1.7.0 «автоматически
// ничего не склеивается»: только задачи автоматизаций реестров (source = 'automation'). Источник — по ссылкам задачи,
// заголовок не разбирается:
//   запись реестра «Уязвимости» → vuln_records.node_id → vuln_nodes.group_id → «Уязвимости · <группа>»;
//   запись любого другого реестра или сводная задача правила → «Реестр · <название>».
// Одна неудалённая системная цепочка на источник (частичный уникальный индекс task_chains_system_source_uq).
// Создаёт и наполняет только портал, создатель — служебная учётная запись «Портал» (lib/system-user.ts).
// Название — снимок в task_chains.title, его обновляет переименование группы или реестра в той же транзакции.
// Отвязанную или перенесённую человеком задачу портал больше не привязывает (manuallyChained).
import type { Prisma } from '../../generated/prisma/client.js';
import { chunks, createManyChunked } from '../../lib/bulk.js';
import type { Db } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { systemUserId } from '../../lib/system-user.js';
import { titleKey } from '../../lib/title-key.js';
import { auditSettingsMany, type Actor } from '../settings/common.js';
import { VULN_REGISTER_KEY } from '../vulns/definition.js';

export const SYSTEM_SOURCE_TYPES = ['register', 'vuln_group'] as const;
export type SourceType = (typeof SYSTEM_SOURCE_TYPES)[number];
export interface ChainSource { type: SourceType; id: string; name: string }
export interface SystemChainRef { id: string; number: number; title: string }

/** Отметки via в журнале, которые ставит сам портал: остальные записи task.chain_* — действие человека. */
export const SYSTEM_VIA = ['system', 'system_discover', 'system_transfer'] as const;

const TITLE_MAX = 300;
export const systemChainTitle = (s: Pick<ChainSource, 'type' | 'name'>) =>
  `${s.type === 'vuln_group' ? 'Уязвимости' : 'Реестр'} · ${s.name}`.slice(0, TITLE_MAX);

export const systemChainError = () => new AppError(409, 'SYSTEM_CHAIN', 'Системную цепочку ведёт портал: задачи в неё добавляет только он, править, закрывать и удалять её нельзя');

export function assertNotSystem(c: { kind: string }) {
  if (c.kind === 'system') throw systemChainError();
}

/** Почему источник не определён — для предпросмотра сборки старых задач. */
export type NoSourceReason = 'vuln_without_node' | 'vuln_digest' | 'no_link';
export type SourceOf = { source: ChainSource } | { source: null; reason: NoSourceReason };

/** Источники по записям реестров: id записи → источник. Неизвестная запись в ответе отсутствует. */
export async function sourcesOfRecords(db: Db, recordIds: readonly string[]): Promise<Map<string, SourceOf>> {
  const out = new Map<string, SourceOf>();
  for (const ids of chunks([...new Set(recordIds)], 1000)) {
    const rows = await db.$queryRaw<{ record_id: string; register_id: string; register_name: string; system_key: string | null; group_id: string | null; group_name: string | null }[]>`
      SELECT r.id::text AS record_id, reg.id::text AS register_id, reg.name AS register_name, reg.system_key,
             g.id::text AS group_id, g.name AS group_name
        FROM register_records r
        JOIN registers reg ON reg.id = r.register_id
        LEFT JOIN vuln_records vr ON vr.record_id = r.id
        LEFT JOIN vuln_nodes n ON n.id = vr.node_id
        LEFT JOIN vuln_groups g ON g.id = n.group_id
       WHERE r.id = ANY(${ids}::uuid[])`;
    for (const r of rows) {
      if (r.system_key === VULN_REGISTER_KEY) {
        out.set(r.record_id, r.group_id && r.group_name !== null
          ? { source: { type: 'vuln_group', id: r.group_id, name: r.group_name } }
          : { source: null, reason: 'vuln_without_node' });
      } else {
        out.set(r.record_id, { source: { type: 'register', id: r.register_id, name: r.register_name } });
      }
    }
  }
  return out;
}

/** Источник сводной задачи правила (без записи): реестр правила. У «Уязвимостей» группы нет — не определён. */
export function sourceOfRegister(reg: { id: string; name: string; systemKey: string | null }): SourceOf {
  if (reg.systemKey === VULN_REGISTER_KEY) return { source: null, reason: 'vuln_digest' };
  return { source: { type: 'register', id: reg.id, name: reg.name } };
}

const key = (s: Pick<ChainSource, 'type' | 'id'>) => `${s.type}|${s.id}`;

/**
 * Системная цепочка источника; нет — создаётся. Два одновременных создания: INSERT … ON CONFLICT DO NOTHING ждёт
 * транзакцию-соперника, после неё строка уже видна повторному чтению — дубля нет. Закрытую (1.13.12 после отката)
 * открывает: системная цепочка всегда открыта. cache — на один прогон.
 */
export async function ensureSystemChain(tx: Db, s: ChainSource, cache?: Map<string, SystemChainRef>): Promise<SystemChainRef> {
  const k = key(s);
  const hit = cache?.get(k);
  if (hit) return hit;
  const find = () => tx.taskChain.findFirst({
    where: { kind: 'system', sourceType: s.type, sourceId: s.id, deletedAt: null }, select: { id: true, number: true, title: true, status: true },
  });
  let row = await find();
  if (!row) {
    const title = systemChainTitle(s);
    const tk = titleKey(title) ?? 'system';
    const creator = await systemUserId(tx);
    const inserted = await tx.$queryRaw<{ id: string; number: number }[]>`
      INSERT INTO task_chains (title, title_key, created_by, kind, source_type, source_id, updated_at)
      VALUES (${title}, ${tk}, ${creator}::uuid, 'system', ${s.type}, ${s.id}::uuid, now())
      ON CONFLICT (source_type, source_id) WHERE kind = 'system' AND deleted_at IS NULL DO NOTHING
      RETURNING id::text, number`;
    const created = inserted[0];
    if (created) {
      await tx.auditLog.create({
        data: {
          userId: null, action: 'task_chain.created', entity: 'task_chain', entityId: created.id,
          diff: { summary: `Системная цепочка #${created.number} «${title}» создана`, after: { kind: 'system', sourceType: s.type, sourceId: s.id, via: 'system' } } as Prisma.InputJsonValue,
        },
      });
      row = { id: created.id, number: created.number, title, status: 'open' };
    } else {
      row = await find();
      if (!row) throw new Error(`системная цепочка ${k}: конфликт вставки, но строки нет`);
    }
  }
  if (row.status !== 'open') {
    await tx.taskChain.update({ where: { id: row.id }, data: { status: 'open', closedAt: null, version: { increment: 1 } } });
  }
  const ref = { id: row.id, number: row.number, title: row.title };
  cache?.set(k, ref);
  return ref;
}

/** Строки журнала «добавлена в цепочку автоматически» (автор — система). */
export function linkedAuditRows(tasks: readonly { id: string; number: number }[], chain: SystemChainRef, via: (typeof SYSTEM_VIA)[number], note = ''): Prisma.AuditLogCreateManyInput[] {
  const to = `«${chain.title}» (#${chain.number})`;
  return tasks.map((t) => ({
    userId: null, action: 'task.chain_linked', entity: 'task', entityId: t.id,
    diff: {
      summary: `Задача #${t.number} добавлена в цепочку ${to} автоматически${note}`,
      after: { fromChainId: null, toChainId: chain.id, via, changes: [{ field: 'chainId', label: 'Цепочка', from: '—', to }] },
    } as Prisma.InputJsonValue,
  }));
}

export async function writeAudit(tx: Db, rows: readonly Prisma.AuditLogCreateManyInput[]) {
  await createManyChunked(rows, 6, (data) => tx.auditLog.createMany({ data }));
}

/**
 * Задачи, цепочку которых хоть раз менял человек: привязал, отвязал, перенёс, удалил ручную цепочку.
 * Портал такие задачи в системные цепочки не привязывает — ни при сборке старых, ни при переносе записи.
 */
export async function manuallyChained(db: Db, taskIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ids of chunks([...new Set(taskIds)], 1000)) {
    const rows = await db.$queryRaw<{ entity_id: string }[]>`
      SELECT DISTINCT entity_id FROM audit_log
       WHERE entity = 'task' AND entity_id = ANY(${ids}::text[]) AND action LIKE 'task.chain\\_%'
         AND COALESCE(diff->'after'->>'via', '') <> ALL(${[...SYSTEM_VIA]}::text[])`;
    for (const r of rows) out.add(r.entity_id);
  }
  return out;
}

/** Переименовали группу или реестр — снимок названия его системной цепочки, в той же транзакции. */
export async function renameSystemChain(tx: Db, s: ChainSource) {
  const title = systemChainTitle(s);
  await tx.taskChain.updateMany({
    where: { kind: 'system', sourceType: s.type, sourceId: s.id, deletedAt: null, NOT: { title } },
    data: { title, titleKey: titleKey(title) ?? 'system', version: { increment: 1 } },
  });
}

/**
 * Запись уязвимости перенесли в узел другой группы: её незавершённые задачи из системной цепочки прежней группы — в
 * цепочку новой; выполненные остаются. Задачи без цепочки и в ручных цепочках не трогаются. Журнал — от того, кто перенёс.
 */
export async function followRecordsToGroup(tx: Db, actor: Actor, records: readonly { id: string; number: number }[], group: { id: string; name: string }): Promise<number> {
  if (!records.length) return 0;
  const recNo = new Map(records.map((r) => [r.id, r.number]));
  const tasks = await tx.task.findMany({
    where: {
      recordId: { in: [...recNo.keys()] }, completedAt: null, deletedAt: null,
      chain: { kind: 'system', sourceType: 'vuln_group', deletedAt: null, NOT: { sourceId: group.id } },
    },
    select: { id: true, number: true, recordId: true, chain: { select: { id: true, number: true, title: true } } },
    orderBy: { number: 'asc' },
  });
  if (!tasks.length) return 0;
  const to = await ensureSystemChain(tx, { type: 'vuln_group', id: group.id, name: group.name });
  for (const ids of chunks(tasks.map((t) => t.id), 1000)) {
    await tx.task.updateMany({ where: { id: { in: ids } }, data: { chainId: to.id, version: { increment: 1 } } });
  }
  const toLabel = `«${to.title}» (#${to.number})`;
  await auditSettingsMany(tx, actor, tasks.map((t) => {
    const from = t.chain ? `«${t.chain.title}» (#${t.chain.number})` : '—';
    return {
      action: 'task.chain_moved', entity: 'task', entityId: t.id,
      summary: `Задача #${t.number} перенесена из цепочки ${from} в ${toLabel} автоматически: запись #${recNo.get(t.recordId as string)} перенесена в группу «${group.name}»`,
      after: { fromChainId: t.chain?.id ?? null, toChainId: to.id, via: 'system_transfer', changes: [{ field: 'chainId', label: 'Цепочка', from, to: toLabel }] },
    };
  }));
  return tasks.length;
}
