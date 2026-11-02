// Мягкое удаление и корзина (релиз 1.6.1, ADR-0033; CLAUDE.md, раздел 3.4).
// Удаление — событие в deletions: что, кто, когда, причина, сколько скрыто. Всё скрытое удалением ссылается на него
// через deletion_id и восстанавливается вместе с ним; удалённое раньше и отдельно остаётся удалённым.
// Событие не меняется (триггер), кроме однократной отметки о восстановлении. Физического удаления нет.
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { formatDateRu, type Values } from '../../lib/register-values.js';
import { calendarFor, dateOf, isClosed, loadRegister, type RegisterDef } from '../registers/definition.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { isVulnRegister, VULN_REGISTER_KEY, vulnFields } from '../vulns/definition.js';
import { keyNorm } from '../vulns/keys.js';

export const DELETION_ENTITIES = ['register', 'vuln_group', 'vuln_node', 'register_records'] as const;
export type DeletionEntity = (typeof DELETION_ENTITIES)[number];

export const ENTITY_LABELS: Record<DeletionEntity, string> = {
  register: 'Реестр',
  vuln_group: 'Группа уязвимостей',
  vuln_node: 'Тип систем в группе',
  register_records: 'Записи реестра',
};

export const RECORD_REASONS = ['wrong_import', 'false_positive', 'duplicate', 'other'] as const;
export type RecordReasonCode = (typeof RECORD_REASONS)[number];
export const REASON_LABELS: Record<RecordReasonCode, string> = {
  wrong_import: 'Ошибочный импорт',
  false_positive: 'Ложное срабатывание',
  duplicate: 'Дубль',
  other: 'Другое',
};

const REASON_MAX = 2000;

export interface RecordReason {
  reasonCode: RecordReasonCode;
  reason?: string | null;
}

/** Причина удаления записей: из списка; «Ложное срабатывание» — только у уязвимостей; «Другое» — с текстом. */
export function checkRecordReason(input: RecordReason, vuln: boolean): { reasonCode: RecordReasonCode; reason: string } {
  const reason = trimmed(input.reason ?? '');
  if (!(RECORD_REASONS as readonly string[]).includes(input.reasonCode)) throw badRequest('BAD_REASON', 'Выберите причину удаления');
  if (input.reasonCode === 'false_positive' && !vuln) throw badRequest('BAD_REASON', '«Ложное срабатывание» — причина только для уязвимостей');
  if (input.reasonCode === 'other' && !reason) throw badRequest('REASON_REQUIRED', 'Опишите причину удаления');
  if (reason.length > REASON_MAX) throw badRequest('BAD_REASON', `Причина — не длиннее ${REASON_MAX} символов`);
  return { reasonCode: input.reasonCode, reason };
}

/** Причина удаления реестра, группы, узла — текстом, обязательно. */
export function checkTextReason(raw: string): string {
  const reason = trimmed(raw);
  if (!reason) throw badRequest('REASON_REQUIRED', 'Укажите причину удаления');
  if (reason.length > REASON_MAX) throw badRequest('BAD_REASON', `Причина — не длиннее ${REASON_MAX} символов`);
  return reason;
}

/** Подтверждение вводом названия (реестр, группа): без учёта регистра и крайних пробелов. */
export function checkConfirmName(confirm: string, name: string, what: string): void {
  if (trimmed(confirm).toLowerCase() !== trimmed(name).toLowerCase()) {
    throw conflict('CONFIRM_NAME', `Название ${what} введено неверно — ничего не удалено`);
  }
}

export const reasonText = (code: string | null, reason: string) => {
  const label = code ? REASON_LABELS[code as RecordReasonCode] ?? code : '';
  return [label, reason].filter(Boolean).join(': ');
};

// ---------------------------------------------------------------- снимок записей уязвимостей

export interface VulnSnapshotItem {
  recordId: string;
  number: number;
  nodeId: string | null;
  /** «Пакет · Идентификатор». */
  title: string;
  status: string;
  /** Открыта на момент удаления: «В работе», «Просрочена», «Не передано ИКТ». */
  open: boolean;
  /** Итоговый срок на момент удаления. */
  due: string | null;
}

