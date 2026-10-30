// Продления сроков по обоснованию ОИКТ (релиз 1.5.0, ADR-0030; CLAUDE.md, раздел 7, правило 14). Право vulns.deadlines.
// Процедуру не меняют: дни — по Уровню сканера, только продление. Участвуют открытые записи с идущим сроком; с решением
// п. 7.3 и не переданные ИКТ не участвуют (показывается сколько). «Продлено, дн.» = сумма действующих продлений цикла.
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { calcValue, formatDateRu, isIsoDate, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { parseIsoDate } from '../../lib/working-days.js';
import { claimFiles } from '../files/links.js';
import { calendarFor, dateOf, isClosed, loadRegister, loadUsers, searchTextOf, type RegisterDef } from '../registers/definition.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { VULN_REGISTER_KEY, vulnFields, type VulnFields } from './definition.js';
import { LEGACY_NODE_LABEL, nodeLabel } from './groups.service.js';

export const NO_LEVEL = 'none';
const NO_LEVEL_LABEL = 'Без уровня';
const MAX_DAYS = 365;
const NUMBER_MAX = 100;
const COMMENT_MAX = 2000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface ExtensionScope {
  nodeId?: string | null;
  groupId?: string | null;
}

export interface ExtensionPlanInput extends ExtensionScope {
  /** Дни по Уровню: id значения «Уровень» или "none». */
  daysByLevel: Record<string, number>;
  onlyOverdue?: boolean;
  dueUntil?: string | null;
}

export interface ExtensionPreview {
  scopeLabel: string;
  /** Уровни области: и те, по которым дней не задано, — для формы. */
  levels: { id: string; label: string; count: number }[];
  items: { recordId: string; number: number; pkg: string; cve: string; level: string; crit: string; days: number; dueBefore: string; dueAfter: string }[];
  /** Не участвуют: решение п. 7.3, не передано ИКТ. */
  withDecision: number;
  notHandedOver: number;
  /** Подходят, но не прошли фильтр. */
  filteredOut: number;
  /** Подходят, но окончание после переноса с выходного не меняется. */
  noChange: number;
}

interface Candidate {
  id: string;
  number: number;
  version: number;
  values: Values;
  cycle: number;
}

async function vulnDef(db: Db): Promise<{ reg: RegisterDef; vf: VulnFields }> {
  const row = await db.register.findUniqueOrThrow({ where: { systemKey: VULN_REGISTER_KEY } });
  const reg = await loadRegister(db, row.id);
  return { reg, vf: vulnFields(reg) };
}

/** Область: один узел или все узлы группы. */
async function scopeOf(db: Db, input: ExtensionScope): Promise<{ nodeIds: string[]; label: string; nodeId: string | null; groupId: string | null }> {
  if (!input.nodeId === !input.groupId) throw badRequest('BAD_SCOPE', 'Выберите область: узел или группу');
  if (input.nodeId) {
    const node = await db.vulnNode.findUnique({ where: { id: input.nodeId }, include: { group: true, systemType: true } });
    if (!node) throw notFound('Узел');
    return { nodeIds: [node.id], label: nodeLabel(node), nodeId: node.id, groupId: null };
  }
  const group = await db.vulnGroup.findUnique({ where: { id: input.groupId as string }, include: { nodes: true } });
  if (!group) throw notFound('Группа');
  return { nodeIds: group.nodes.map((n) => n.id), label: `${group.name} (все узлы)`, nodeId: null, groupId: group.id };
}

function checkPlan(input: ExtensionPlanInput) {
  for (const [level, days] of Object.entries(input.daysByLevel)) {
    if (!Number.isInteger(days) || days < 0 || days > MAX_DAYS) throw badRequest('BAD_DAYS', `Дни — целое число от 0 до ${MAX_DAYS}`);
    if (level !== NO_LEVEL && !level) throw badRequest('BAD_DAYS', 'Уровень не указан');
  }
  if (input.dueUntil && !isIsoDate(input.dueUntil)) throw badRequest('BAD_DATE', '«Только со сроком до»: неверная дата');
}

const addDaysValue = (vf: VulnFields, values: Values, days: number): Values => {
  const extra = values[vf.extDays.id];
  return { ...values, [vf.extDays.id]: (typeof extra === 'number' ? extra : 0) + days };
};

async function plan(db: Db, reg: RegisterDef, vf: VulnFields, input: ExtensionPlanInput, rows: Candidate[], label: string): Promise<ExtensionPreview> {
  const calendar = await calendarFor(db, reg);
  const today = todayIso();
  const counts = new Map<string, number>();
  const out: ExtensionPreview = { scopeLabel: label, levels: [], items: [], withDecision: 0, notHandedOver: 0, filteredOut: 0, noChange: 0 };
  const rule = vf.due.calcRule;
  const levelOf = (values: Values) => {
    const id = values[vf.level.id];
    return typeof id === 'string' && vf.level.options.some((o) => o.id === id) ? id : NO_LEVEL;
  };
  const labelOf = (id: string) => (id === NO_LEVEL ? NO_LEVEL_LABEL : vf.level.options.find((o) => o.id === id)?.label ?? '');
  for (const r of rows) {
    if (isClosed(reg, r.values)) continue;
    const measures = r.values[vf.measures.id];
    if (typeof measures === 'string' && measures && typeof r.values[vf.newDue.id] === 'string') {
      out.withDecision++;
      continue;
    }
    const due = dateOf(reg, vf.due, r.values, calendar);
    if (due === null) {
      out.notHandedOver++;
      continue;
    }
    const level = levelOf(r.values);
    counts.set(level, (counts.get(level) ?? 0) + 1);
    if ((input.onlyOverdue && due >= today) || (input.dueUntil && due > input.dueUntil)) {
      out.filteredOut++;
      continue;
    }
    const days = input.daysByLevel[level] ?? 0;
    if (!days) continue;
    const after = rule ? calcValue(rule, addDaysValue(vf, r.values, days), { fields: reg.fields, calendar }) : null;
    if (typeof after !== 'string' || after <= due) {
      out.noChange++;
      continue;
    }
    const cve = r.values[vf.cve.id];
    out.items.push({
      recordId: r.id, number: r.number,
      pkg: vf.pkg.options.find((o) => o.id === r.values[vf.pkg.id])?.label ?? '',
      cve: typeof cve === 'string' ? cve : '',
      level: labelOf(level),
      crit: vf.crit.options.find((o) => o.id === r.values[vf.crit.id])?.label ?? '',
      days, dueBefore: due, dueAfter: after,
    });
  }
  out.levels = [...counts.entries()]
    .map(([id, count]) => ({ id, label: labelOf(id), count }))
    .sort((a, b) => (a.id === NO_LEVEL ? 1 : b.id === NO_LEVEL ? -1 : (vf.level.options.findIndex((o) => o.id === a.id) - vf.level.options.findIndex((o) => o.id === b.id))));
  return out;
}

async function candidates(db: Db, nodeIds: string[]): Promise<Candidate[]> {
  return db.$queryRaw<Candidate[]>`
    SELECT r.id::text, r.number, r.version, r."values", v.cycle
    FROM vuln_records v JOIN register_records r ON r.id = v.record_id
    WHERE v.node_id = ANY(${nodeIds}::uuid[]) AND r.deleted_at IS NULL AND r.archived_at IS NULL
    ORDER BY r.number`;
}

export async function previewExtension(db: Db, input: ExtensionPlanInput): Promise<ExtensionPreview> {
  checkPlan(input);
  const scope = await scopeOf(db, input);
  const { reg, vf } = await vulnDef(db);
  return plan(db, reg, vf, input, await candidates(db, scope.nodeIds), scope.label);
}

export interface ExtensionApplyInput extends ExtensionPlanInput {
  basisNumber: string;
  basisDate: string;
  basisFileId: string;
  comment?: string | null;
  /** Число записей из предпросмотра: разошлось — 409 BULK_CHANGED (ADR-0016). */
  expected: number;
}

export async function applyExtension(db: Db, actor: Actor, input: ExtensionApplyInput) {
  checkPlan(input);
  const basisNumber = trimmed(input.basisNumber);
  if (!basisNumber || basisNumber.length > NUMBER_MAX) throw badRequest('BASIS_REQUIRED', `Номер обращения ОИКТ обязателен, не длиннее ${NUMBER_MAX} символов`);
  if (!isIsoDate(input.basisDate) || input.basisDate > todayIso()) throw badRequest('BAD_DATE', 'Дата обращения ОИКТ: неверная или ещё не наступила');
  const comment = (input.comment ?? '').trim();
  if (comment.length > COMMENT_MAX) throw badRequest('BAD_COMMENT', `Комментарий — не длиннее ${COMMENT_MAX} символов`);
  return withTx(db, async (tx) => {
    const scope = await scopeOf(tx, input);
    await claimFiles(tx, actor.id, [input.basisFileId], { what: 'Обоснование ОИКТ' });
    const { reg, vf } = await vulnDef(tx);
    await tx.$queryRaw`
      SELECT r.id FROM vuln_records v JOIN register_records r ON r.id = v.record_id
      WHERE v.node_id = ANY(${scope.nodeIds}::uuid[]) AND r.deleted_at IS NULL AND r.archived_at IS NULL FOR UPDATE OF r`;
    const rows = await candidates(tx, scope.nodeIds);
    const p = await plan(tx, reg, vf, input, rows, scope.label);
    if (p.items.length !== input.expected) {
      throw new AppError(409, 'BULK_CHANGED', 'Записи изменились после предпросмотра — проверьте числа и подтвердите ещё раз', { preview: { total: p.items.length } });
    }
    if (!p.items.length) throw badRequest('NOTHING_TO_EXTEND', 'Нет записей для продления: задайте дни или измените фильтры');
    const ext = await tx.vulnExtension.create({
      data: {
        nodeId: scope.nodeId, groupId: scope.groupId, daysByLevel: input.daysByLevel,
        filters: { onlyOverdue: !!input.onlyOverdue, dueUntil: input.dueUntil ?? null },
        basisNumber, basisDate: parseIsoDate(input.basisDate), basisFileId: input.basisFileId, comment, recordsCount: p.items.length, createdBy: actor.id,
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const users = await loadUsers(tx);
    const basis = `по обоснованию ОИКТ № ${basisNumber} от ${formatDateRu(input.basisDate)}`;
    await tx.vulnExtensionItem.createMany({
      data: p.items.map((i) => ({
        extensionId: ext.id, recordId: i.recordId, cycle: (byId.get(i.recordId) as Candidate).cycle, days: i.days,
        dueBefore: parseIsoDate(i.dueBefore), dueAfter: parseIsoDate(i.dueAfter),
      })),
    });
    for (const i of p.items) {
      const r = byId.get(i.recordId) as Candidate;
      const values = addDaysValue(vf, r.values, i.days);
      await tx.registerRecord.update({
        where: { id: r.id },
        data: { values: values as Prisma.InputJsonValue, searchText: searchTextOf(reg, r.number, values, users), version: { increment: 1 } },
      });
      await auditSettings(tx, actor, {
        action: 'register_record.updated', entity: 'register_record', entityId: r.id,
        summary: `«${reg.name}», запись #${r.number}: срок продлён на ${i.days} дн. (${formatDateRu(i.dueBefore)} → ${formatDateRu(i.dueAfter)}) ${basis}`,
        after: {
          changes: [{ fieldId: vf.due.id, label: vf.due.label, from: formatDateRu(i.dueBefore), to: formatDateRu(i.dueAfter) }],
          via: 'extension', extensionId: ext.id, days: i.days,
        },
      });
    }
    await auditSettings(tx, actor, {
      action: 'vuln.extension.applied', entity: 'vuln_extension', entityId: ext.id,
      summary: `Уязвимости, «${scope.label}»: сроки продлены ${basis} — записей ${p.items.length}`,
      after: { daysByLevel: input.daysByLevel, onlyOverdue: !!input.onlyOverdue, dueUntil: input.dueUntil ?? null, basisNumber, basisDate: input.basisDate, fileId: input.basisFileId, records: p.items.length },
    });
    return { id: ext.id, records: p.items.length, registerId: reg.id };
  });
}

/** Отмена — целиком. Сроки возвращаются только у записей в том же цикле: повторно обнаруженной запись продление уже не касается. */
export async function cancelExtension(db: Db, actor: Actor, id: string) {
  return withTx(db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM vuln_extensions WHERE id = ${id}::uuid FOR UPDATE`;
    const ext = await tx.vulnExtension.findUnique({ where: { id } });
    if (!ext) throw notFound('Продление');
    if (ext.cancelledAt) throw conflict('EXTENSION_CANCELLED', `Продление уже отменено ${formatDateRu(iso(ext.cancelledAt))}`);
    const { reg, vf } = await vulnDef(tx);
    await tx.vulnExtension.update({ where: { id }, data: { cancelledAt: new Date(), cancelledBy: actor.id } });
    const rows = await tx.$queryRaw<(Candidate & { days: number; item_cycle: number; deleted: boolean })[]>`
      SELECT r.id::text, r.number, r.version, r."values", v.cycle, i.days, i.cycle AS item_cycle, r.deleted_at IS NOT NULL AS deleted
      FROM vuln_extension_items i JOIN vuln_records v ON v.record_id = i.record_id JOIN register_records r ON r.id = i.record_id
      WHERE i.extension_id = ${id}::uuid ORDER BY r.number FOR UPDATE OF r`;
    const users = await loadUsers(tx);
    const calendar = await calendarFor(tx, reg);
    const basis = `по обоснованию ОИКТ № ${ext.basisNumber} от ${formatDateRu(iso(ext.basisDate))}`;
    let returned = 0;
    for (const r of rows) {
      if (r.deleted || r.cycle !== r.item_cycle) continue;
      const before = dateOf(reg, vf.due, r.values, calendar);
      const extra = r.values[vf.extDays.id];
      const left = Math.max(0, (typeof extra === 'number' ? extra : 0) - r.days);
      const values: Values = Object.fromEntries(Object.entries(r.values).filter(([fid]) => fid !== vf.extDays.id));
      if (left) values[vf.extDays.id] = left;
      const after = dateOf(reg, vf.due, values, calendar);
      await tx.registerRecord.update({
        where: { id: r.id },
        data: { values: values as Prisma.InputJsonValue, searchText: searchTextOf(reg, r.number, values, users), version: { increment: 1 } },
      });
      await auditSettings(tx, actor, {
        action: 'register_record.updated', entity: 'register_record', entityId: r.id,
        summary: `«${reg.name}», запись #${r.number}: продление ${basis} отменено, срок −${r.days} дн.`,
        after: {
          changes: [{ fieldId: vf.due.id, label: vf.due.label, from: before ? formatDateRu(before) : '', to: after ? formatDateRu(after) : '' }],
          via: 'extension_cancel', extensionId: id, days: r.days,
        },
      });
      returned++;
    }
    await auditSettings(tx, actor, {
      action: 'vuln.extension.cancelled', entity: 'vuln_extension', entityId: id,
      summary: `Уязвимости: продление ${basis} отменено, сроки возвращены у записей: ${returned} из ${rows.length}`,
      after: { returned, total: rows.length },
    });
    return { returned, total: rows.length, registerId: reg.id };
  });
}

