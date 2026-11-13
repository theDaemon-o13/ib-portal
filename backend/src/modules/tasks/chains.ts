// Цепочки задач (релиз 1.7.0, ADR-0035): задачи с одной темой собирает человек, портал подсказывает (chain-suggest.ts).
// Цепочка — только группировка: исполнитель, проверяющий, колонка и архив задачи не меняются; процесс (flow.ts,
// process.ts, updateTask) о цепочках не знает. Статус цепочки от статусов задач не зависит.
// Видимость — одна функция visibleTasksWhere: цепочки, счётчики, подсказки и поиск считают только видимые задачи;
// цепочка без видимых задач не показывается.
// Права (решение владельца 04.11.2026, без новых кодов): привязать, отвязать, перенести — любой с ib.work (маршрут);
// править, закрыть, открыть, удалить — создатель, ответственный или tasks.assign.
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { formatDateRu, isIsoDate } from '../../lib/register-values.js';
import { stripReplyPrefixes, titleKey } from '../../lib/title-key.js';
import { auditSettings, ensureVersioned, trimmed } from '../settings/common.js';
import type { TaskActor } from './flow.js';
import { assertAssignee } from './service.js';
import { assertNotSystem, type SourceType } from './system-chains.js';

export const CHAIN_TITLE_MAX = 300;
export const CHAIN_SUMMARY_MAX = 20_000;
/** Задач за одну привязку (создание из подсказки, поиск среди старых задач). */
export const CHAIN_ATTACH_MAX = 200;
export const CHAIN_LIST_LIMIT = 200;

/**
 * Задачи, которые видит пользователь. Сейчас: все неудалённые задачи — тем, у кого ib.work (маршруты /tasks* закрыты
 * этим правом, CLAUDE.md, раздел 5); без права — ни одной. Если у задач появятся свои правила видимости, их место здесь.
 */
export function visibleTasksWhere(actor: Pick<TaskActor, 'perms'>): Prisma.TaskWhereInput {
  if (!actor.perms.has('ib.work')) return { id: { in: [] } };
  return { deletedAt: null };
}

/** Может ли пользователь править, закрывать, открывать и удалять цепочку. */
export function canManageChain(actor: TaskActor, chain: { createdBy: string; ownerId: string | null }): boolean {
  return chain.createdBy === actor.id || chain.ownerId === actor.id || actor.perms.has('tasks.assign');
}

function assertManage(actor: TaskActor, chain: { createdBy: string; ownerId: string | null; number: number; kind: string }) {
  assertNotSystem(chain);
  if (!canManageChain(actor, chain)) {
    throw new AppError(403, 'CHAIN_FORBIDDEN', `Цепочку #${chain.number} меняют её создатель, ответственный или пользователь с правом «Задачи: постановка другим»`);
  }
}

const userBrief = { select: { id: true, fullName: true } } as const;
const chainInclude = { owner: userBrief, creator: userBrief } as const;
type ChainRow = Prisma.TaskChainGetPayload<{ include: typeof chainInclude }>;

/** active (1.14.0) — не выполнены и не в архиве: такие задачи на доске. */
export interface ChainCounts { total: number; done: number; active: number }
const NO_COUNTS: ChainCounts = { total: 0, done: 0, active: 0 };

/** Счётчики по видимым задачам: всего и выполнено (completed_at), включая архивные; активные — на доске. */
async function countsOf(db: Db, actor: TaskActor, chainIds: string[]): Promise<Map<string, ChainCounts>> {
  const out = new Map<string, ChainCounts>();
  if (!chainIds.length) return out;
  const where: Prisma.TaskWhereInput = { AND: [visibleTasksWhere(actor), { chainId: { in: chainIds } }] };
  const [all, done, active] = await Promise.all([
    db.task.groupBy({ by: ['chainId'], where, _count: { _all: true } }),
    db.task.groupBy({ by: ['chainId'], where: { AND: [where, { completedAt: { not: null } }] }, _count: { _all: true } }),
    db.task.groupBy({ by: ['chainId'], where: { AND: [where, { completedAt: null, archivedAt: null }] }, _count: { _all: true } }),
  ]);
  const at = (id: string) => out.get(id) ?? out.set(id, { ...NO_COUNTS }).get(id) as ChainCounts;
  for (const r of all) if (r.chainId) at(r.chainId).total = r._count._all;
  for (const r of done) if (r.chainId) at(r.chainId).done = r._count._all;
  for (const r of active) if (r.chainId) at(r.chainId).active = r._count._all;
  return out;
}