/** Статус и итоговый срок записей уязвимостей на момент удаления — для корзины, журнала и сверки 5.3. */
export async function vulnSnapshot(db: Db, reg: RegisterDef, rows: readonly { id: string; number: number; values: unknown }[]): Promise<VulnSnapshotItem[]> {
  if (!rows.length || !isVulnRegister(reg)) return [];
  const vf = vulnFields(reg);
  const calendar = await calendarFor(db, reg);
  const nodes = new Map((await db.vulnRecord.findMany({ where: { recordId: { in: rows.map((r) => r.id) } }, select: { recordId: true, nodeId: true } }))
    .map((v) => [v.recordId, v.nodeId]));
  return rows.map((r) => {
    const values = (r.values ?? {}) as Values;
    const pkg = vf.pkg.options.find((o) => o.id === values[vf.pkg.id])?.label ?? '';
    const cve = typeof values[vf.cve.id] === 'string' ? (values[vf.cve.id] as string) : '';
    return {
      recordId: r.id,
      number: r.number,
      nodeId: nodes.get(r.id) ?? null,
      title: [pkg.trim(), cve.trim()].filter(Boolean).join(' · ') || `#${r.number}`,
      status: vf.status.options.find((o) => o.id === values[vf.status.id])?.label ?? '',
      open: !isClosed(reg, values),
      due: dateOf(reg, vf.due, values, calendar),
    };
  });
}

// ---------------------------------------------------------------- событие

export interface DeletionInput {
  entity: DeletionEntity;
  entityId: string;
  title: string;
  reasonCode?: RecordReasonCode | null;
  reason: string;
  counts: Record<string, number>;
  snapshot?: VulnSnapshotItem[];
}

export async function createDeletion(tx: Db, actor: Actor, input: DeletionInput): Promise<string> {
  const row = await tx.deletion.create({
    data: {
      entity: input.entity, entityId: input.entityId, title: input.title.slice(0, 500), reasonCode: input.reasonCode ?? null, reason: input.reason,
      counts: input.counts as Prisma.InputJsonValue, snapshot: (input.snapshot ?? []) as unknown as Prisma.InputJsonValue, deletedBy: actor.id,
    },
  });
  return row.id;
}

// ---------------------------------------------------------------- корзина

export interface TrashQuery {
  entity?: DeletionEntity;
  /** Только события раздела «Уязвимости»: группы, узлы, записи уязвимостей. */
  scope?: 'vulns';
  nodeId?: string;
  groupId?: string;
  restored?: boolean;
  limit?: number;
  cursor?: string;
}

async function vulnRegisterId(db: Db): Promise<string | null> {
  return (await db.register.findUnique({ where: { systemKey: VULN_REGISTER_KEY }, select: { id: true } }))?.id ?? null;
}

/** Узлы группы (и удалённые: записи могли удалить до удаления узла). */
async function groupNodeIds(db: Db, groupId: string): Promise<string[]> {
  return (await db.vulnNode.findMany({ where: { groupId }, select: { id: true } })).map((n) => n.id);
}

const snapshotOf = (v: unknown) => (Array.isArray(v) ? (v as VulnSnapshotItem[]) : []);

