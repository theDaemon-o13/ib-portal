// Задачи (этап 5): доска, карточка, комментарии, архив и удаление, «Почта → задача».
// Права: всё — ib.work, удаление — tasks.delete (проверяет маршрут). История — из журнала аудита.
import type { Prisma } from '../../generated/prisma/client.js';
import { RECIPIENTS_CATALOG } from '../../lib/catalogs.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { parseMail, type ParsedMail } from '../../lib/mail-parse.js';
import { formatDateRu, isIsoDate } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { loadFullWorkCalendar } from '../calendar/service.js';
import { loadRegister } from '../registers/definition.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';
import { initialStatusId, recordTransition, statusIdOf, type StatusKey, type TransitionKind } from './flow.js';

export const TITLE_MAX = 300;
export const DESCRIPTION_MAX = 20_000;
export const COMMENT_MAX = 4000;
export const RAW_MAX = 100_000;
export const BOARD_LIMIT = 500;

export type TaskSource = 'manual' | 'mail' | 'automation' | 'document' | 'evidence';

const IB_WORK = { roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } } as const;

const itemBrief = { select: { id: true, value: true, color: true, systemKey: true } } as const;
const userBrief = { select: { id: true, fullName: true } } as const;
export const taskInclude = {
  status: itemBrief,
  priority: itemBrief,
  category: itemBrief,
  assignee: userBrief,
  creator: userBrief,
  record: { select: { id: true, registerId: true, number: true } },
  document: { select: { id: true, number: true } },
  evidence: { select: { id: true, number: true } },
  _count: { select: { comments: { where: { deletedAt: null } } } },
} as const;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

export function toTaskDto(t: TaskRow, today: string) {
  const due = t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null;
  const open = t.completedAt === null;
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    category: t.category,
    assignee: t.assignee,
    dueDate: due,
    /** Открытая задача со сроком раньше сегодня (архивные не просрочены — они не на доске). */
    overdue: open && t.archivedAt === null && due !== null && due < today,
    urgent: t.priority.systemKey === 'high',
    source: t.source as TaskSource,
    record: t.record,
    automationId: t.automationId,
    recipientLabel: t.recipientLabel,
    /** Задача по документу (этап 6): пересмотр или доработка. */
    document: t.document ? { ...t.document, reason: t.documentReason as 'review' | 'returned' } : null,
    evidence: t.evidence ? { ...t.evidence, reason: t.evidenceReason as 'rejected' | 'expiring' } : null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdBy: t.creator,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    archived: t.archivedAt !== null,
    commentCount: t._count.comments,
    version: t.version,
  };
}
export type TaskDto = ReturnType<typeof toTaskDto>;

// ---------------------------------------------------------------- справочники и люди

/** Системное значение справочника задач (статус «Backlog», категория «Почта», приоритет «Высокий»…). */
export async function systemItemId(db: Db, catalogCode: string, key: string): Promise<string> {
  const item = await db.catalogItem.findUnique({ where: { catalogCode_systemKey: { catalogCode, systemKey: key } }, select: { id: true } });
  if (!item) throw new Error(`нет системного значения ${catalogCode}.${key} — выполните seed`);
  return item.id;
}

async function catalogItem(db: Db, catalogCode: string, id: string, what: string, current?: string) {
  const item = await db.catalogItem.findFirst({ where: { id, catalogCode, deletedAt: null } });
  if (!item) throw badRequest('BAD_VALUE', `Нет такого значения: ${what}`);
  if (item.archivedAt && id !== current) throw badRequest('BAD_VALUE', `«${item.value}» в архиве — выберите другое значение: ${what}`);
  return item;
}

/** Ответственный — активный пользователь с ib.work. */
export async function assertAssignee(db: Db, userId: string, current?: string | null) {
  if (userId === current) return;
  const u = await db.user.findFirst({ where: { id: userId, isActive: true, ...IB_WORK }, select: { id: true } });
  if (!u) throw badRequest('BAD_ASSIGNEE', 'Ответственным может быть только активный сотрудник с доступом к разделам ИБ');
}

