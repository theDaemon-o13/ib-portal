// Массовые действия с задачами (релиз 1.1.0, задача 2; порядок — ADR-0016): выбранные на доске или
// созданные правилом автоматизации. Предпросмотр → применение с expected (разошлось — 409 BULK_CHANGED);
// пакеты по 200 в своих транзакциях; по задаче — та же запись журнала, что у одиночного действия, плюс сводная.
// Удаление мягкое (deleted_at), только по праву tasks.delete — его проверяет маршрут.
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { taskControlLinks } from '../documents/control-links.js';
import { taskLetterLinks } from '../awareness-letters/links.js';
import { auditSettings, type Actor } from '../settings/common.js';

export const TASK_BULK_BATCH = 200;
export const TASK_BULK_MAX_IDS = 5000;

export type TaskBulkAction = 'archive' | 'delete';

export interface TaskSelection {
  /** Выбранные на доске. */
  ids?: string[];
  /** Все задачи правила автоматизации (tasks.automation_id). */
  automationId?: string;
  /** Только нетронутые: ни комментариев людей, ни правок людьми — только то, что сделала автоматизация. */
  onlyUntouched?: boolean;
}

export interface TaskBulkPreview {
  /** Неудалённых задач в выборке. */
  total: number;
  /** Сколько изменит действие (с учётом «только нетронутые»). */
  affected: number;
  /** Уже в архиве (для архивации) — не меняются. */
  alreadyInState: number;
  /** Нетронутых среди выборки. */
  untouched: number;
  /** Разбивка выборки по статусам. */
  byStatus: { statusId: string; label: string; count: number }[];
  /** Связаны с учебным письмом или правилом расписания (1.9.0): не удаляются, пропускаются — только архив. */
  linkedToLetters: number;
}

export interface TaskBulkResult {
  archived: number;
  deleted: number;
  skipped: number;
}

interface Row {
  id: string;
  number: number;
  title: string;
  archivedAt: Date | null;
  assigneeId: string | null;
  status: { value: string };
}

async function selectRows(db: Db, sel: TaskSelection): Promise<Row[]> {
  if (sel.ids && sel.ids.length > TASK_BULK_MAX_IDS) throw badRequest('TOO_MANY_IDS', `Выбрано больше ${TASK_BULK_MAX_IDS} задач`);
  if (!sel.ids && !sel.automationId) throw badRequest('EMPTY_SELECTION', 'Не выбрано ни одной задачи');
  return db.task.findMany({
    where: { deletedAt: null, ...(sel.ids ? { id: { in: [...new Set(sel.ids)] } } : {}), ...(sel.automationId ? { automationId: sel.automationId } : {}) },
    select: { id: true, number: true, title: true, archivedAt: true, assigneeId: true, status: { select: { value: true } } },
    orderBy: { number: 'asc' },
  });
}