export async function listDeletions(db: Db, q: TrashQuery) {
  const limit = Math.min(q.limit ?? 50, 200);
  const vulnReg = await vulnRegisterId(db);
  const where: Prisma.DeletionWhereInput[] = [];
  if (q.entity) where.push({ entity: q.entity });
  if (q.restored !== undefined) where.push({ restoredAt: q.restored ? { not: null } : null });
  const nodeIds = q.nodeId ? [q.nodeId] : q.groupId ? await groupNodeIds(db, q.groupId) : null;
  if (q.scope === 'vulns' || nodeIds) {
    where.push({
      OR: [
        ...(nodeIds ? [] : [{ entity: 'vuln_group' }]),
        ...(q.groupId ? [{ entity: 'vuln_group', entityId: q.groupId }] : []),
        { entity: 'vuln_node', ...(nodeIds ? { entityId: { in: nodeIds } } : {}) },
        ...(vulnReg ? [{ entity: 'register_records', entityId: vulnReg }] : []),
      ],
    });
  }
  const rows = await db.deletion.findMany({
    where: { AND: where },
    include: { deleter: { select: { fullName: true } }, restorer: { select: { fullName: true } } },
    orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    take: limit + 1,
  });
  // Записи уязвимостей узла или группы: событие — если в его снимке есть записи этих узлов.
  const filtered = nodeIds
    ? rows.filter((r) => r.entity !== 'register_records' || snapshotOf(r.snapshot).some((i) => i.nodeId && nodeIds.includes(i.nodeId)))
    : rows;
  const page = filtered.slice(0, limit);
  const items = [];
  for (const r of page) items.push(await deletionDto(db, r, vulnReg));
  return { items, nextCursor: rows.length > limit ? rows[limit - 1]?.id ?? null : null };
}

type DeletionRow = Prisma.DeletionGetPayload<{ include: { deleter: { select: { fullName: true } }; restorer: { select: { fullName: true } } } }>;

const ITEMS_SHOWN = 20;

async function deletionDto(db: Db, r: DeletionRow, vulnReg: string | null) {
  const snapshot = snapshotOf(r.snapshot);
  let path = '';
  let items: { number: number; title: string; status: string | null; open: boolean | null; due: string | null }[] = [];
  if (r.entity === 'vuln_node') {
    const node = await db.vulnNode.findUnique({ where: { id: r.entityId }, include: { group: true } });
    path = node ? `Группа «${node.group.name}»` : '';
  }
  if (r.entity === 'register_records') {
    if (snapshot.length) {
      items = snapshot.slice(0, ITEMS_SHOWN).map((i) => ({ number: i.number, title: i.title, status: i.status, open: i.open, due: i.due }));
    } else {
      const reg = await db.register.findUnique({ where: { id: r.entityId }, include: { fields: { where: { isTitle: true, deletedAt: null }, select: { id: true } } } });
      const titleId = reg?.fields[0]?.id;
      const recs = await db.registerRecord.findMany({ where: { deletionId: r.id }, select: { number: true, values: true }, orderBy: { number: 'asc' }, take: ITEMS_SHOWN });
      items = recs.map((x) => {
        const t = titleId ? (x.values as Values)[titleId] : undefined;
        return { number: x.number, title: typeof t === 'string' ? t : '', status: null, open: null, due: null };
      });
    }
  }
  return {
    id: r.id,
    entity: r.entity as DeletionEntity,
    entityLabel: ENTITY_LABELS[r.entity as DeletionEntity] ?? r.entity,
    entityId: r.entityId,
    vulns: r.entity === 'vuln_group' || r.entity === 'vuln_node' || (r.entity === 'register_records' && r.entityId === vulnReg),
    title: r.title,
    path,
    reasonCode: r.reasonCode,
    reasonLabel: r.reasonCode ? REASON_LABELS[r.reasonCode as RecordReasonCode] ?? r.reasonCode : null,
    reason: r.reason,
    counts: r.counts as Record<string, number>,
    openRecords: snapshot.filter((i) => i.open).length,
    items,
    deletedAt: r.deletedAt.toISOString(),
    deletedBy: r.deleter.fullName,
    restoredAt: r.restoredAt?.toISOString() ?? null,
    restoredBy: r.restorer?.fullName ?? null,
  };
}

// ---------------------------------------------------------------- восстановление

/** Ключ записи уязвимости из её значений: «Пакет + Идентификатор»; нет одного из них — ключа нет. */
export function vulnKeyOf(reg: RegisterDef, values: Values): string | null {
  const vf = vulnFields(reg);
  const pkg = vf.pkg.options.find((o) => o.id === values[vf.pkg.id])?.label;
  const cve = values[vf.cve.id];
  return pkg?.trim() && typeof cve === 'string' && cve.trim() ? keyNorm(pkg, cve) : null;
}

