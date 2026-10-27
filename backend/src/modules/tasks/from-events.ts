// События автоматизаций → задачи (этап 5, docs/concept.md — «Получатели»).
// Вызывается внутри прогона автоматизаций, под его advisory-блокировкой и в той же транзакции:
// событие становится «обработано» вместе с созданием задач, поэтому повторная обработка дублей не даёт.
import type { Prisma } from '@prisma/client';
import { RECIPIENTS_CATALOG, SYSTEM_OWNER_KEY, SYSTEMS_CATALOG } from '../../lib/catalogs.js';
import type { Db } from '../../lib/db.js';
import { isIsoDate, type Values } from '../../lib/register-values.js';
import { addWorkingDays, isoDate, parseIsoDate, type WorkCalendar } from '../../lib/working-days.js';
import { loadRegister, type RegisterDef } from '../registers/definition.js';
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

export async function tasksFromEvents(
  tx: Db,
  opts: { registerId?: string; today: string; calendar: WorkCalendar; describe: (reg: RegisterDef, rule: { condition: unknown; action: unknown }) => RuleText },
): Promise<EventTasksResult> {
  const events = await tx.automationEvent.findMany({
    where: { status: 'new', ...(opts.registerId ? { registerId: opts.registerId } : {}) },
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
  // Метка — по id (ADR-0005); события до перехода на id несут только название.
  const labelOf = (r: { label: string; itemId?: string | null }) =>
    (r.itemId !== undefined ? labels.find((x) => x.id === r.itemId) : labels.find((x) => x.value.toLowerCase() === r.label.toLowerCase()));
  const registers = new Map<string, RegisterDef>();
  const work = (n: number) => isoDate(addWorkingDays(parseIsoDate(opts.today), n, opts.calendar));
  const now = new Date();

  for (const e of events) {
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
    const targets = new Map<string | null, Set<string>>();
    const add = (userId: string | null, label: string) => {
      const set = targets.get(userId) ?? new Set<string>();
      set.add(label);
      targets.set(userId, set);
    };
    for (const r of e.recipients as unknown as SnapshotRecipient[]) {
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

    const type = e.eventType as EventType;
    const rule = opts.describe(reg, { condition: e.automation.condition, action: e.automation.action });
    const titleField = reg.fields.find((f) => f.isTitle);
    const recordTitle = titleField ? String(values[titleField.id] ?? '').trim() : '';
    const fireAt = e.fireAt.toISOString().slice(0, 10);
    const title = `${TITLE_PREFIX[type]}: ${rule.when} — #${e.record.number}${recordTitle ? ` ${recordTitle}` : ''}`.slice(0, TITLE_MAX);
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
