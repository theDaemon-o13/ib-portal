// Группы и узлы раздела «Уязвимости» (релиз 1.5.0, ADR-0029). Узел = группа × значение справочника «Типы систем».
// «Без группы» — системная группа с узлом «Из прежнего реестра»: её создаёт seed, вручную не создаётся, не
// переименовывается, не получает типов и не удаляется; пустая (нет неархивных записей) в списке не показывается.
// Удаление группы и узла (1.6.1, ADR-0033) — мягкое, только без открытых записей: событие в корзине, скрываются узлы,
// записи и сканы (сканы — вместе с узлом); продления остаются.
import type { Prisma } from '../../generated/prisma/client.js';
import { isUniqueViolation, withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import type { Values } from '../../lib/register-values.js';
import { isClosed, loadRegister } from '../registers/definition.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';
import { checkConfirmName, checkTextReason, createDeletion } from '../trash/service.js';
import { VULN_REGISTER_KEY } from './definition.js';

export const SYSTEM_TYPES_CATALOG = 'system_types';
export const UNGROUPED_KEY = 'ungrouped';
export const LEGACY_NODE_KEY = 'legacy';
export const GROUP_KINDS = ['service', 'department'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number] | 'temporary';

export const KIND_LABELS: Record<GroupKind, string> = { service: 'Сервис', department: 'Подразделение', temporary: 'Временная' };
export const LEGACY_NODE_LABEL = 'Из прежнего реестра';
const NAME_MAX = 200;

export interface NodeDto {
  id: string;
  groupId: string;
  /** Значение справочника «Типы систем»; у узла «Из прежнего реестра» — null. */
  systemType: { id: string; label: string; archived: boolean } | null;
  label: string;
  legacy: boolean;
}

export interface GroupDto {
  id: string;
  name: string;
  kind: GroupKind;
  kindLabel: string;
  system: boolean;
  /** «Без группы» без неархивных записей (1.6.1): в дереве и на «Все группы» не показывается; узел открывается (архив сканов). */
  hidden: boolean;
  version: number;
  nodes: NodeDto[];
}

type NodeRow = Prisma.VulnNodeGetPayload<{ include: { systemType: true } }>;

function nodeDto(n: NodeRow): NodeDto {
  return {
    id: n.id,
    groupId: n.groupId,
    systemType: n.systemType ? { id: n.systemType.id, label: n.systemType.value, archived: n.systemType.archivedAt !== null } : null,
    label: n.systemType?.value ?? LEGACY_NODE_LABEL,
    legacy: n.systemKey === LEGACY_NODE_KEY,
  };
}

/** Узлы по порядку справочника «Типы систем». */
const nodeOrder = (a: NodeRow, b: NodeRow) => (a.systemType?.sortOrder ?? 0) - (b.systemType?.sortOrder ?? 0) || a.createdAt.getTime() - b.createdAt.getTime();

/** Группы: сначала обычные по названию, «Без группы» — последней; без неархивных записей — с отметкой hidden. */
export async function listGroups(db: Db): Promise<GroupDto[]> {
  const rows = await db.vulnGroup.findMany({ where: { deletedAt: null }, include: { nodes: { where: { deletedAt: null }, include: { systemType: true } } } });
  const ungrouped = rows.find((g) => g.systemKey === UNGROUPED_KEY);
  const hideUngrouped = ungrouped
    ? (await db.vulnRecord.count({ where: { node: { groupId: ungrouped.id }, record: { deletedAt: null, archivedAt: null } } })) === 0
    : false;
  return rows
    .sort((a, b) => Number(a.systemKey !== null) - Number(b.systemKey !== null) || a.name.localeCompare(b.name, 'ru'))
    .map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind as GroupKind,
      kindLabel: KIND_LABELS[g.kind as GroupKind] ?? g.kind,
      system: g.systemKey !== null,
      hidden: hideUngrouped && g.id === ungrouped?.id,
      version: g.version,
      nodes: [...g.nodes].sort(nodeOrder).map(nodeDto),
    }));
}

/** Узел; удалённый (сам или с группой) — 404. «Без группы» открывается и скрытой: архив сканов прежнего реестра. */
export async function loadNode(db: Db, nodeId: string) {
  const node = await db.vulnNode.findUnique({ where: { id: nodeId }, include: { systemType: true, group: true } });
  if (!node || node.deletedAt || node.group.deletedAt) throw new AppError(404, 'NOT_FOUND', 'Узел не найден');
  return node;
}

