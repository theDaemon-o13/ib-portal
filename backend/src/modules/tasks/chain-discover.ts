// «Найти цепочки среди старых задач» (релиз 1.7.0, ADR-0035). Миграция старые задачи не трогает: цепочки собираются
// по кнопке, после предпросмотра и подтверждения. Только точное совпадение ключа и не меньше двух задач (включая
// выполненные и архивные), только ручные и из письма, только задачи без цепочки — поэтому повторный запуск безопасен.
// Если с тем же ключом уже есть открытая цепочка — группа добавляется в неё, а не создаёт новую.
// Право — tasks.assign («Задачи: постановка другим»), решение владельца 04.11.2026.
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import { stripReplyPrefixes, titleKey } from '../../lib/title-key.js';
import { auditSettings } from '../settings/common.js';
import { CHAIN_SOURCES } from './chain-suggest.js';
import { attachTx, CHAIN_ATTACH_MAX, createChainTx, visibleTasksWhere, type TaskRef } from './chains.js';
import type { TaskActor } from './flow.js';

/** Групп в предпросмотре (самые большие первыми). */
export const DISCOVER_GROUPS_MAX = 500;

export interface DiscoverGroup {
  key: string;
  /** Название новой цепочки: тема самой ранней задачи без «RE:», «FW:». */
  title: string;
  tasks: { id: string; number: number; title: string; version: number; completed: boolean; archived: boolean; createdAt: string }[];
  /** Открытая цепочка с тем же ключом — группа добавится в неё. */
  target: { id: string; number: number; title: string } | null;
}

function assertAllowed(actor: TaskActor) {
  if (!actor.perms.has('tasks.assign')) {
    throw new AppError(403, 'FORBIDDEN', 'Искать цепочки среди старых задач может пользователь с правом «Задачи: постановка другим»');
  }
}

async function groupsOf(db: Db, actor: TaskActor): Promise<DiscoverGroup[]> {
  const rows = await db.task.findMany({
    where: { AND: [visibleTasksWhere(actor), { chainId: null, source: { in: [...CHAIN_SOURCES] } }] },
    select: { id: true, number: true, title: true, version: true, completedAt: true, archivedAt: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { number: 'asc' }],
  });
  const byKey = new Map<string, typeof rows>();
  for (const t of rows) {
    const k = titleKey(t.title);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }
  const keys = [...byKey].filter(([, list]) => list.length >= 2).map(([k]) => k);
  const chains = keys.length
    ? await db.taskChain.findMany({
      where: { titleKey: { in: keys }, status: 'open', deletedAt: null, tasks: { some: visibleTasksWhere(actor) } },
      select: { id: true, number: true, title: true, titleKey: true, updatedAt: true }, orderBy: { updatedAt: 'desc' },
    })
    : [];
  return keys.map((key) => {
    const list = byKey.get(key) ?? [];
    const target = chains.find((c) => c.titleKey === key);
    return {
      key,
      title: stripReplyPrefixes(list[0]?.title ?? key) || key,
      tasks: list.map((t) => ({
        id: t.id, number: t.number, title: t.title, version: t.version,
        completed: t.completedAt !== null, archived: t.archivedAt !== null, createdAt: t.createdAt.toISOString(),
      })),
      target: target ? { id: target.id, number: target.number, title: target.title } : null,
    };
  }).sort((a, b) => b.tasks.length - a.tasks.length || a.title.localeCompare(b.title, 'ru'));
}

/** Предпросмотр: что с чем объединится. Ничего не меняет. */
export async function discoverPreview(db: Db, actor: TaskActor) {
  assertAllowed(actor);
  const groups = await groupsOf(db, actor);
  return { groups: groups.slice(0, DISCOVER_GROUPS_MAX), total: groups.length, tasks: groups.reduce((s, g) => s + g.tasks.length, 0) };
}

export interface DiscoverApplyGroup {
  key: string;
  title?: string;
  tasks: TaskRef[];
  /** Открытая цепочка из предпросмотра (null — новая). */
  chainId: string | null;
}

/**
 * Применение выбранных групп одной транзакцией. Сервер заново строит группы: если задача успела попасть в цепочку,
 * изменилась или открытая цепочка-цель пропала — 409 BULK_CHANGED, не применяется ничего.
 */
export async function discoverApply(db: Db, actor: TaskActor, input: { groups: DiscoverApplyGroup[] }) {
  assertAllowed(actor);
  if (!input.groups.length) throw badRequest('NOTHING_SELECTED', 'Выберите хотя бы одну группу');
  return withTx(db, async (tx) => {
    const fresh = new Map((await groupsOf(tx, actor)).map((g) => [g.key, g]));
    const changed = () => conflict('BULK_CHANGED', 'После предпросмотра задачи изменились. Обновите предпросмотр');
    let created = 0;
    let attached = 0;
    let tasks = 0;
    for (const g of input.groups) {
      const now = fresh.get(g.key);
      if (!now || (now.target?.id ?? null) !== g.chainId) throw changed();
      const versions = new Map(now.tasks.map((t) => [t.id, t.version]));
      if (g.tasks.length < 2 && !g.chainId) throw changed();
      if (g.tasks.length > CHAIN_ATTACH_MAX) throw badRequest('TOO_MANY', `В группе больше ${CHAIN_ATTACH_MAX} задач — соберите её вручную частями`);
      if (g.tasks.some((t) => versions.get(t.id) !== t.version)) throw changed();
      if (g.chainId) {
        await attachTx(tx, actor, g.chainId, { tasks: g.tasks }, 'discover');
        attached++;
      } else {
        await createChainTx(tx, actor, { title: g.title?.trim() || now.title, tasks: g.tasks }, 'discover');
        created++;
      }
      tasks += g.tasks.length;
    }
    await auditSettings(tx, actor, {
      action: 'task_chain.discovered', entity: 'task_chain', entityId: 'discover',
      summary: `Цепочки среди старых задач: создано ${created}, дополнено ${attached}, задач привязано ${tasks}`,
      after: { created, attached, tasks },
    });
    return { created, attached, tasks };
  });
}