async function restoreRecords(tx: Prisma.TransactionClient, deletionId: string) {
  // Ключ импорта уникален среди неудалённых: занят новой записью — восстановить нельзя.
  const taken = await tx.$queryRaw<{ number: number; other: number }[]>`
    SELECT d.number, r.number AS other FROM register_records d
    JOIN register_records r ON r.register_id = d.register_id AND r.import_key = d.import_key AND r.deleted_at IS NULL
    WHERE d.deletion_id = ${deletionId}::uuid AND d.import_key IS NOT NULL
    ORDER BY d.number LIMIT 10`;
  if (taken.length) {
    throw conflict('KEY_TAKEN', `Ключ записей уже занят другими записями: ${taken.map((t) => `#${t.number} — у #${t.other}`).join(', ')}. Удалите или измените их и повторите`);
  }
  const res = await tx.registerRecord.updateMany({ where: { deletionId }, data: { deletedAt: null, deletionId: null, version: { increment: 1 } } });
  return res.count;
}

/** Записи уязвимостей, освободившие ключ при удалении (одиночном или массовом), получают его обратно — если он свободен. */
async function restoreVulnKeys(tx: Prisma.TransactionClient, reg: RegisterDef, deletionId: string) {
  const rows = await tx.registerRecord.findMany({ where: { deletionId }, select: { id: true, number: true, values: true, vuln: { select: { nodeId: true, keyNorm: true } } } });
  const clashes: string[] = [];
  const plan: { id: string; key: string }[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.vuln || r.vuln.keyNorm) continue;
    const node = await tx.vulnNode.findUnique({ where: { id: r.vuln.nodeId }, include: { group: true, systemType: true } });
    if (node?.deletedAt) throw conflict('PARENT_DELETED', `Тип «${node.systemType?.value ?? ''}» группы «${node.group.name}» удалён — сначала восстановите его`);
    if (node?.systemKey) continue; // «Без группы»: ключей нет
    const key = vulnKeyOf(reg, r.values as Values);
    if (!key) continue;
    const scoped = `${r.vuln.nodeId}\u001f${key}`;
    const other = await tx.vulnRecord.findFirst({ where: { nodeId: r.vuln.nodeId, keyNorm: key }, select: { record: { select: { number: true } } } });
    if (other || seen.has(scoped)) clashes.push(`#${r.number} — в узле уже есть #${other?.record.number ?? seen.get(scoped)}`);
    seen.set(scoped, r.number);
    plan.push({ id: r.id, key });
  }
  if (clashes.length) {
    throw conflict('KEY_TAKEN', `Уязвимость снова пришла в скане и заведена новой записью: ${clashes.slice(0, 10).join(', ')}. Удалите новую запись или оставьте прежнюю в корзине`);
  }
  for (const p of plan) await tx.vulnRecord.update({ where: { recordId: p.id }, data: { keyNorm: p.key, version: { increment: 1 } } });
}

async function vulnDef(tx: Prisma.TransactionClient): Promise<RegisterDef> {
  const row = await tx.register.findUniqueOrThrow({ where: { systemKey: VULN_REGISTER_KEY }, select: { id: true } });
  return loadRegister(tx, row.id);
}

