// Группы и узлы раздела «Уязвимости» (релиз 1.5.0, ADR-0029). Узел = группа × значение справочника «Типы систем».
// «Без группы» — системная группа с узлом «Из прежнего реестра»: её создаёт seed, вручную не создаётся, не
// переименовывается и не получает типов. Удаления групп и узлов нет.
import type { Prisma } from '../../generated/prisma/client.js';
import { isUniqueViolation, withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';

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

/** Группы: сначала обычные по названию, «Без группы» — последней. */
export async function listGroups(db: Db): Promise<GroupDto[]> {
  const rows = await db.vulnGroup.findMany({ include: { nodes: { include: { systemType: true } } } });
  return rows
    .sort((a, b) => Number(a.systemKey !== null) - Number(b.systemKey !== null) || a.name.localeCompare(b.name, 'ru'))
    .map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind as GroupKind,
      kindLabel: KIND_LABELS[g.kind as GroupKind] ?? g.kind,
      system: g.systemKey !== null,
      version: g.version,
      nodes: [...g.nodes].sort(nodeOrder).map(nodeDto),
    }));
}

export async function loadNode(db: Db, nodeId: string) {
  const node = await db.vulnNode.findUnique({ where: { id: nodeId }, include: { systemType: true, group: true } });
  if (!node) throw new AppError(404, 'NOT_FOUND', 'Узел не найден');
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
    SELECT id::text, name FROM vuln_groups WHERE lower(btrim(name)) = lower(btrim(${name}))`;
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
      if (!group) throw notFound('Группа');
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

export async function addNodes(db: Db, actor: Actor, groupId: string, systemTypeIds: string[]): Promise<GroupDto> {
  try {
    await withTx(db, async (tx) => {
      const group = await tx.vulnGroup.findUnique({ where: { id: groupId }, include: { nodes: { include: { systemType: true } } } });
      if (!group) throw notFound('Группа');
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
