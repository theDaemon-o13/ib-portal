// События автоматизаций → задачи (этап 5, docs/concept.md — «Получатели»).
// Вызывается внутри прогона автоматизаций, под его advisory-блокировкой и в той же транзакции:
// событие становится «обработано» вместе с созданием задач, поэтому повторная обработка дублей не даёт.
import type { Prisma } from '../../generated/prisma/client.js';
import { RECIPIENTS_CATALOG, SYSTEM_OWNER_KEY, SYSTEMS_CATALOG } from '../../lib/catalogs.js';
import type { Db } from '../../lib/db.js';
import { formatDateRu, isIsoDate, type Values } from '../../lib/register-values.js';
import { addDaysIso } from '../../lib/today.js';
import { addWorkingDays, isoDate, parseIsoDate, type WorkCalendar } from '../../lib/working-days.js';
import { digestTitle } from '../automations/conditions.js';
import { deadlineField, dateOf, isClosed, loadRegister, type RegisterDef } from '../registers/definition.js';
import { systemItemId, TITLE_MAX } from './service.js';

type EventType = 'remind' | 'notify' | 'escalate';
type SnapshotRecipient = { kind: 'user'; userId: string; name: string } | { kind: 'label'; label: string; itemId?: string | null };

const TITLE_PREFIX: Record<EventType, string> = { remind: 'Напоминание', notify: 'Уведомление', escalate: 'Эскалация' };
/** Срок задачи: напоминание — к сроку записи; уведомление — 3 рабочих дня; эскалация — 1 рабочий день. */
const DUE_WORKDAYS: Record<EventType, number> = { remind: 3, notify: 3, escalate: 1 };

export interface RuleText {
  when: string;
  then: string;
}

export interface EventTasksResult {
  events: number;
  created: number;
  commented: number;
}

const IB_WORK = { roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } } as const;

/** Поле «Система» записи: первое неархивное поле «Значение справочника» из справочника «Системы». */
function systemFieldOf(reg: RegisterDef) {
  return reg.fields.find((f) => !f.archived && f.type === 'catalog' && f.catalogCode === SYSTEMS_CATALOG);
}

/**
 * Событие реестра: реестр, запись и правило заданы всегда. У события документа (пересмотр, ADR-0010)
 * их нет — такие события сюда не попадают (выборки идут по реестру или записи).
 */
export function registerEvent<E extends { registerId: string | null; recordId: string | null; automationId: string | null; record: unknown; automation: unknown }>(e: E) {
  const { registerId, recordId, automationId, record, automation } = e;
  if (registerId === null || recordId === null || automationId === null || record === null || automation === null) {
    throw new Error(`событие ${String((e as { id?: string }).id)} не относится к реестру`);
  }
  return { ...e, registerId, recordId, automationId, record: record as NonNullable<E['record']>, automation: automation as NonNullable<E['automation']> };
}

