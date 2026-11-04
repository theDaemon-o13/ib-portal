// Подсказка цепочки по заголовку задачи (релиз 1.7.0, ADR-0035). Портал только подсказывает — ничего не склеивает.
// Порядок (решение владельца 04.11.2026), всего не больше 5 вариантов:
//   1) открытые цепочки с тем же ключом — независимо от статусов задач;
//   2) закрытые с тем же ключом, где остались незавершённые задачи, — без ограничения по сроку;
//   3) открытые с похожим ключом (Жаккар по словам от трёх букв и минимум общих слов — app_settings);
//   4) закрытые с тем же ключом за closedDays дней;
//   5) задачи без цепочки с тем же ключом (ручные и из письма, в том числе выполненные и архивные).
// Цепочки сравниваются в приложении со всеми, без предварительного отбора: ключ цепочки и ключи её видимых задач.
// Задачи без цепочки отбираются в SQL по самому длинному слову ключа — сравнение там точное, ничего не теряется.
import type { Db } from '../../lib/db.js';
import { prefilterPattern, similarKeys, titleKey } from '../../lib/title-key.js';
import { readPortalParam } from '../settings/portal-params.js';
import { CHAIN_SUGGEST_KEY, type ChainSuggestSettings } from './chain-settings.js';
import { canManageChain, visibleTasksWhere } from './chains.js';
import type { TaskActor } from './flow.js';

export const SUGGEST_MAX = 5;
/** Задач без цепочки в одном варианте «Создать цепочку из этих задач». */
export const SUGGEST_TASKS_MAX = 50;
/** Источники задач, которые участвуют в подсказках и поиске среди старых задач: у системных заголовки шаблонные. */
export const CHAIN_SOURCES = ['manual', 'mail'] as const;

export type SuggestGroup = 'open_exact' | 'closed_unfinished' | 'open_similar' | 'closed_recent';

export interface SuggestedChain {
  kind: 'chain';
  group: SuggestGroup;
  chain: {
    id: string; number: number; title: string; status: 'open' | 'closed'; closedAt: string | null; version: number;
    counts: { total: number; done: number }; canManage: boolean;
  };
}
export interface SuggestedTasks {
  kind: 'tasks';
  total: number;
  tasks: { id: string; number: number; title: string; version: number; status: string; completed: boolean; archived: boolean; createdAt: string }[];
}
export type Suggestion = SuggestedChain | SuggestedTasks;

const DAY = 86_400_000;

export async function suggestChains(db: Db, actor: TaskActor, title: string, opts: { taskId?: string; now?: Date } = {}): Promise<{ key: string | null; items: Suggestion[] }> {
  const key = titleKey(title);
  if (!key) return { key: null, items: [] };
  const rule = await readPortalParam<ChainSuggestSettings>(db, CHAIN_SUGGEST_KEY);
  const now = opts.now ?? new Date();
  const visible = visibleTasksWhere(actor);
  const own = opts.taskId ? await db.task.findFirst({ where: { id: opts.taskId }, select: { chainId: true } }) : null;

  // Кандидаты-цепочки: все открытые; закрытые — недавние или с незавершёнными видимыми задачами. Только с видимыми задачами.
  const since = new Date(now.getTime() - rule.closedDays * DAY);
  const rows = await db.taskChain.findMany({
    where: {
      deletedAt: null,
      tasks: { some: visible },
      OR: [{ status: 'open' }, { closedAt: { gte: since } }, { tasks: { some: { AND: [visible, { completedAt: null }] } } }],
      ...(own?.chainId ? { NOT: { id: own.chainId } } : {}),
    },
    select: {
      id: true, number: true, title: true, titleKey: true, status: true, closedAt: true, version: true, createdBy: true, ownerId: true,
      tasks: { where: visible, select: { id: true, title: true, completedAt: true, createdAt: true } },
    },
  });

  const scored: (SuggestedChain & { last: number })[] = [];
  for (const c of rows) {
    const members = c.tasks.filter((t) => t.id !== opts.taskId);
    if (!members.length) continue;
    const keys = new Set([c.titleKey, ...members.map((t) => titleKey(t.title)).filter((k): k is string => !!k)]);
    const exact = keys.has(key);
    const similar = !exact && [...keys].some((k) => similarKeys(k, key, rule));
    const unfinished = members.some((t) => !t.completedAt);
    let group: SuggestGroup | null = null;
    if (c.status === 'open') group = exact ? 'open_exact' : similar ? 'open_similar' : null;
    else if (exact && unfinished) group = 'closed_unfinished';
    else if (exact && c.closedAt && c.closedAt >= since) group = 'closed_recent';
    if (!group) continue;
    scored.push({
      kind: 'chain', group,
      last: Math.max(...members.map((t) => t.createdAt.getTime())),
      chain: {
        id: c.id, number: c.number, title: c.title, status: c.status as 'open' | 'closed', closedAt: c.closedAt?.toISOString() ?? null, version: c.version,
        counts: { total: members.length, done: members.filter((t) => t.completedAt).length }, canManage: canManageChain(actor, c),
      },
    });
  }
  const order: SuggestGroup[] = ['open_exact', 'closed_unfinished', 'open_similar', 'closed_recent'];
  scored.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || b.last - a.last);
  const items: Suggestion[] = scored.slice(0, SUGGEST_MAX).map(({ last: _last, ...s }) => s);

  if (items.length < SUGGEST_MAX) {
    const loose = await looseTasks(db, actor, key, opts.taskId);
    if (loose.length) {
      items.push({
        kind: 'tasks', total: loose.length,
        tasks: loose.slice(0, SUGGEST_TASKS_MAX).map((t) => ({
          id: t.id, number: t.number, title: t.title, version: t.version, status: t.status.value,
          completed: t.completedAt !== null, archived: t.archivedAt !== null, createdAt: t.createdAt.toISOString(),
        })),
      });
    }
  }
  return { key, items };
}

/** Задачи без цепочки с тем же ключом: отбор в SQL по самому длинному слову (ILIKE), точное сравнение — здесь. */
export async function looseTasks(db: Db, actor: TaskActor, key: string, exceptTaskId?: string) {
  const pattern = prefilterPattern(key);
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT t.id::text FROM tasks t
    WHERE t.chain_id IS NULL AND t.deleted_at IS NULL AND t.source = ANY(${[...CHAIN_SOURCES]}::text[]) AND t.title ILIKE ${pattern}`;
  if (!ids.length) return [];
  const rows = await db.task.findMany({
    where: { AND: [visibleTasksWhere(actor), { id: { in: ids.map((r) => r.id).filter((id) => id !== exceptTaskId) } }] },
    select: { id: true, number: true, title: true, version: true, completedAt: true, archivedAt: true, createdAt: true, status: { select: { value: true } } },
    orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
  });
  return rows.filter((t) => titleKey(t.title) === key);
}