function checkDue(v: string | null | undefined) {
  if (v !== null && v !== undefined && !isIsoDate(v)) throw badRequest('BAD_DATE', 'Срок — дата в формате ГГГГ-ММ-ДД');
}

const dateOrNull = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00Z`) : null);

function cleanTitle(v: string): string {
  const t = trimmed(v);
  if (!t) throw badRequest('EMPTY_TITLE', 'Укажите название задачи');
  if (t.length > TITLE_MAX) throw badRequest('TOO_LONG', `Название — не длиннее ${TITLE_MAX} символов`);
  return t;
}

function cleanDescription(v: string): string {
  if (v.length > DESCRIPTION_MAX) throw badRequest('TOO_LONG', `Описание — не длиннее ${DESCRIPTION_MAX} символов`);
  return v.trim();
}

// ---------------------------------------------------------------- доска и карточка

export async function getTaskRow(db: Db, id: string) {
  const t = await db.task.findFirst({ where: { id, deletedAt: null }, include: taskInclude });
  if (!t) throw notFound('Задача');
  return t;
}

export interface TaskListQuery {
  archived: boolean;
  categoryId?: string;
  /** Только задачи, созданные правилом автоматизации (релиз 1.1.0). */
  automationId?: string;
  /** Только открытые просроченные (ссылка с дашборда и мониторинга). */
  overdue?: boolean;
  limit: number;
  cursor?: string;
}

export async function listTasks(db: Db, q: TaskListQuery) {
  const today = todayIso();
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const scope: Prisma.TaskWhereInput = { deletedAt: null, archivedAt: q.archived ? { not: null } : null };
  const where: Prisma.TaskWhereInput = {
    ...scope, ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.automationId ? { automationId: q.automationId } : {}),
    ...(q.overdue && !q.archived ? overdueTaskWhere(today) : {}),
  };
  const [rows, total, byCategory, archivedTotal, byAutomation] = await Promise.all([
    db.task.findMany({
      where,
      include: taskInclude,
      // Доска — ближний срок первым; архив — недавно архивированные первыми (архив растёт, показываются первые BOARD_LIMIT).
      orderBy: q.archived ? [{ archivedAt: 'desc' }, { number: 'desc' }] : [{ dueDate: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }],
      skip: offset,
      take: q.limit + 1,
    }),
    db.task.count({ where }),
    db.task.groupBy({ by: ['categoryId'], where: scope, _count: { _all: true } }),
    db.task.count({ where: { deletedAt: null, archivedAt: { not: null } } }),
    db.task.groupBy({ by: ['automationId'], where: { ...scope, automationId: { not: null } }, _count: { _all: true } }),
  ]);
  return {
    items: rows.slice(0, q.limit).map((t) => toTaskDto(t, today)),
    nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
    total,
    /** Для фильтров: сколько задач в каждой категории (в архиве или на доске). */
    categories: byCategory.map((c) => ({ categoryId: c.categoryId, count: c._count._all })),
    /** Для фильтра «Создано автоматизацией»: сколько задач у каждого правила (названия — в маршруте). */
    automations: byAutomation.flatMap((a) => (a.automationId ? [{ automationId: a.automationId, count: a._count._all }] : [])),
    archivedTotal,
  };
}

/** Открытая просроченная задача: не в архиве, не удалена, не выполнена, срок раньше сегодня. Одно правило для меню, списка и дашборда. */
export function overdueTaskWhere(today: string): Prisma.TaskWhereInput {
  return { deletedAt: null, archivedAt: null, completedAt: null, dueDate: { lt: new Date(`${today}T00:00:00Z`) } };
}

/** Счётчик в меню: открытые просроченные задачи отдела и мои. */
export async function taskSummary(db: Db, userId: string) {
  const overdue = overdueTaskWhere(todayIso());
  const [all, mine] = await Promise.all([db.task.count({ where: overdue }), db.task.count({ where: { ...overdue, assigneeId: userId } })]);
  return { overdue: all, overdueMine: mine };
}

/** Метки получателей задачи с их e-mail: сотрудник ИБ может написать им вручную (для справки: письма портал не отправляет). */
async function recipientsOf(db: Db, label: string | null) {
  if (!label) return [];
  const labels = label.split(', ').map((l) => l.trim()).filter(Boolean);
  const items = await db.catalogItem.findMany({ where: { catalogCode: RECIPIENTS_CATALOG, deletedAt: null }, select: { value: true, emails: true } });
  return labels.map((l) => ({ label: l, emails: items.find((i) => i.value.toLowerCase() === l.toLowerCase())?.emails ?? [] }));
}

export async function getTask(db: Db, id: string) {
  const t = await getTaskRow(db, id);
  const mail = await db.taskMailSource.findUnique({ where: { taskId: id }, include: { mailRule: { select: { id: true, value: true } } } });
  let record: { id: string; registerId: string; registerName: string; number: number; title: string } | null = null;
  if (t.record) {
    const reg = await loadRegister(db, t.record.registerId);
    const values = (await db.registerRecord.findUnique({ where: { id: t.record.id }, select: { values: true } }))?.values as Record<string, unknown> | undefined;
    const titleField = reg.fields.find((f) => f.isTitle);
    record = { ...t.record, registerName: reg.name, title: titleField && values ? String(values[titleField.id] ?? '') : '' };
  }
  return {
    ...toTaskDto(t, todayIso()),
    record,
    recipients: await recipientsOf(db, t.recipientLabel),
    mail: mail
      ? {
        from: mail.fromText, subject: mail.subject, sent: mail.sentText, body: mail.body,
        rule: mail.mailRule ? { id: mail.mailRule.id, label: mail.mailRule.value } : null, ruleHits: mail.ruleHits, dueReason: mail.dueReason,
      }
      : null,
  };
}

// ---------------------------------------------------------------- создание

export interface NewTaskInput {
  title: string;
  description?: string;
  categoryId?: string;
  priorityId?: string;
  assigneeId?: string | null;
  dueDate?: string | null;
  /** «Почта → задача»: исходный текст письма; категория — «Почта», правило и причина срока — из разбора. */
  mail?: { raw: string };
}

export async function createTask(db: Db, actor: Actor, input: NewTaskInput) {
  return withTx(db, async (tx) => {
    const title = cleanTitle(input.title);
    const description = cleanDescription(input.description ?? '');
    checkDue(input.dueDate);
    if (input.assigneeId) await assertAssignee(tx, input.assigneeId);
    let parsed: ParsedMail | null = null;
    if (input.mail) {
      if (!input.mail.raw.trim()) throw badRequest('EMPTY_MAIL', 'Вставьте текст письма');
      if (input.mail.raw.length > RAW_MAX) throw badRequest('TOO_LONG', `Письмо — не длиннее ${RAW_MAX} символов`);
      parsed = await parseWithRules(tx, input.mail.raw);
    }
    const categoryId = parsed
      ? await systemItemId(tx, 'task_categories', 'mail')
      : (await catalogItem(tx, 'task_categories', input.categoryId ?? '', 'категория')).id;
    const priorityId = input.priorityId
      ? (await catalogItem(tx, 'task_priorities', input.priorityId, 'приоритет')).id
      : await systemItemId(tx, 'task_priorities', parsed?.urgent ? 'high' : 'normal');
    const task = await tx.task.create({
      data: {
        title,
        description,
        statusId: await initialStatusId(tx, input.assigneeId),
        priorityId,
        categoryId,
        assigneeId: input.assigneeId ?? null,
        dueDate: dateOrNull(input.dueDate),
        source: parsed ? 'mail' : 'manual',
        createdBy: actor.id,
      },
      include: taskInclude,
    });
    await recordTransition(tx, { taskId: task.id, from: null, to: task.statusId, actorId: actor.id, kind: 'process' });
    if (parsed && input.mail) {
      const dueChanged = (input.dueDate ?? null) !== parsed.due;
      await tx.taskMailSource.create({
        data: {
          taskId: task.id, fromText: parsed.from.slice(0, 500), subject: parsed.subject.slice(0, 1000), sentText: parsed.sent.slice(0, 200),
          body: parsed.body, raw: input.mail.raw, mailRuleId: parsed.rule?.id ?? null, ruleHits: parsed.rule?.hits ?? [],
          dueReason: dueChanged ? `${parsed.dueReason}; срок изменён при создании` : parsed.dueReason,
        },
      });
    }
    await auditSettings(tx, actor, {
      action: 'task.created', entity: 'task', entityId: task.id,
      summary: `Задача #${task.number} «${title}» создана${parsed ? ' из письма' : ''}`,
      after: { title, source: task.source, categoryId, priorityId, assigneeId: task.assigneeId, dueDate: input.dueDate ?? null },
    });
    return toTaskDto(task, todayIso());
  });
}