/** Нетронутые задачи: нет комментариев людей и записей журнала от людей (автоматизация пишет с user_id NULL). */
export async function untouchedIds(db: Db, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT t.id::text FROM tasks t
    WHERE t.id = ANY(${ids}::uuid[])
      AND NOT EXISTS (SELECT 1 FROM task_comments c WHERE c.task_id = t.id AND c.author_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.entity = 'task' AND a.entity_id = t.id::text AND a.user_id IS NOT NULL)`;
  return new Set(rows.map((r) => r.id));
}

async function plan(db: Db, action: TaskBulkAction, sel: TaskSelection) {
  const rows = await selectRows(db, sel);
  const untouched = await untouchedIds(db, rows.map((r) => r.id));
  const candidates = rows.filter((r) => !sel.onlyUntouched || untouched.has(r.id));
  // Удаление пропускает задачи учебных писем и правил расписания (1.9.0) и продолжает с остальными.
  const linked: Map<string, unknown> = action === 'delete' ? await taskLetterLinks(db, candidates.map((r) => r.id)) : new Map();
  // И задачи автоматизаций контроля документов (1.11.0): удалить нельзя, архив — можно.
  if (action === 'delete') for (const [id, n] of await taskControlLinks(db, candidates.map((r) => r.id))) linked.set(id, n);
  const affected = action === 'archive' ? candidates.filter((r) => !r.archivedAt) : candidates.filter((r) => !linked.has(r.id));
  const statuses = await db.task.groupBy({ by: ['statusId'], where: { id: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
  const labels = new Map((await db.catalogItem.findMany({ where: { id: { in: statuses.map((s) => s.statusId) } }, select: { id: true, value: true, sortOrder: true } }))
    .map((i) => [i.id, i]));
  const preview: TaskBulkPreview = {
    total: rows.length,
    affected: affected.length,
    alreadyInState: action === 'archive' ? candidates.length - affected.length : 0,
    untouched: untouched.size,
    byStatus: statuses
      .map((s) => ({ statusId: s.statusId, label: labels.get(s.statusId)?.value ?? '?', count: s._count._all, order: labels.get(s.statusId)?.sortOrder ?? 0 }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...s }) => s),
    linkedToLetters: linked.size,
  };
  return { preview, affected };
}

export async function previewTaskBulk(db: Db, action: TaskBulkAction, sel: TaskSelection): Promise<TaskBulkPreview> {
  return (await plan(db, action, sel)).preview;
}

/** Проверка чисел предпросмотра без изменений — правило удаляется только если задачи совпали. */
export async function assertTaskBulkExpected(db: Db, action: TaskBulkAction, sel: TaskSelection, expected: { total: number; affected: number }) {
  const p = await plan(db, action, sel);
  if (p.preview.total !== expected.total || p.preview.affected !== expected.affected) {
    throw new AppError(409, 'BULK_CHANGED', 'Задачи изменились после предпросмотра — проверьте числа и подтвердите ещё раз', { preview: p.preview });
  }
  return p;
}

export async function applyTaskBulk(
  db: Db, actor: Actor, action: TaskBulkAction, sel: TaskSelection, expected: { total: number; affected: number },
  /** Сводная запись журнала: правило автоматизации (register_automation, id) или доска (task, 'board'). */
  summary: { label: string; entity: string; entityId: string },
): Promise<TaskBulkResult> {
  const p = await assertTaskBulkExpected(db, action, sel, expected);
  const done: string[] = [];
  for (let i = 0; i < p.affected.length; i += TASK_BULK_BATCH) {
    const batch = p.affected.slice(i, i + TASK_BULK_BATCH);
    await withTx(db, async (tx) => {
      const at = new Date();
      for (const t of batch) {
        if (action === 'archive') {
          const res = await tx.task.updateMany({ where: { id: t.id, deletedAt: null, archivedAt: null }, data: { archivedAt: at, version: { increment: 1 } } });
          if (!res.count) continue;
          await auditSettings(tx, actor, {
            action: 'task.archived', entity: 'task', entityId: t.id,
            summary: `Задача #${t.number} «${t.title}» отправлена в архив (${summary.label})`,
          });
        } else {
          const res = await tx.task.updateMany({ where: { id: t.id, deletedAt: null }, data: { deletedAt: at, version: { increment: 1 } } });
          if (!res.count) continue;
          await auditSettings(tx, actor, {
            action: 'task.deleted', entity: 'task', entityId: t.id,
            summary: `Задача #${t.number} «${t.title}» удалена (${summary.label})`,
            before: { title: t.title, status: t.status.value, assigneeId: t.assigneeId },
          });
        }
        done.push(t.id);
      }
    });
  }
  const result: TaskBulkResult = {
    archived: action === 'archive' ? done.length : 0,
    deleted: action === 'delete' ? done.length : 0,
    skipped: p.preview.total - done.length,
  };
  await auditSettings(db, actor, {
    action: `tasks.bulk_${action}`, entity: summary.entity, entityId: summary.entityId,
    summary: `${summary.label}: ${action === 'archive' ? 'в архив' : 'удалено'} задач — ${done.length}${sel.onlyUntouched ? ' (только нетронутые)' : ''}`,
    after: { count: done.length, taskIds: done, onlyUntouched: !!sel.onlyUntouched, automationId: sel.automationId ?? null },
  });
  return result;
}