/** Источник системной цепочки (1.14.0): группа «Уязвимостей» или реестр; deleted — источник удалён (в корзине). */
export interface ChainSourceInfo { type: SourceType; id: string; name: string; deleted: boolean }

export async function sourcesInfo(db: Db, rows: readonly { kind: string; sourceType: string | null; sourceId: string | null }[]): Promise<Map<string, ChainSourceInfo>> {
  const ids = (t: string) => [...new Set(rows.filter((r) => r.kind === 'system' && r.sourceType === t && r.sourceId).map((r) => r.sourceId as string))];
  const [groups, registers] = await Promise.all([
    ids('vuln_group').length ? db.vulnGroup.findMany({ where: { id: { in: ids('vuln_group') } }, select: { id: true, name: true, deletedAt: true } }) : [],
    ids('register').length ? db.register.findMany({ where: { id: { in: ids('register') } }, select: { id: true, name: true, deletedAt: true } }) : [],
  ]);
  const out = new Map<string, ChainSourceInfo>();
  for (const g of groups) out.set(`vuln_group|${g.id}`, { type: 'vuln_group', id: g.id, name: g.name, deleted: g.deletedAt !== null });
  for (const r of registers) out.set(`register|${r.id}`, { type: 'register', id: r.id, name: r.name, deleted: r.deletedAt !== null });
  return out;
}
const sourceOf = (c: { kind: string; sourceType: string | null; sourceId: string | null }, info: Map<string, ChainSourceInfo>) =>
  (c.kind === 'system' ? info.get(`${c.sourceType}|${c.sourceId}`) ?? null : null);

export function toChainDto(c: ChainRow, counts: ChainCounts, actor: TaskActor, source: ChainSourceInfo | null = null) {
  const system = c.kind === 'system';
  return {
    id: c.id,
    number: c.number,
    title: c.title,
    /** Системная цепочка всегда открыта (закрыть её мог только 1.13.12 после отката). */
    status: (system ? 'open' : c.status) as 'open' | 'closed',
    kind: (system ? 'system' : 'manual') as 'manual' | 'system',
    source,
    owner: c.owner,
    dueDate: c.dueDate ? c.dueDate.toISOString().slice(0, 10) : null,
    summary: c.summary,
    createdBy: c.creator,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    closedAt: c.closedAt?.toISOString() ?? null,
    version: c.version,
    counts,
    /** Все видимые задачи выполнены — интерфейс предлагает «Закрыть цепочку» (сам портал не закрывает). */
    allDone: !system && counts.total > 0 && counts.done === counts.total,
    canManage: !system && canManageChain(actor, c),
  };
}
export type ChainDto = ReturnType<typeof toChainDto>;

// ---------------------------------------------------------------- чтение

export interface ChainListQuery {
  status?: 'open' | 'closed';
  kind?: 'manual' | 'system';
  ownerId?: string;
  q?: string;
  limit: number;
  cursor?: string;
}