async function nameTaken(tx: Prisma.TransactionClient, entity: 'register' | 'vuln_group', name: string, exceptId: string): Promise<boolean> {
  if (entity === 'register') {
    return !!(await tx.register.findFirst({ where: { id: { not: exceptId }, archivedAt: null, deletedAt: null, name: { equals: name, mode: 'insensitive' } } }));
  }
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM vuln_groups WHERE deleted_at IS NULL AND id <> ${exceptId}::uuid AND lower(btrim(name)) = lower(btrim(${name}))`;
  return rows.length > 0;
}

/** Новое название при восстановлении: имя занято — вводится другое (проверка как при создании). */
async function freeNameFor(tx: Prisma.TransactionClient, entity: 'register' | 'vuln_group', current: string, id: string, newName: string | null | undefined): Promise<string> {
  const what = entity === 'register' ? 'Реестр' : 'Группа';
  const wanted = trimmed(newName ?? '') || current;
  if (wanted.length > 200) throw badRequest('BAD_NAME', 'Название — не длиннее 200 символов');
  if (await nameTaken(tx, entity, wanted, id)) {
    throw new AppError(409, 'NAME_TAKEN', `${what} «${wanted}» уже есть — укажите другое название для восстановления`, { name: wanted });
  }
  return wanted;
}

export async function restoreDeletion(db: Db, actor: Actor, id: string, input: { newName?: string | null } = {}) {
  return withTx(db, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM deletions WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound('Удаление');
    const d = await tx.deletion.findUniqueOrThrow({ where: { id } });
    if (d.restoredAt) throw conflict('ALREADY_RESTORED', 'Уже восстановлено');
    const counts: Record<string, number> = {};
    let summary = '';
    let entity = '';
    let entityId: string | null = d.entityId;

    if (d.entity === 'register') {
      const reg = await tx.register.findUnique({ where: { id: d.entityId } });
      if (!reg || reg.deletionId !== d.id) throw conflict('NOT_RESTORABLE', 'Реестр уже не в корзине');
      const name = await freeNameFor(tx, 'register', reg.name, reg.id, input.newName);
      await tx.register.update({ where: { id: reg.id }, data: { name, deletedAt: null, deletionId: null, version: { increment: 1 } } });
      counts.records = await restoreRecords(tx, d.id);
      counts.automations = (await tx.registerAutomation.updateMany({ where: { deletionId: d.id }, data: { deletedAt: null, deletionId: null, version: { increment: 1 } } })).count;
      entity = 'register';
      summary = `Восстановлен реестр «${name}»${name !== reg.name ? ` (прежнее название «${reg.name}»)` : ''}: записей ${counts.records}, автоматизаций ${counts.automations}`;
    } else if (d.entity === 'vuln_group') {
      const group = await tx.vulnGroup.findUnique({ where: { id: d.entityId } });
      if (!group || group.deletionId !== d.id) throw conflict('NOT_RESTORABLE', 'Группа уже не в корзине');
      const name = await freeNameFor(tx, 'vuln_group', group.name, group.id, input.newName);
      await tx.vulnGroup.update({ where: { id: group.id }, data: { name, deletedAt: null, deletionId: null, version: { increment: 1 } } });
      counts.nodes = (await tx.vulnNode.updateMany({ where: { deletionId: d.id }, data: { deletedAt: null, deletionId: null } })).count;
      await restoreVulnKeys(tx, await vulnDef(tx), d.id);
      counts.records = await restoreRecords(tx, d.id);
      entity = 'vuln_group';
      summary = `Уязвимости: восстановлена группа «${name}»${name !== group.name ? ` (прежнее название «${group.name}»)` : ''}: типов ${counts.nodes}, записей ${counts.records}`;
    } else if (d.entity === 'vuln_node') {
      const node = await tx.vulnNode.findUnique({ where: { id: d.entityId }, include: { group: true, systemType: true } });
      if (!node || node.deletionId !== d.id) throw conflict('NOT_RESTORABLE', 'Тип уже не в корзине');
      if (node.group.deletedAt) throw conflict('PARENT_DELETED', `Группа «${node.group.name}» удалена — сначала восстановите её`);
      const twin = await tx.vulnNode.findFirst({ where: { groupId: node.groupId, systemTypeId: node.systemTypeId, deletedAt: null, id: { not: node.id } } });
      if (twin) throw conflict('NODE_EXISTS', `В группе «${node.group.name}» тип «${node.systemType?.value ?? ''}» добавлен заново — восстановить прежний нельзя`);
      await tx.vulnNode.update({ where: { id: node.id }, data: { deletedAt: null, deletionId: null } });
      await restoreVulnKeys(tx, await vulnDef(tx), d.id);
      counts.records = await restoreRecords(tx, d.id);
      entity = 'vuln_node';
      summary = `Уязвимости: в группе «${node.group.name}» восстановлен тип «${node.systemType?.value ?? ''}»: записей ${counts.records}`;
    } else {
      const reg = await tx.register.findUnique({ where: { id: d.entityId } });
      if (!reg) throw notFound('Реестр');
      if (reg.deletedAt) throw conflict('PARENT_DELETED', `Реестр «${reg.name}» удалён — сначала восстановите его`);
      const def = await loadRegister(tx, reg.id);
      if (isVulnRegister(def)) await restoreVulnKeys(tx, def, d.id);
      const restored = await tx.registerRecord.findMany({ where: { deletionId: d.id }, select: { id: true, number: true } });
      counts.records = await restoreRecords(tx, d.id);
      for (const r of restored) {
        await auditSettings(tx, actor, {
          action: 'register_record.undeleted', entity: 'register_record', entityId: r.id,
          summary: `«${reg.name}»: запись #${r.number} восстановлена из корзины (удалена ${formatDateRu(d.deletedAt.toISOString().slice(0, 10))}, ${reasonText(d.reasonCode, d.reason)})`,
          after: { deletionId: d.id },
        });
      }
      entity = 'register';
      entityId = reg.id;
      summary = `«${reg.name}»: из корзины восстановлено записей ${counts.records}`;
    }
    await tx.deletion.update({ where: { id: d.id }, data: { restoredAt: new Date(), restoredBy: actor.id } });
    await auditSettings(tx, actor, {
      action: 'deletion.restored', entity, entityId,
      summary,
      after: { deletionId: d.id, deletedEntity: d.entity, counts },
    });
    return { id: d.id, counts };
  });
}