type ExtRow = Prisma.VulnExtensionGetPayload<{
  include: {
    node: { include: { group: true; systemType: true } }; group: true; basisFile: { select: { id: true; originalName: true } };
    creator: { select: { fullName: true } }; canceller: { select: { fullName: true } };
  };
}>;
const extInclude = {
  node: { include: { group: true, systemType: true } }, group: true, basisFile: { select: { id: true, originalName: true } },
  creator: { select: { fullName: true } }, canceller: { select: { fullName: true } },
} as const;

function extDto(e: ExtRow, vf: VulnFields) {
  const days = e.daysByLevel as Record<string, number>;
  const filters = e.filters as { onlyOverdue?: boolean; dueUntil?: string | null };
  return {
    id: e.id,
    scope: e.node ? nodeLabel(e.node) : `${e.group?.name ?? LEGACY_NODE_LABEL} (все узлы)`,
    nodeId: e.nodeId,
    groupId: e.groupId,
    days: Object.entries(days).filter(([, d]) => d > 0).map(([level, d]) => ({ level: level === NO_LEVEL ? NO_LEVEL_LABEL : vf.level.options.find((o) => o.id === level)?.label ?? '', days: d })),
    onlyOverdue: !!filters.onlyOverdue,
    dueUntil: filters.dueUntil ?? null,
    basisNumber: e.basisNumber,
    basisDate: iso(e.basisDate),
    basisFile: { id: e.basisFile.id, name: e.basisFile.originalName },
    comment: e.comment,
    recordsCount: e.recordsCount,
    createdBy: e.creator.fullName,
    createdAt: e.createdAt.toISOString(),
    cancelledAt: e.cancelledAt?.toISOString() ?? null,
    cancelledBy: e.canceller?.fullName ?? null,
  };
}