export const nodeLabel = (n: { group: { name: string }; systemType: { value: string } | null }) =>
  `${n.group.name} / ${n.systemType?.value ?? LEGACY_NODE_LABEL}`;

export async function legacyNode(db: Db) {
  const node = await db.vulnNode.findUnique({ where: { systemKey: LEGACY_NODE_KEY } });
  if (!node) throw conflict('VULN_STRUCTURE', 'Нет узла «Без группы / Из прежнего реестра». Выполните обновление (migrate)');
  return node;
}

function checkName(raw: string): string {
  const name = trimmed(raw);
  if (!name) throw badRequest('BAD_NAME', 'Укажите название группы');
  if (name.length > NAME_MAX) throw badRequest('BAD_NAME', `Название — не длиннее ${NAME_MAX} символов`);
  return name;
}

async function assertNameFree(db: Db, name: string, exceptId?: string) {
  const rows = await db.$queryRaw<{ id: string; name: string }[]>`
    SELECT id::text, name FROM vuln_groups WHERE deleted_at IS NULL AND lower(btrim(name)) = lower(btrim(${name}))`;
  const clash = rows.find((r) => r.id !== exceptId);
  if (clash) throw conflict('GROUP_EXISTS', `Группа «${clash.name}» уже есть`);
}

/** Значения «Типов систем» для узлов: существуют, не в архиве, без повторов; по порядку справочника. */
async function systemTypes(db: Db, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) throw badRequest('TYPES_REQUIRED', 'Отметьте хотя бы один тип систем');
  const items = await db.catalogItem.findMany({ where: { id: { in: unique }, catalogCode: SYSTEM_TYPES_CATALOG, deletedAt: null } });
  const missing = unique.filter((id) => !items.some((i) => i.id === id));
  if (missing.length) throw badRequest('BAD_TYPE', 'Нет такого типа систем в справочнике «Типы систем». Обновите страницу');
  const archived = items.filter((i) => i.archivedAt !== null);
  if (archived.length) throw badRequest('BAD_TYPE', `Тип «${archived[0]?.value}» в архиве справочника`);
  return items.sort((a, b) => a.sortOrder - b.sortOrder || a.value.localeCompare(b.value, 'ru'));
}

export async function createGroup(db: Db, actor: Actor, input: { name: string; kind: string; systemTypeIds: string[] }): Promise<GroupDto> {
  const name = checkName(input.name);
  if (!(GROUP_KINDS as readonly string[]).includes(input.kind)) throw badRequest('BAD_KIND', 'Вид группы — «Сервис» или «Подразделение»');
  try {
    const id = await withTx(db, async (tx) => {
      await assertNameFree(tx, name);
      const types = await systemTypes(tx, input.systemTypeIds);
      const group = await tx.vulnGroup.create({ data: { name, kind: input.kind, createdBy: actor.id } });
      for (const t of types) await tx.vulnNode.create({ data: { groupId: group.id, systemTypeId: t.id, createdBy: actor.id } });
      await auditSettings(tx, actor, {
        action: 'vuln.group.created', entity: 'vuln_group', entityId: group.id,
        summary: `Уязвимости: создана группа «${name}» (${KIND_LABELS[input.kind as GroupKind].toLowerCase()}), типы: ${types.map((t) => `«${t.value}»`).join(', ')}`,
        after: { name, kind: input.kind, systemTypeIds: types.map((t) => t.id) },
      });
      return group.id;
    });
    return (await listGroups(db)).find((g) => g.id === id) as GroupDto;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('GROUP_EXISTS', `Группа «${name}» уже есть`);
    throw err;
  }
}