// ---------------------------------------------------------------- прозрачность: удалённые записи уязвимостей

export interface DeletionStats {
  total: number;
  open: number;
  byReason: { code: string; label: string; count: number }[];
}

/** «Удалено записей» за период: узел, группа или весь раздел; восстановленные не считаются. */
export async function vulnDeletionStats(db: Db, scope: { nodeId?: string; groupId?: string }, from: Date, to: Date): Promise<DeletionStats> {
  const vulnReg = await vulnRegisterId(db);
  if (!vulnReg) return { total: 0, open: 0, byReason: [] };
  const nodeIds = scope.nodeId ? [scope.nodeId] : scope.groupId ? await groupNodeIds(db, scope.groupId) : null;
  const rows = await db.deletion.findMany({
    where: { entity: 'register_records', entityId: vulnReg, restoredAt: null, deletedAt: { gte: from, lte: to } },
    select: { reasonCode: true, snapshot: true },
  });
  const byReason = new Map<string, number>();
  let total = 0;
  let open = 0;
  for (const r of rows) {
    const items = snapshotOf(r.snapshot).filter((i) => !nodeIds || (i.nodeId && nodeIds.includes(i.nodeId)));
    if (!items.length) continue;
    total += items.length;
    open += items.filter((i) => i.open).length;
    const code = r.reasonCode ?? 'other';
    byReason.set(code, (byReason.get(code) ?? 0) + items.length);
  }
  return {
    total, open,
    byReason: RECORD_REASONS.filter((c) => byReason.has(c)).map((c) => ({ code: c, label: REASON_LABELS[c], count: byReason.get(c) ?? 0 })),
  };
}

export interface DeletedVuln extends VulnSnapshotItem {
  deletionId: string;
  deletedAt: string;
  deletedBy: string;
  reason: string;
}

/** Записи уязвимостей, удалённые с даты since (не восстановленные): сверка 5.3. */
export async function deletedVulns(db: Db, since: Date): Promise<DeletedVuln[]> {
  const vulnReg = await vulnRegisterId(db);
  if (!vulnReg) return [];
  const rows = await db.deletion.findMany({
    where: { entity: 'register_records', entityId: vulnReg, restoredAt: null, deletedAt: { gte: since } },
    include: { deleter: { select: { fullName: true } } },
    orderBy: { deletedAt: 'desc' },
  });
  return rows.flatMap((r) => snapshotOf(r.snapshot).map((i) => ({
    ...i, deletionId: r.id, deletedAt: r.deletedAt.toISOString(), deletedBy: r.deleter.fullName, reason: reasonText(r.reasonCode, r.reason),
  })));
}