/** Продления узла (его и всей группы) или группы (её и её узлов): новые сверху. */
export async function listExtensions(db: Db, q: ExtensionScope) {
  if (!q.nodeId === !q.groupId) throw badRequest('BAD_SCOPE', 'Укажите узел или группу');
  const { vf } = await vulnDef(db);
  let where: Prisma.VulnExtensionWhereInput;
  if (q.nodeId) {
    const node = await db.vulnNode.findUnique({ where: { id: q.nodeId } });
    if (!node) throw notFound('Узел');
    where = { OR: [{ nodeId: node.id }, { groupId: node.groupId }] };
  } else {
    where = { OR: [{ groupId: q.groupId as string }, { node: { groupId: q.groupId as string } }] };
  }
  const rows = await db.vulnExtension.findMany({ where, include: extInclude, orderBy: { createdAt: 'desc' } });
  return rows.map((e) => extDto(e, vf));
}

export async function getExtension(db: Db, id: string) {
  const { vf } = await vulnDef(db);
  const e = await db.vulnExtension.findUnique({ where: { id }, include: { ...extInclude, items: { include: { record: { select: { number: true, values: true, deletedAt: true } } } } } });
  if (!e) throw notFound('Продление');
  return {
    ...extDto(e, vf),
    items: e.items
      .map((i) => {
        const values = i.record.values as Values;
        const cve = values[vf.cve.id];
        return {
          recordId: i.recordId, number: i.record.number, pkg: vf.pkg.options.find((o) => o.id === values[vf.pkg.id])?.label ?? '',
          cve: typeof cve === 'string' ? cve : '', days: i.days, dueBefore: iso(i.dueBefore), dueAfter: iso(i.dueAfter),
        };
      })
      .sort((a, b) => a.number - b.number),
  };
}

/** Продления записи для карточки: зачёркнуто, если отменено или относится к прошлому циклу. */
export async function recordExtensions(db: Db, recordId: string, cycle: number) {
  const items = await db.vulnExtensionItem.findMany({
    where: { recordId },
    include: { extension: { select: { id: true, basisNumber: true, basisDate: true, cancelledAt: true, createdAt: true, basisFileId: true } } },
  });
  return items
    .sort((a, b) => b.extension.createdAt.getTime() - a.extension.createdAt.getTime())
    .map((i) => ({
      id: i.extensionId, days: i.days, dueBefore: iso(i.dueBefore), dueAfter: iso(i.dueAfter),
      basisNumber: i.extension.basisNumber, basisDate: iso(i.extension.basisDate), basisFileId: i.extension.basisFileId,
      cancelledAt: i.extension.cancelledAt?.toISOString() ?? null,
      active: i.extension.cancelledAt === null && i.cycle === cycle,
    }));
}