/** Цепочки с хотя бы одной видимой задачей: открытые первыми, затем недавно изменённые. */
export async function listChains(db: Db, actor: TaskActor, q: ChainListQuery) {
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const text = trimmed(q.q ?? '');
  const where: Prisma.TaskChainWhereInput = {
    deletedAt: null,
    tasks: { some: visibleTasksWhere(actor) },
    // Системная цепочка — всегда «открыта», что бы ни лежало в status.
    ...(q.status === 'open' ? { OR: [{ status: 'open' }, { kind: 'system' }] } : q.status === 'closed' ? { status: 'closed', kind: 'manual' } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.ownerId ? { ownerId: q.ownerId } : {}),
    ...(text ? { OR: [{ title: { contains: text, mode: 'insensitive' } }, ...(/^#?\d+$/.test(text) ? [{ number: Number(text.replace('#', '')) }] : [])] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.taskChain.findMany({ where, include: chainInclude, orderBy: [{ status: 'desc' }, { updatedAt: 'desc' }, { number: 'desc' }], skip: offset, take: q.limit + 1 }),
    db.taskChain.count({ where }),
  ]);
  const page = rows.slice(0, q.limit);
  const [counts, info] = await Promise.all([countsOf(db, actor, page.map((c) => c.id)), sourcesInfo(db, page)]);
  return {
    items: page.map((c) => toChainDto(c, counts.get(c.id) ?? NO_COUNTS, actor, sourceOf(c, info))),
    nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
    total,
  };
}

const memberSelect = {
  id: true, number: true, title: true, createdAt: true, completedAt: true, archivedAt: true, dueDate: true,
  status: { select: { id: true, value: true, systemKey: true, color: true } }, assignee: userBrief,
} as const;

/** Цепочка и её видимые задачи по дате создания (хронология), включая выполненные и архивные. */
export async function getChain(db: Db, actor: TaskActor, id: string) {
  const c = await db.taskChain.findFirst({ where: { id, deletedAt: null }, include: chainInclude });
  if (!c) throw notFound('Цепочка');
  const tasks = await db.task.findMany({
    where: { AND: [visibleTasksWhere(actor), { chainId: id }] }, select: memberSelect, orderBy: [{ createdAt: 'asc' }, { number: 'asc' }],
  });
  if (!tasks.length) throw notFound('Цепочка');
  const counts = { total: tasks.length, done: tasks.filter((t) => t.completedAt).length, active: tasks.filter((t) => !t.completedAt && !t.archivedAt).length };
  const info = await sourcesInfo(db, [c]);
  return {
    ...toChainDto(c, counts, actor, sourceOf(c, info)),
    tasks: tasks.map((t) => ({
      id: t.id, number: t.number, title: t.title, status: t.status, assignee: t.assignee,
      dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null, createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null, archived: t.archivedAt !== null,
    })),
  };
}

/** Короткие сведения о цепочках задач — для карточек доски и карточки задачи. */
export async function chainBriefs(db: Db, chainIds: string[]) {
  const ids = [...new Set(chainIds)];
  if (!ids.length) return new Map<string, { id: string; number: number; title: string; status: 'open' | 'closed'; kind: 'manual' | 'system' }>();
  const rows = await db.taskChain.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, number: true, title: true, status: true, kind: true } });
  return new Map(rows.map((r) => [r.id, { ...r, status: (r.kind === 'system' ? 'open' : r.status) as 'open' | 'closed', kind: (r.kind === 'system' ? 'system' : 'manual') as 'manual' | 'system' }]));
}

/**
 * Системная цепочка источника — для ссылки «Задачи: N активных» на странице группы «Уязвимостей» и реестра.
 * Нет цепочки или видимых задач — null.
 */
export async function chainBySource(db: Db, actor: TaskActor, type: SourceType, sourceId: string) {
  const c = await db.taskChain.findFirst({
    where: { kind: 'system', sourceType: type, sourceId, deletedAt: null, tasks: { some: visibleTasksWhere(actor) } },
    select: { id: true, number: true, title: true },
  });
  if (!c) return { chain: null };
  const counts = (await countsOf(db, actor, [c.id])).get(c.id) ?? NO_COUNTS;
  return { chain: { ...c, active: counts.active, total: counts.total } };
}

// ---------------------------------------------------------------- проверки ввода

function cleanTitle(v: string): { title: string; key: string } {
  const title = trimmed(v);
  if (!title) throw badRequest('EMPTY_TITLE', 'Укажите название цепочки');
  if (title.length > CHAIN_TITLE_MAX) throw badRequest('TOO_LONG', `Название — не длиннее ${CHAIN_TITLE_MAX} символов`);
  const key = titleKey(title);
  if (!key) throw badRequest('EMPTY_TITLE', 'В названии нет слов — только «RE:», «FW:» и знаки. Напишите тему цепочки');
  return { title, key };
}

function cleanSummary(v: string): string {
  if (v.length > CHAIN_SUMMARY_MAX) throw badRequest('TOO_LONG', `Сводка — не длиннее ${CHAIN_SUMMARY_MAX} символов`);
  return v.trim();
}

function checkDue(v: string | null | undefined) {
  if (v !== null && v !== undefined && !isIsoDate(v)) throw badRequest('BAD_DATE', 'Срок — дата в формате ГГГГ-ММ-ДД');
}

/** Название новой цепочки по заголовку задачи: без «RE:», «FW:» и т. п. («RE: Тестовая тема» → «Тестовая тема»). */
export function chainTitleFrom(taskTitle: string): string {
  return stripReplyPrefixes(taskTitle) || taskTitle.trim();
}

// ---------------------------------------------------------------- привязка задач

export interface TaskRef { id: string; version: number }

type LinkKind = 'linked' | 'unlinked' | 'moved';

/**
 * Сменить цепочку у задач: только chain_id и версия задачи (статус, архив и прочее не трогаются), запись в журнале
 * задачи — видна в её истории. Удалённую задачу привязать нельзя; выполненную и архивную — можно.
 */