export async function renameGroup(db: Db, actor: Actor, id: string, input: { name: string; version: number }): Promise<GroupDto> {
  const name = checkName(input.name);
  try {
    await withTx(db, async (tx) => {
      const group = await tx.vulnGroup.findUnique({ where: { id } });
      if (!group || group.deletedAt) throw notFound('Группа');
      if (group.systemKey) throw conflict('SYSTEM_GROUP', `Группа «${group.name}» системная — её не переименовывают`);
      if (group.name === name) return;
      await assertNameFree(tx, name, id);
      const { count } = await tx.vulnGroup.updateMany({ where: { id, version: input.version }, data: { name, version: { increment: 1 } } });
      await ensureVersioned(count, () => tx.vulnGroup.findUnique({ where: { id } }), 'Группа');
      await auditSettings(tx, actor, {
        action: 'vuln.group.renamed', entity: 'vuln_group', entityId: id,
        summary: `Уязвимости: группа «${group.name}» переименована в «${name}»`,
        before: { name: group.name }, after: { name },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('GROUP_EXISTS', `Группа «${name}» уже есть`);
    throw err;
  }
  return (await listGroups(db)).find((g) => g.id === id) as GroupDto;
}

/** Можно ли завести узел «группа × тип»: группа обычная, тип действующий, такого узла нет. */
export async function checkNewNode(db: Db, groupId: string, systemTypeId: string) {
  const group = await db.vulnGroup.findUnique({ where: { id: groupId }, include: { nodes: { where: { deletedAt: null }, select: { systemTypeId: true } } } });
  if (!group || group.deletedAt) throw notFound('Группа');
  if (group.systemKey) throw conflict('SYSTEM_GROUP', `В группу «${group.name}» типы не добавляются`);
  const [type] = await systemTypes(db, [systemTypeId]);
  if (!type) throw badRequest('BAD_TYPE', 'Нет такого типа систем в справочнике «Типы систем». Обновите страницу');
  if (group.nodes.some((n) => n.systemTypeId === type.id)) throw conflict('NODE_EXISTS', `В группе «${group.name}» уже есть тип «${type.value}»`);
  return { group, type };
}

/**
 * «Сменить тип узла»: реестр, сканы и продления остаются у узла, меняется только его тип.
 * fromTypeId — тип, который видел пользователь: у узла нет версии, а типа в чужой группе быть не должно.
 */
export async function changeNodeType(db: Db, actor: Actor, nodeId: string, input: { systemTypeId: string; fromTypeId: string }): Promise<GroupDto> {
  try {
    const groupId = await withTx(db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM vuln_nodes WHERE id = ${nodeId}::uuid FOR UPDATE`;
      const node = await loadNode(tx, nodeId);
      if (node.systemKey) throw conflict('LEGACY_NODE', 'У узла «Из прежнего реестра» типа нет');
      if (node.systemTypeId !== input.fromTypeId) throw versionConflict();
      const { type } = await checkNewNode(tx, node.groupId, input.systemTypeId);
      await tx.vulnNode.update({ where: { id: nodeId }, data: { systemTypeId: type.id } });
      await auditSettings(tx, actor, {
        action: 'vuln.node.type_changed', entity: 'vuln_node', entityId: nodeId,
        summary: `Уязвимости, группа «${node.group.name}»: тип узла «${node.systemType?.value}» заменён на «${type.value}»`,
        before: { systemTypeId: node.systemTypeId, label: node.systemType?.value }, after: { systemTypeId: type.id, label: type.value },
      });
      return node.groupId;
    });
    return (await listGroups(db)).find((g) => g.id === groupId) as GroupDto;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('NODE_EXISTS', 'Такой тип в группе уже есть. Обновите страницу');
    throw err;
  }
}

/** История узла: из журнала аудита, по праву «История в карточках». */
export async function nodeHistory(db: Db, nodeId: string) {
  await loadNode(db, nodeId);
  const rows = await db.auditLog.findMany({ where: { entity: 'vuln_node', entityId: nodeId }, orderBy: { id: 'desc' }, take: 200, include: { user: { select: { fullName: true } } } });
  return rows.map((r) => ({ id: String(r.id), at: r.at.toISOString(), actor: r.user?.fullName ?? 'Система', summary: (r.diff as { summary?: string } | null)?.summary ?? r.action }));
}

export async function addNodes(db: Db, actor: Actor, groupId: string, systemTypeIds: string[]): Promise<GroupDto> {
  try {
    await withTx(db, async (tx) => {
      const group = await tx.vulnGroup.findUnique({ where: { id: groupId }, include: { nodes: { where: { deletedAt: null }, include: { systemType: true } } } });
      if (!group || group.deletedAt) throw notFound('Группа');
      if (group.systemKey) throw conflict('SYSTEM_GROUP', `В группу «${group.name}» типы не добавляются`);
      const types = await systemTypes(tx, systemTypeIds);
      const have = types.filter((t) => group.nodes.some((n) => n.systemTypeId === t.id));
      if (have.length) throw conflict('NODE_EXISTS', `В группе «${group.name}» уже есть тип «${have[0]?.value}»`);
      for (const t of types) await tx.vulnNode.create({ data: { groupId, systemTypeId: t.id, createdBy: actor.id } });
      await auditSettings(tx, actor, {
        action: 'vuln.node.created', entity: 'vuln_group', entityId: groupId,
        summary: `Уязвимости: в группу «${group.name}» добавлены типы ${types.map((t) => `«${t.value}»`).join(', ')}`,
        after: { systemTypeIds: types.map((t) => t.id) },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('NODE_EXISTS', 'Такой тип в группе уже есть. Обновите страницу');
    throw err;
  }
  return (await listGroups(db)).find((g) => g.id === groupId) as GroupDto;
}

// ---------------------------------------------------------------- удаление группы и узла (1.6.1)

export interface NodeDeleteInfo {
  id: string;
  label: string;
  /** Открытые записи: «В работе», «Просрочена», «Не передано ИКТ» (не закрытый статус, не архив). */
  open: number;
  /** Записи, которые скроются: устранённые, с принятым риском и архивные. */
  records: number;
  scans: number;
}

export interface DeletePreview {
  name: string;
  nodes: NodeDeleteInfo[];
  counts: { nodes: number; records: number; scans: number };
  open: number;
  blocked: boolean;
}

async function nodeDeleteInfo(db: Db, nodes: readonly NodeRow[]): Promise<NodeDeleteInfo[]> {
  if (!nodes.length) return [];
  const regRow = await db.register.findUniqueOrThrow({ where: { systemKey: VULN_REGISTER_KEY }, select: { id: true } });
  const reg = await loadRegister(db, regRow.id);
  const ids = nodes.map((n) => n.id);
  const records = await db.vulnRecord.findMany({
    where: { nodeId: { in: ids }, record: { deletedAt: null } },
    select: { nodeId: true, record: { select: { values: true, archivedAt: true } } },
  });
  const scans = await db.vulnScan.groupBy({ by: ['nodeId'], where: { nodeId: { in: ids } }, _count: { _all: true } });
  return [...nodes].sort(nodeOrder).map((n) => {
    const own = records.filter((r) => r.nodeId === n.id);
    return {
      id: n.id,
      label: n.systemType?.value ?? LEGACY_NODE_LABEL,
      open: own.filter((r) => !r.record.archivedAt && !isClosed(reg, r.record.values as Values)).length,
      records: own.length,
      scans: scans.find((s) => s.nodeId === n.id)?._count._all ?? 0,
    };
  });
}

function previewOf(name: string, nodes: NodeDeleteInfo[], countNodes: boolean): DeletePreview {
  const open = nodes.reduce((n, x) => n + x.open, 0);
  return {
    name, nodes, open, blocked: open > 0,
    counts: { nodes: countNodes ? nodes.length : 0, records: nodes.reduce((n, x) => n + x.records, 0), scans: nodes.reduce((n, x) => n + x.scans, 0) },
  };
}

function openRecordsError(where: string, nodes: readonly NodeDeleteInfo[]): AppError {
  const list = nodes.filter((n) => n.open).map((n) => `«${n.label}» — ${n.open}`);
  return new AppError(409, 'OPEN_RECORDS', `${where}: есть открытые записи (${list.join(', ')}). Перенесите их или закройте, затем удалите`, {
    nodes: nodes.filter((n) => n.open).map((n) => ({ id: n.id, label: n.label, open: n.open })),
  });
}

async function liveGroup(db: Db, id: string) {
  const group = await db.vulnGroup.findUnique({ where: { id }, include: { nodes: { where: { deletedAt: null }, include: { systemType: true } } } });
  if (!group || group.deletedAt) throw notFound('Группа');
  if (group.systemKey) throw conflict('SYSTEM_GROUP', `Группа «${group.name}» системная — она не удаляется: на неё опирается обновление портала`);
  return group;
}

export async function previewGroupDelete(db: Db, id: string): Promise<DeletePreview> {
  const group = await liveGroup(db, id);
  return previewOf(group.name, await nodeDeleteInfo(db, group.nodes), true);
}

/** Скрывает записи узлов (неудалённые) этим событием. */
async function hideNodeRecords(tx: Prisma.TransactionClient, nodeIds: readonly string[], deletionId: string, at: Date): Promise<number> {
  const res = await tx.registerRecord.updateMany({
    where: { deletedAt: null, vuln: { nodeId: { in: [...nodeIds] } } },
    data: { deletedAt: at, deletionId, version: { increment: 1 } },
  });
  return res.count;
}

export async function deleteGroup(db: Db, actor: Actor, id: string, input: { reason: string; confirmName: string }) {
  const reason = checkTextReason(input.reason);
  return withTx(db, async (tx) => {
    // Импорт скана блокирует узел — удаление ждёт его окончания и видит итог.
    await tx.$queryRaw`SELECT id FROM vuln_groups WHERE id = ${id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM vuln_nodes WHERE group_id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
    const group = await liveGroup(tx, id);
    checkConfirmName(input.confirmName, group.name, 'группы');
    const p = previewOf(group.name, await nodeDeleteInfo(tx, group.nodes), true);
    if (p.blocked) throw openRecordsError(`В группе «${group.name}»`, p.nodes);
    const deletionId = await createDeletion(tx, actor, { entity: 'vuln_group', entityId: id, title: group.name, reason, counts: p.counts });
    const at = new Date();
    const nodeIds = group.nodes.map((n) => n.id);
    const records = await hideNodeRecords(tx, nodeIds, deletionId, at);
    await tx.vulnNode.updateMany({ where: { id: { in: nodeIds }, deletedAt: null }, data: { deletedAt: at, deletionId } });
    await tx.vulnGroup.update({ where: { id }, data: { deletedAt: at, deletionId, version: { increment: 1 } } });
    await auditSettings(tx, actor, {
      action: 'vuln.group.deleted', entity: 'vuln_group', entityId: id,
      summary: `Уязвимости: удалена группа «${group.name}» — типов ${p.counts.nodes}, записей ${records}, сканов ${p.counts.scans}. Причина: ${reason}`,
      after: { deletionId, reason, counts: { ...p.counts, records } },
    });
    return { deletionId, counts: { ...p.counts, records } };
  });
}

async function liveNode(db: Db, nodeId: string) {
  const node = await loadNode(db, nodeId);
  if (node.systemKey || node.group.systemKey) throw conflict('LEGACY_NODE', '«Без группы / Из прежнего реестра» не удаляется: на него опирается обновление портала');
  return node;
}

export async function previewNodeDelete(db: Db, nodeId: string): Promise<DeletePreview> {
  const node = await liveNode(db, nodeId);
  return previewOf(nodeLabel(node), await nodeDeleteInfo(db, [node]), false);
}

export async function deleteNode(db: Db, actor: Actor, nodeId: string, input: { reason: string }) {
  const reason = checkTextReason(input.reason);
  return withTx(db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM vuln_nodes WHERE id = ${nodeId}::uuid FOR UPDATE`;
    const node = await liveNode(tx, nodeId);
    const label = nodeLabel(node);
    const p = previewOf(label, await nodeDeleteInfo(tx, [node]), false);
    if (p.blocked) throw openRecordsError(`В «${label}»`, p.nodes);
    const deletionId = await createDeletion(tx, actor, { entity: 'vuln_node', entityId: nodeId, title: label, reason, counts: p.counts });
    const at = new Date();
    const records = await hideNodeRecords(tx, [nodeId], deletionId, at);
    await tx.vulnNode.update({ where: { id: nodeId }, data: { deletedAt: at, deletionId } });
    await auditSettings(tx, actor, {
      action: 'vuln.node.deleted', entity: 'vuln_node', entityId: nodeId,
      summary: `Уязвимости: из группы «${node.group.name}» удалён тип «${node.systemType?.value ?? ''}» — записей ${records}, сканов ${p.counts.scans}. Причина: ${reason}`,
      after: { deletionId, reason, groupId: node.groupId, counts: { ...p.counts, records } },
    });
    return { deletionId, counts: { ...p.counts, records } };
  });
}