// ---------------------------------------------------------------- «Почта → задача»: черновик

async function parseWithRules(db: Db, raw: string) {
  const rules = await db.catalogItem.findMany({
    where: { catalogCode: 'mail_rules', deletedAt: null, archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { value: 'asc' }],
    select: { id: true, value: true, keywords: true, ownerUserId: true },
  });
  return parseMail(raw, {
    today: todayIso(),
    calendar: await loadFullWorkCalendar(db),
    rules: rules.map((r) => ({ id: r.id, label: r.value, keywords: r.keywords, ownerUserId: r.ownerUserId })),
  });
}

/** Разбор письма без сохранения: пользователь проверяет черновик и только потом создаёт задачу. */
export async function mailDraft(db: Db, raw: string) {
  if (!raw.trim()) throw badRequest('EMPTY_MAIL', 'Вставьте текст письма');
  if (raw.length > RAW_MAX) throw badRequest('TOO_LONG', `Письмо — не длиннее ${RAW_MAX} символов`);
  const p = await parseWithRules(db, raw);
  // Ответственный правила — только если он по-прежнему сотрудник ИБ.
  const owner = p.rule?.ownerUserId
    ? await db.user.findFirst({ where: { id: p.rule.ownerUserId, isActive: true, ...IB_WORK }, select: { id: true, fullName: true } })
    : null;
  return {
    from: p.from, subject: p.subject, sent: p.sent, body: p.body, title: p.title,
    dueDate: p.due, dueReason: p.dueReason, urgent: p.urgent,
    priorityId: await systemItemId(db, 'task_priorities', p.urgent ? 'high' : 'normal'),
    categoryId: await systemItemId(db, 'task_categories', 'mail'),
    rule: p.rule ? { id: p.rule.id, label: p.rule.label, hits: p.rule.hits } : null,
    assignee: owner,
    assigneeReason: p.rule
      ? owner
        ? `по правилу «${p.rule.label}»: ${p.rule.hits.join(', ')}`
        : `правило «${p.rule.label}» без ответственного сотрудника ИБ — выберите сами`
      : 'ни одно правило не подошло — выберите сами',
  };
}