async function setTaskChain(
  tx: Db, actor: TaskActor, refs: readonly TaskRef[], to: { id: string; number: number; title: string } | null,
  expectFrom: (taskChainId: string | null, number: number) => void, via?: string,
) {
  if (refs.length > CHAIN_ATTACH_MAX) throw badRequest('TOO_MANY', `Не больше ${CHAIN_ATTACH_MAX} задач за раз`);
  const ids = [...new Set(refs.map((r) => r.id))];
  if (ids.length !== refs.length) throw badRequest('DUPLICATE_TASK', 'Задача указана дважды');
  const rows = await tx.task.findMany({
    where: { AND: [visibleTasksWhere(actor), { id: { in: ids } }] },
    select: { id: true, number: true, title: true, version: true, chainId: true, chain: { select: { number: true, title: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const ref of refs) {
    const t = byId.get(ref.id);
    if (!t) throw notFound('Задача');
    if (t.version !== ref.version) throw versionConflict();
    expectFrom(t.chainId, t.number);
  }
  for (const ref of refs) {
    const t = byId.get(ref.id) as (typeof rows)[number];
    const res = await tx.task.updateMany({ where: { id: t.id, version: ref.version, deletedAt: null }, data: { chainId: to?.id ?? null, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.task.findFirst({ where: { id: t.id, deletedAt: null } }), 'Задача');
    const kind: LinkKind = !to ? 'unlinked' : t.chainId ? 'moved' : 'linked';
    const from = t.chain ? `«${t.chain.title}» (#${t.chain.number})` : '—';
    const toLabel = to ? `«${to.title}» (#${to.number})` : '—';
    const summary = kind === 'linked' ? `Задача #${t.number} добавлена в цепочку ${toLabel}`
      : kind === 'moved' ? `Задача #${t.number} перенесена из цепочки ${from} в ${toLabel}`
      : `Задача #${t.number} отвязана от цепочки ${from}`;
    await auditSettings(tx, actor, {
      action: `task.chain_${kind}`, entity: 'task', entityId: t.id, summary,
      after: { fromChainId: t.chainId, toChainId: to?.id ?? null, ...(via ? { via } : {}), changes: [{ field: 'chainId', label: 'Цепочка', from, to: toLabel }] },
    });
  }
}

async function lockChain(tx: Db, id: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM task_chains WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
  if (!locked.length) throw notFound('Цепочка');
  return tx.taskChain.findUniqueOrThrow({ where: { id }, include: chainInclude });
}

function assertOpen(c: { status: string; number: number; title: string }) {
  if (c.status !== 'open') throw conflict('CHAIN_CLOSED', `Цепочка «${c.title}» закрыта. Откройте её заново, чтобы добавить задачу`);
}

// ---------------------------------------------------------------- создание и правка

export interface NewChainInput {
  title: string;
  ownerId?: string | null;
  dueDate?: string | null;
  summary?: string;
  tasks: TaskRef[];
}

/** Создать цепочку из задач (хотя бы одной: цепочка без видимых задач не показывается). Одна транзакция. */
export async function createChain(db: Db, actor: TaskActor, input: NewChainInput, via?: string) {
  return withTx(db, async (tx) => {
    const id = await createChainTx(tx, actor, input, via);
    return getChain(tx, actor, id);
  });
}

export async function createChainTx(tx: Db, actor: TaskActor, input: NewChainInput, via?: string): Promise<string> {
  const { title, key } = cleanTitle(input.title);
  checkDue(input.dueDate);
  if (!input.tasks.length) throw badRequest('NO_TASKS', 'Добавьте в цепочку хотя бы одну задачу');
  if (input.ownerId) await assertAssignee(tx, input.ownerId);
  const chain = await tx.taskChain.create({
    data: {
      title, titleKey: key, ownerId: input.ownerId ?? null, dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00Z`) : null,
      summary: cleanSummary(input.summary ?? ''), createdBy: actor.id,
    },
  });
  await auditSettings(tx, actor, {
    action: 'task_chain.created', entity: 'task_chain', entityId: chain.id,
    summary: `Цепочка #${chain.number} «${title}» создана`,
    after: { title, ownerId: chain.ownerId, dueDate: input.dueDate ?? null, tasks: input.tasks.length, ...(via ? { via } : {}) },
  });
  await setTaskChain(tx, actor, input.tasks, chain, (from, number) => {
    if (from) throw conflict('TASK_IN_OTHER_CHAIN', `Задача #${number} уже в другой цепочке — перенесите её`);
  }, via);
  return chain.id;
}

export interface ChainPatch {
  version: number;
  title?: string;
  ownerId?: string | null;
  dueDate?: string | null;
  summary?: string;
}

export async function updateChain(db: Db, actor: TaskActor, id: string, input: ChainPatch) {
  return withTx(db, async (tx) => {
    const c = await lockChain(tx, id);
    assertManage(actor, c);
    if (c.version !== input.version) throw versionConflict();
    const data: Prisma.TaskChainUpdateInput = {};
    const changes: { field: string; label: string; from: string; to: string }[] = [];
    if (input.title !== undefined) {
      const { title, key } = cleanTitle(input.title);
      if (title !== c.title) {
        data.title = title;
        data.titleKey = key;
        changes.push({ field: 'title', label: 'Название', from: c.title, to: title });
      }
    }
    if (input.ownerId !== undefined && input.ownerId !== c.ownerId) {
      let name = '—';
      if (input.ownerId) {
        await assertAssignee(tx, input.ownerId);
        name = (await tx.user.findUnique({ where: { id: input.ownerId }, select: { fullName: true } }))?.fullName ?? '—';
      }
      data.owner = input.ownerId ? { connect: { id: input.ownerId } } : { disconnect: true };
      changes.push({ field: 'ownerId', label: 'Ответственный', from: c.owner?.fullName ?? '—', to: name });
    }
    if (input.dueDate !== undefined) {
      checkDue(input.dueDate);
      const before = c.dueDate?.toISOString().slice(0, 10) ?? null;
      if ((input.dueDate ?? null) !== before) {
        data.dueDate = input.dueDate ? new Date(`${input.dueDate}T00:00:00Z`) : null;
        changes.push({ field: 'dueDate', label: 'Срок', from: before ? formatDateRu(before) : '—', to: input.dueDate ? formatDateRu(input.dueDate) : '—' });
      }
    }
    if (input.summary !== undefined) {
      const summary = cleanSummary(input.summary);
      if (summary !== c.summary) {
        data.summary = summary;
        changes.push({ field: 'summary', label: 'Сводка', from: c.summary ? 'было' : '—', to: summary ? 'изменена' : '—' });
      }
    }
    if (changes.length) {
      await tx.taskChain.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      await auditSettings(tx, actor, {
        action: 'task_chain.updated', entity: 'task_chain', entityId: id,
        summary: `Цепочка #${c.number}: ${changes.map((x) => `«${x.label}»`).join(', ')}`, after: { changes },
      });
    }
    return getChain(tx, actor, id);
  });
}

/** Закрыть: незавершённые задачи не мешают (решение владельца) — их число попадает в журнал. */
export async function closeChain(db: Db, actor: TaskActor, id: string, version: number) {
  return withTx(db, async (tx) => {
    const c = await lockChain(tx, id);
    assertManage(actor, c);
    if (c.version !== version) throw versionConflict();
    if (c.status !== 'closed') {
      const openTasks = await tx.task.count({ where: { AND: [visibleTasksWhere(actor), { chainId: id, completedAt: null }] } });
      await tx.taskChain.update({ where: { id }, data: { status: 'closed', closedAt: new Date(), version: { increment: 1 } } });
      await auditSettings(tx, actor, {
        action: 'task_chain.closed', entity: 'task_chain', entityId: id,
        summary: `Цепочка #${c.number} «${c.title}» закрыта${openTasks ? `, незавершённых задач: ${openTasks}` : ''}`, after: { openTasks },
      });
    }
    return getChain(tx, actor, id);
  });
}

export async function reopenChain(db: Db, actor: TaskActor, id: string, version: number, via?: string) {
  return withTx(db, async (tx) => {
    const c = await lockChain(tx, id);
    if (c.version !== version) throw versionConflict();
    await reopenTx(tx, actor, c, via);
    return getChain(tx, actor, id);
  });
}

async function reopenTx(tx: Db, actor: TaskActor, c: ChainRow, via?: string) {
  assertManage(actor, c);
  if (c.status === 'open') return;
  await tx.taskChain.update({ where: { id: c.id }, data: { status: 'open', closedAt: null, version: { increment: 1 } } });
  await auditSettings(tx, actor, {
    action: 'task_chain.reopened', entity: 'task_chain', entityId: c.id,
    summary: `Цепочка #${c.number} «${c.title}» открыта заново${via ? ` (${via})` : ''}`, ...(via ? { after: { via } } : {}),
  });
}

/** Мягкое удаление: задачи отвязываются (каждая — запись в истории), сами не меняются. Восстановления нет. */
export async function deleteChain(db: Db, actor: TaskActor, id: string, version: number) {
  await withTx(db, async (tx) => {
    const c = await lockChain(tx, id);
    assertManage(actor, c);
    if (c.version !== version) throw versionConflict();
    // Все задачи цепочки, в том числе невидимые этому пользователю и удалённые: иначе ссылка останется.
    const members = await tx.task.findMany({ where: { chainId: id }, select: { id: true, number: true, version: true, deletedAt: true } });
    const live = members.filter((t) => !t.deletedAt);
    for (const t of members.filter((x) => x.deletedAt)) await tx.task.update({ where: { id: t.id }, data: { chainId: null } });
    await setTaskChain(tx, { ...actor, perms: new Set([...actor.perms, 'ib.work']) }, live.map((t) => ({ id: t.id, version: t.version })), null, () => undefined, 'chain_deleted');
    await tx.taskChain.update({ where: { id }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    await auditSettings(tx, actor, {
      action: 'task_chain.deleted', entity: 'task_chain', entityId: id,
      summary: `Цепочка #${c.number} «${c.title}» удалена, задачи отвязаны: ${live.length}`,
      before: { title: c.title, status: c.status, ownerId: c.ownerId }, after: { unlinked: live.map((t) => t.number) },
    });
  });
}

/**
 * Привязать задачи к цепочке. Закрытая цепочка — 409 CHAIN_CLOSED, если не передан reopen
 * («Вернуть в работу и добавить»: открыть заново может создатель, ответственный или tasks.assign).
 * Задача из другой цепочки — 409 TASK_IN_OTHER_CHAIN (для этого есть перенос).
 */
export async function attachTasks(db: Db, actor: TaskActor, id: string, input: { tasks: TaskRef[]; reopen?: boolean }) {
  return withTx(db, async (tx) => {
    await attachTx(tx, actor, id, input);
    return getChain(tx, actor, id);
  });
}

export async function attachTx(tx: Db, actor: TaskActor, id: string, input: { tasks: TaskRef[]; reopen?: boolean }, via?: string) {
  if (!input.tasks.length) throw badRequest('NO_TASKS', 'Выберите задачу');
  const c = await lockChain(tx, id);
  // В системную цепочку задачи добавляет только портал (1.14.0, ADR-0053).
  assertNotSystem(c);
  if (c.status !== 'open') {
    if (!input.reopen) assertOpen(c);
    await reopenTx(tx, actor, c, input.tasks.length > 1 ? 'при добавлении задач' : 'при добавлении задачи');
  }
  await setTaskChain(tx, actor, input.tasks, c, (from, number) => {
    if (from === id) throw conflict('TASK_IN_CHAIN', `Задача #${number} уже в этой цепочке`);
    if (from) throw conflict('TASK_IN_OTHER_CHAIN', `Задача #${number} уже в другой цепочке — перенесите её`);
  }, via);
  await tx.taskChain.update({ where: { id }, data: { updatedAt: new Date() } });
}

/** Отвязать задачу от цепочки. */
export async function detachTask(db: Db, actor: TaskActor, id: string, taskId: string, version: number) {
  return withTx(db, async (tx) => {
    const c = await lockChain(tx, id);
    await setTaskChain(tx, actor, [{ id: taskId, version }], null, (from, number) => {
      if (from !== id) throw conflict('TASK_NOT_IN_CHAIN', `Задача #${number} не в цепочке «${c.title}»`);
    });
    await tx.taskChain.update({ where: { id }, data: { updatedAt: new Date() } });
    return { taskId, chainId: id };
  });
}

/** Перенести задачу в другую цепочку одной транзакцией. Целевая закрытая — 409 CHAIN_CLOSED. */
export async function moveTask(db: Db, actor: TaskActor, taskId: string, input: { version: number; toChainId: string }) {
  return withTx(db, async (tx) => {
    const to = await lockChain(tx, input.toChainId);
    assertNotSystem(to);
    assertOpen(to);
    await setTaskChain(tx, actor, [{ id: taskId, version: input.version }], to, (from, number) => {
      if (!from) throw conflict('TASK_NOT_IN_CHAIN', `Задача #${number} не в цепочке — добавьте её`);
      if (from === to.id) throw conflict('TASK_IN_CHAIN', `Задача #${number} уже в этой цепочке`);
    });
    await tx.taskChain.update({ where: { id: to.id }, data: { updatedAt: new Date() } });
    return getChain(tx, actor, to.id);
  });
}