export async function tasksFromEvents(
  tx: Db,
  opts: { registerId?: string; today: string; calendar: WorkCalendar; describe: (reg: RegisterDef, rule: { condition: unknown; action: unknown }) => RuleText },
): Promise<EventTasksResult> {
  const events = await tx.automationEvent.findMany({
    // События документов (пересмотр) обрабатывает modules/documents/review.ts.
    where: { status: 'new', documentId: null, evidenceId: null, ...(opts.registerId ? { registerId: opts.registerId } : {}) },
    include: { automation: true, record: { select: { id: true, number: true, values: true, archivedAt: true, deletedAt: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const result: EventTasksResult = { events: events.length, created: 0, commented: 0 };
  if (!events.length) return result;

  const [statusNew, category, normal, high] = await Promise.all([
    systemItemId(tx, 'task_statuses', 'new'),
    systemItemId(tx, 'task_categories', 'register'),
    systemItemId(tx, 'task_priorities', 'normal'),
    systemItemId(tx, 'task_priorities', 'high'),
  ]);
  // Кому можно поставить задачу: активные пользователи с ib.work (проверяется в момент обработки).
  const ibUsers = new Set((await tx.user.findMany({ where: { isActive: true, ...IB_WORK }, select: { id: true } })).map((u) => u.id));
  const labels = await tx.catalogItem.findMany({
    where: { catalogCode: RECIPIENTS_CATALOG, deletedAt: null },
    select: { id: true, value: true, systemKey: true, members: { select: { userId: true } } },
  });
  // Метка — только по id (ADR-0005); событие без id (до перехода на id) — «получатель не найден», задача без ответственного.
  const labelOf = (r: { itemId?: string | null }) => (r.itemId ? labels.find((x) => x.id === r.itemId) : undefined);
  const registers = new Map<string, RegisterDef>();
  const work = (n: number) => isoDate(addWorkingDays(parseIsoDate(opts.today), n, opts.calendar));
  const now = new Date();

  /** Получатели → ответственные (null — «не назначен»), с метками для карточки задачи. */
  const resolveTargets = (recipients: SnapshotRecipient[], systemOwner: string | null) => {
    const targets = new Map<string | null, Set<string>>();
    const add = (userId: string | null, label: string) => {
      const set = targets.get(userId) ?? new Set<string>();
      set.add(label);
      targets.set(userId, set);
    };
    for (const r of recipients) {
      if (r.kind === 'user') {
        if (ibUsers.has(r.userId)) add(r.userId, r.name);
        else add(null, r.name);
        continue;
      }
      const item = labelOf(r);
      if (item?.systemKey === SYSTEM_OWNER_KEY) {
        if (systemOwner && ibUsers.has(systemOwner)) add(systemOwner, item.value);
        else add(null, item.value);
        continue;
      }
      const members = (item?.members ?? []).map((m) => m.userId).filter((id) => ibUsers.has(id));
      if (members.length) for (const id of members) add(id, item?.value ?? r.label);
      else add(null, item?.value ?? r.label);
    }
    return targets;
  };

  for (const row of events) {
    if (row.recordId === null && row.registerId !== null && row.automationId !== null && row.automation !== null) {
      // Сводное событие правила по реестру (этап 8б, «Продление разрешений»): одна задача со списком записей.
      let reg = registers.get(row.registerId);
      if (!reg) {
        reg = await loadRegister(tx, row.registerId);
        registers.set(row.registerId, reg);
      }
      const r = await digestTask(tx, reg, {
        id: row.id, automationId: row.automationId, automation: row.automation, eventType: row.eventType as EventType,
        triggerKey: row.triggerKey, fireAt: row.fireAt.toISOString().slice(0, 10),
        targets: resolveTargets(row.recipients as unknown as SnapshotRecipient[], null),
      }, { ...opts, statusNew, category, normal, high, work, rule: opts.describe(reg, { condition: row.automation.condition, action: row.automation.action }) });
      result.created += r.created;
      result.commented += r.commented;
      await tx.automationEvent.updateMany({ where: { id: row.id, status: 'new' }, data: { status: 'processed', processedAt: now } });
      continue;
    }
    const e = registerEvent(row);
    const done = () => tx.automationEvent.updateMany({ where: { id: e.id, status: 'new' }, data: { status: 'processed', processedAt: now } });
    // Запись успели удалить или убрать в архив — задача уже не нужна.
    if (e.record.deletedAt || e.record.archivedAt) {
      await done();
      continue;
    }
    let reg = registers.get(e.registerId);
    if (!reg) {
      reg = await loadRegister(tx, e.registerId);
      registers.set(e.registerId, reg);
    }
    const values = e.record.values as Values;
    const systemField = systemFieldOf(reg);
    const systemItemIdOfRecord = systemField ? values[systemField.id] : undefined;
    const systemOwner = typeof systemItemIdOfRecord === 'string'
      ? (await tx.catalogItem.findUnique({ where: { id: systemItemIdOfRecord }, select: { ownerUserId: true } }))?.ownerUserId ?? null
      : null;

    // Получатели → ответственные. null — «не назначен»: метка без пользователей, только e-mail,
    // владелец системы без ib.work или не задан. Метки собираются для карточки.
    const targets = resolveTargets(e.recipients as unknown as SnapshotRecipient[], systemOwner);

    const type = e.eventType as EventType;
    const rule = opts.describe(reg, { condition: e.automation.condition, action: e.automation.action });
    const titleField = reg.fields.find((f) => f.isTitle);
    const recordTitle = titleField ? String(values[titleField.id] ?? '').trim() : '';
    const fireAt = e.fireAt.toISOString().slice(0, 10);
    const custom = (e.automation.action as { title?: string }).title;
    const head = custom ? digestTitle(custom, e.fireAt.toISOString().slice(0, 10)) : `${TITLE_PREFIX[type]}: ${rule.when}`;
    const title = `${head} — #${e.record.number}${recordTitle ? ` ${recordTitle}` : ''}`.slice(0, TITLE_MAX);
    const due = type === 'remind' && isIsoDate(e.triggerKey) && e.triggerKey >= opts.today ? e.triggerKey : work(DUE_WORKDAYS[type]);

    for (const [assigneeId, labelSet] of targets) {
      const recipientLabel = [...labelSet].join(', ').slice(0, 500);
      const open = await tx.task.findFirst({
        where: { automationId: e.automationId, recordId: e.recordId, assigneeId, completedAt: null, archivedAt: null, deletedAt: null },
        select: { id: true, number: true },
      });
      if (open) {
        // По той же записи и правилу задача ещё открыта — повторное срабатывание в неё комментарием.
        await tx.taskComment.create({
          data: { taskId: open.id, eventId: e.id, body: `Повторное срабатывание ${fireAt}: ${rule.when} → ${rule.then}` },
        });
        await tx.automationEventTask.create({ data: { eventId: e.id, taskId: open.id, action: 'commented' } });
        await tx.auditLog.create({
          data: {
            userId: null, action: 'task.commented', entity: 'task', entityId: open.id,
            diff: { summary: `Задача #${open.number}: повторное событие автоматизации`, after: { eventId: e.id } } as Prisma.InputJsonValue,
          },
        });
        result.commented++;
        continue;
      }
      const task = await tx.task.create({
        data: {
          title,
          description: `Реестр «${reg.name}», запись #${e.record.number}${recordTitle ? ` «${recordTitle}»` : ''}.\nПравило: ${rule.when} → ${rule.then}.\nСработало: ${fireAt}.`,
          statusId: statusNew,
          priorityId: type === 'remind' ? normal : high,
          categoryId: category,
          assigneeId,
          dueDate: new Date(`${due}T00:00:00Z`),
          source: 'automation',
          recordId: e.recordId,
          automationId: e.automationId,
          recipientLabel,
        },
        select: { id: true, number: true },
      });
      await tx.automationEventTask.create({ data: { eventId: e.id, taskId: task.id, action: 'created' } });
      await tx.auditLog.create({
        data: {
          userId: null, action: 'task.created', entity: 'task', entityId: task.id,
          diff: {
            summary: `Задача #${task.number} создана автоматизацией: ${rule.when} → ${rule.then}${assigneeId ? '' : ' (ответственный не назначен)'}`,
            after: { source: 'automation', eventId: e.id, recordId: e.recordId, recipientLabel },
          } as Prisma.InputJsonValue,
        },
      });
      result.created++;
    }
    await done();
  }
  return result;
}

/** Строк списка в сводной задаче (остальное — «и ещё N»). */
export const DIGEST_LINES_MAX = 300;

/**
 * Сводная задача правила по реестру: список открытых записей (по статусам из условия) с заголовком, статусом и сроком.
 * Открытая сводная задача того же правила и ответственного — дополняется комментарием.
 */
async function digestTask(
  tx: Db, reg: RegisterDef,
  e: { id: string; automationId: string; automation: { condition: Prisma.JsonValue; action: Prisma.JsonValue }; eventType: EventType; triggerKey: string; fireAt: string; targets: Map<string | null, Set<string>> },
  ctx: { today: string; calendar: WorkCalendar; statusNew: string; category: string; normal: string; high: string; work: (n: number) => string; rule: RuleText },
): Promise<{ created: number; commented: number }> {
  const cond = e.automation.condition as { statusOptionIds?: string[] };
  const action = e.automation.action as { title?: string };
  const status = reg.fields.find((f) => f.isStatus);
  const title = reg.fields.find((f) => f.isTitle);
  const deadline = deadlineField(reg);
  const rows = (await tx.registerRecord.findMany({
    where: { registerId: reg.id, deletedAt: null, archivedAt: null }, select: { number: true, values: true }, orderBy: { number: 'asc' },
  })).filter((r) => {
    const v = r.values as Values;
    if (cond.statusOptionIds?.length) return !!status && cond.statusOptionIds.includes(String(v[status.id] ?? ''));
    return !isClosed(reg, v);
  });
  const lines = rows.slice(0, DIGEST_LINES_MAX).map((r) => {
    const v = r.values as Values;
    const st = status?.options.find((o) => o.id === v[status.id])?.label;
    const due = deadline ? dateOf(reg, deadline, v, ctx.calendar) : null;
    return `#${r.number}${title && v[title.id] ? ` ${String(v[title.id])}` : ''}${st ? ` — ${st}` : ''}${due ? `, до ${formatDateRu(due)}` : ''}`;
  });
  if (rows.length > lines.length) lines.push(`… и ещё ${rows.length - lines.length}`);
  const taskTitle = (action.title ? digestTitle(action.title, e.triggerKey) : `${TITLE_PREFIX[e.eventType]}: ${ctx.rule.when}`).slice(0, TITLE_MAX);
  const description = `Реестр «${reg.name}». Правило: ${ctx.rule.when} → ${ctx.rule.then}.\nСработало: ${e.fireAt}. Записей: ${rows.length}.\n\n${lines.join('\n') || 'Записей нет.'}`.slice(0, 20000);
  const due = e.eventType === 'remind' ? addDaysIso(ctx.today, 30) : ctx.work(DUE_WORKDAYS[e.eventType]);
  const out = { created: 0, commented: 0 };
  for (const [assigneeId, labelSet] of e.targets) {
    const recipientLabel = [...labelSet].join(', ').slice(0, 500);
    const open = await tx.task.findFirst({
      where: { automationId: e.automationId, recordId: null, assigneeId, completedAt: null, archivedAt: null, deletedAt: null },
      select: { id: true, number: true },
    });
    if (open) {
      await tx.taskComment.create({ data: { taskId: open.id, eventId: e.id, body: `Повторное срабатывание ${e.fireAt}.\n${description}`.slice(0, 20000) } });
      await tx.automationEventTask.create({ data: { eventId: e.id, taskId: open.id, action: 'commented' } });
      out.commented++;
      continue;
    }
    const task = await tx.task.create({
      data: {
        title: taskTitle, description, statusId: ctx.statusNew, priorityId: e.eventType === 'remind' ? ctx.normal : ctx.high, categoryId: ctx.category,
        assigneeId, dueDate: new Date(`${due}T00:00:00Z`), source: 'automation', recordId: null, automationId: e.automationId, recipientLabel,
      },
      select: { id: true, number: true },
    });
    await tx.automationEventTask.create({ data: { eventId: e.id, taskId: task.id, action: 'created' } });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'task.created', entity: 'task', entityId: task.id,
        diff: {
          summary: `Задача #${task.number} создана автоматизацией: ${taskTitle} (записей ${rows.length})${assigneeId ? '' : ' (ответственный не назначен)'}`,
          after: { source: 'automation', eventId: e.id, registerId: reg.id, recipientLabel },
        } as Prisma.InputJsonValue,
      },
    });
    out.created++;
  }
  return out;
}