// ---------------------------------------------------------------- правка

export interface TaskPatch {
  version: number;
  title?: string;
  description?: string;
  statusId?: string;
  priorityId?: string;
  categoryId?: string;
  assigneeId?: string | null;
  dueDate?: string | null;
}

interface Change { field: string; label: string; from: string; to: string }

function assertActive(t: { archivedAt: Date | null; number: number }) {
  if (t.archivedAt) throw conflict('TASK_ARCHIVED', `Задача #${t.number} в архиве. Верните её на доску, чтобы изменить`);
}

export async function updateTask(db: Db, actor: Actor, id: string, input: TaskPatch) {
  return withTx(db, async (tx) => {
    const t = await getTaskRow(tx, id);
    assertActive(t);
    if (t.version !== input.version) throw versionConflict();
    const data: Prisma.TaskUncheckedUpdateManyInput = {};
    const changes: Change[] = [];
    const show = (v: string | null | undefined) => v ?? '—';
    if (input.title !== undefined) {
      const title = cleanTitle(input.title);
      if (title !== t.title) {
        data.title = title;
        changes.push({ field: 'title', label: 'Название', from: t.title, to: title });
      }
    }
    if (input.description !== undefined) {
      const d = cleanDescription(input.description);
      if (d !== t.description) {
        data.description = d;
        changes.push({ field: 'description', label: 'Описание', from: t.description ? 'было' : '—', to: d ? 'изменено' : '—' });
      }
    }
    for (const [key, catalog, label] of [['statusId', 'task_statuses', 'Статус'], ['priorityId', 'task_priorities', 'Приоритет'], ['categoryId', 'task_categories', 'Категория']] as const) {
      const v = input[key];
      if (v === undefined || v === t[key]) continue;
      const item = await catalogItem(tx, catalog, v, label.toLowerCase());
      data[key] = item.id;
      const before = key === 'statusId' ? t.status : key === 'priorityId' ? t.priority : t.category;
      changes.push({ field: key, label, from: before.value, to: item.value });
      if (key === 'statusId') {
        // «Выполнено» закрывает задачу; уход из «Выполнено» открывает снова.
        if (item.systemKey === 'done' && !t.completedAt) data.completedAt = new Date();
        if (item.systemKey !== 'done' && t.completedAt) data.completedAt = null;
      }
    }
    if (input.assigneeId !== undefined && input.assigneeId !== t.assigneeId) {
      let name: string | null = null;
      if (input.assigneeId) {
        await assertAssignee(tx, input.assigneeId);
        name = (await tx.user.findUnique({ where: { id: input.assigneeId }, select: { fullName: true } }))?.fullName ?? null;
      }
      data.assigneeId = input.assigneeId;
      changes.push({ field: 'assigneeId', label: 'Ответственный', from: show(t.assignee?.fullName), to: show(name) });
    }
    if (input.dueDate !== undefined) {
      checkDue(input.dueDate);
      const before = t.dueDate?.toISOString().slice(0, 10) ?? null;
      if ((input.dueDate ?? null) !== before) {
        data.dueDate = dateOrNull(input.dueDate);
        changes.push({ field: 'dueDate', label: 'Срок', from: before ? formatDateRu(before) : '—', to: input.dueDate ? formatDateRu(input.dueDate) : '—' });
      }
    }
    // Исполнитель определяет колонку (ADR-0022): назначили — «Поставленные», сняли — Backlog;
    // смена исполнителя у задачи «В работе» / «На проверке» — снова «Поставленные», новый исполнитель берёт её сам.
    let transition: TransitionKind | null = data.statusId !== undefined ? 'override' : null;
    if (transition === null && data.assigneeId !== undefined) {
      const key = t.status.systemKey;
      const next: StatusKey | null = data.assigneeId
        ? (key === 'new' || key === 'work' || key === 'review' ? 'assigned' : null)
        : (key === 'assigned' || key === 'work' || key === 'review' ? 'new' : null);
      if (next) {
        const to = await statusIdOf(tx, next);
        data.statusId = to;
        const toName = (await tx.catalogItem.findUniqueOrThrow({ where: { id: to }, select: { value: true } })).value;
        changes.push({ field: 'statusId', label: 'Статус', from: t.status.value, to: toName });
        transition = 'assign';
      }
    }
    if (changes.length) {
      const res = await tx.task.updateMany({ where: { id, version: input.version, deletedAt: null }, data: { ...data, version: { increment: 1 } } });
      await ensureVersioned(res.count, () => tx.task.findFirst({ where: { id, deletedAt: null } }), 'Задача');
      if (transition && typeof data.statusId === 'string') {
        await recordTransition(tx, { taskId: id, from: t.statusId, to: data.statusId, actorId: actor.id, kind: transition });
      }
      await auditSettings(tx, actor, {
        action: 'task.updated', entity: 'task', entityId: id,
        summary: `Задача #${t.number}: ${changes.map((c) => `«${c.label}»`).join(', ')}`,
        after: { changes },
      });
    }
    return toTaskDto(await getTaskRow(tx, id), todayIso());
  });
}

export async function setTaskArchived(db: Db, actor: Actor, id: string, version: number, archived: boolean) {
  return withTx(db, async (tx) => {
    const t = await getTaskRow(tx, id);
    if ((t.archivedAt !== null) === archived) {
      if (t.version !== version) throw versionConflict();
      return toTaskDto(t, todayIso());
    }
    const res = await tx.task.updateMany({ where: { id, version, deletedAt: null }, data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.task.findFirst({ where: { id, deletedAt: null } }), 'Задача');
    await auditSettings(tx, actor, {
      action: archived ? 'task.archived' : 'task.restored', entity: 'task', entityId: id,
      summary: `Задача #${t.number} «${t.title}» ${archived ? 'отправлена в архив' : 'возвращена на доску'}`,
    });
    return toTaskDto(await getTaskRow(tx, id), todayIso());
  });
}

/** Удаление мягкое (deleted_at), только по праву «Задачи: удаление»; запись в журнале остаётся. */
export async function deleteTask(db: Db, actor: Actor, id: string, version: number) {
  await withTx(db, async (tx) => {
    const t = await getTaskRow(tx, id);
    const res = await tx.task.updateMany({ where: { id, version, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.task.findFirst({ where: { id, deletedAt: null } }), 'Задача');
    await auditSettings(tx, actor, {
      action: 'task.deleted', entity: 'task', entityId: id,
      summary: `Задача #${t.number} «${t.title}» удалена`,
      before: { title: t.title, status: t.status.value, assigneeId: t.assigneeId },
    });
  });
}

// ---------------------------------------------------------------- комментарии и история

export async function listComments(db: Db, taskId: string) {
  await getTaskRow(db, taskId);
  const rows = await db.taskComment.findMany({
    where: { taskId, deletedAt: null },
    include: { author: userBrief },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((c) => ({ id: c.id, body: c.body, author: c.author, automatic: c.eventId !== null, createdAt: c.createdAt.toISOString() }));
}

export async function addComment(db: Db, actor: Actor, taskId: string, body: string) {
  return withTx(db, async (tx) => {
    const t = await getTaskRow(tx, taskId);
    assertActive(t);
    const text = body.trim();
    if (!text) throw badRequest('EMPTY_COMMENT', 'Напишите комментарий');
    if (text.length > COMMENT_MAX) throw badRequest('TOO_LONG', `Комментарий — не длиннее ${COMMENT_MAX} символов`);
    const c = await tx.taskComment.create({ data: { taskId, authorId: actor.id, body: text }, include: { author: userBrief } });
    await auditSettings(tx, actor, {
      action: 'task.commented', entity: 'task', entityId: taskId,
      summary: `Задача #${t.number}: комментарий`,
      after: { commentId: c.id },
    });
    return { id: c.id, body: c.body, author: c.author, automatic: false, createdAt: c.createdAt.toISOString() };
  });
}

export async function taskHistory(db: Db, taskId: string) {
  await getTaskRow(db, taskId);
  const rows = await db.auditLog.findMany({
    where: { entity: 'task', entityId: taskId },
    include: { user: { select: { fullName: true, login: true } } },
    orderBy: { id: 'desc' },
    take: 200,
  });
  return rows.map((r) => {
    const diff = (r.diff ?? {}) as { summary?: string; after?: { changes?: Change[] } };
    return {
      id: r.id.toString(),
      at: r.at.toISOString(),
      actor: r.user,
      action: r.action,
      summary: diff.summary ?? r.action,
      changes: (diff.after?.changes ?? []).map((c) => ({ label: c.label, from: c.from, to: c.to })),
    };
  });
}
