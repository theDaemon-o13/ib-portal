// Правила автоматизации реестров и их события (право registers.manage на правила, records.edit — отметить событие).
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { basisOf, isBasisRule } from '../../lib/link-basis.js';
import { isDueRule, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { loadFullWorkCalendar } from '../calendar/service.js';
import {
  assertNotArchived,
  dateOf,
  isClosed,
  loadRegister,
  loadUsers,
  type FieldMeta,
  type RegisterDef,
} from '../registers/definition.js';
import { auditSettings, ensureVersioned, type Actor } from '../settings/common.js';
import { RECIPIENTS_CATALOG } from '../../lib/catalogs.js';
import { runDocumentReviews } from '../documents/review.js';
import { runEvidenceExpiry } from '../evidence/expiry.js';
import { sweepOrphanFiles } from '../files/links.js';
import { registerEvent, tasksFromEvents } from '../tasks/from-events.js';
import { loadBasisSources, linkIdsIn, linkLabels, loadLinkRefs } from '../registers/links.js';
import { lockErrors } from '../registers/record-rules.js';
import { searchTextOf, userIdsIn } from '../registers/definition.js';
import {
  EVENT_TYPE_NAMES,
  evaluate,
  evaluateYearly,
  isSetOption,
  type Action,
  type Condition,
  type EventType,
  type Recipient,
  type SetOptionAction,
  type TaskAction,
} from './conditions.js';

export const MAX_RECIPIENTS = 6;

// ---------------------------------------------------------------- проверка и описание

const isDateField = (f: FieldMeta) => f.type === 'date' || (f.type === 'calc' && !!isDueRule(f.calcRule));

function liveField(reg: RegisterDef, id: string | null | undefined): FieldMeta | undefined {
  return id ? reg.fields.find((f) => f.id === id && !f.archived) : undefined;
}

/** Что можно выбрать получателем: метки справочника и сотрудники с ib.work. */
export interface RecipientChoices {
  labels: readonly { id: string; value: string; archived: boolean }[];
  users: ReadonlyMap<string, string>;
}

/** Названия меток получателей по id (неудалённые, и архивные): правила ссылаются на метку по id (ADR-0005). */
export type LabelNames = ReadonlyMap<string, string>;

export async function loadLabels(db: Db): Promise<LabelNames> {
  const rows = await db.catalogItem.findMany({ where: { catalogCode: RECIPIENTS_CATALOG, deletedAt: null }, select: { id: true, value: true } });
  return new Map(rows.map((r) => [r.id, r.value]));
}

export async function recipientChoices(db: Db): Promise<RecipientChoices> {
  const [labels, users] = await Promise.all([
    db.catalogItem.findMany({ where: { catalogCode: RECIPIENTS_CATALOG, deletedAt: null }, select: { id: true, value: true, archivedAt: true } }),
    db.user.findMany({
      where: { isActive: true, roles: { some: { role: { permissions: { some: { permissionCode: 'ib.work' } } } } } },
      select: { id: true, fullName: true },
    }),
  ]);
  return { labels: labels.map((l) => ({ id: l.id, value: l.value, archived: l.archivedAt !== null })), users: new Map(users.map((u) => [u.id, u.fullName])) };
}

/** Ежегодное условие: настоящая дата (29.02 — нет: не каждый год). */
function validDayMonth(month: number, day: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return false;
  return day <= ([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0);
}

/** «Установить значение»: поле-список записи, новое значение и значения, из которых оно ставится. */
function validateSetOption(reg: RegisterDef, a: SetOptionAction): SetOptionAction {
  const f = liveField(reg, a.fieldId);
  if (!f || f.type !== 'select') throw badRequest('BAD_RULE', 'Значение ставится только полю-списку');
  const to = f.options.find((o) => o.id === a.optionId && !o.archived);
  if (!to) throw badRequest('BAD_RULE', 'Выберите значение, которое поставить');
  const from = [...new Set(a.fromOptionIds)];
  if (!from.length || from.some((id) => id === to.id || !f.options.some((o) => o.id === id))) {
    throw badRequest('BAD_RULE', 'Выберите, из каких значений его ставить (кроме самого значения)');
  }
  return { eventType: 'set_option', fieldId: f.id, optionId: to.id, fromOptionIds: from, recipients: [] };
}

export function validateRule(
  reg: RegisterDef, condition: Condition, action: Action, choices: RecipientChoices, before?: Action,
): { condition: Condition; action: Action } {
  let cond: Condition;
  const field = 'fieldId' in condition ? liveField(reg, condition.fieldId) : undefined;
  switch (condition.kind) {
    case 'before': {
      if (!field || !isDateField(field)) throw badRequest('BAD_RULE', 'Выберите поле-дату или вычисляемый срок');
      if (!Number.isInteger(condition.days) || condition.days < 0 || condition.days > 365) throw badRequest('BAD_RULE', 'За сколько дней — целое число от 0 до 365');
      cond = { kind: 'before', fieldId: field.id, days: condition.days, ...(condition.skipYearEnd ? { skipYearEnd: true } : {}) };
      break;
    }
    case 'yearly': {
      if (!validDayMonth(condition.month, condition.day)) throw badRequest('BAD_RULE', 'Укажите день и месяц (29 февраля — нельзя)');
      const status = reg.fields.find((f) => f.isStatus);
      const ids = [...new Set(condition.statusOptionIds ?? [])];
      if (ids.some((id) => !status?.options.some((o) => o.id === id))) throw badRequest('BAD_RULE', 'Статусы — значения поля статуса');
      cond = { kind: 'yearly', month: condition.month, day: condition.day, ...(ids.length ? { statusOptionIds: ids } : {}) };
      break;
    }
    case 'basis_missing': {
      if (!field || field.type !== 'calc' || !isBasisRule(field.calcRule)) throw badRequest('BAD_RULE', 'Выберите вычисляемое поле «статус основания»');
      cond = { kind: 'basis_missing', fieldId: field.id };
      break;
    }
    case 'overdue': {
      if (!field || !isDateField(field)) throw badRequest('BAD_RULE', 'Выберите поле-дату или вычисляемый срок');
      cond = { kind: 'overdue', fieldId: field.id };
      if (condition.workdays !== undefined && condition.workdays !== null) {
        if (!Number.isInteger(condition.workdays) || condition.workdays < 1 || condition.workdays > 365) {
          throw badRequest('BAD_RULE', 'Рабочих дней просрочки — целое число от 1 до 365');
        }
        cond.workdays = condition.workdays;
      }
      if (condition.unlessFilledFieldId) {
        const u = liveField(reg, condition.unlessFilledFieldId);
        if (!u || u.type === 'calc' || u.type === 'decision') throw badRequest('BAD_RULE', 'Условие «если пусто» — только для заполняемого поля');
        cond.unlessFilledFieldId = u.id;
      }
      break;
    }
    case 'equals': {
      if (!field || field.type !== 'select') throw badRequest('BAD_RULE', 'Выберите поле-список');
      const opt = field.options.find((o) => o.id === condition.optionId && !o.archived);
      if (!opt) throw badRequest('BAD_RULE', 'Выберите значение списка');
      cond = { kind: 'equals', fieldId: field.id, optionId: opt.id };
      break;
    }
    default:
      throw badRequest('BAD_RULE', 'Неизвестное условие');
  }
  if (isSetOption(action)) {
    if (cond.kind === 'yearly') throw badRequest('BAD_RULE', 'Ежегодное условие создаёт сводную задачу — значение по нему не ставится');
    return { condition: cond, action: validateSetOption(reg, action) };
  }
  if (!action.recipients.length) throw badRequest('BAD_RULE', 'Укажите, кому адресовано событие');
  if (action.recipients.length > MAX_RECIPIENTS) throw badRequest('BAD_RULE', `Не больше ${MAX_RECIPIENTS} получателей`);
  const recipients: Recipient[] = action.recipients.map((r) => {
    if (r.kind === 'field') {
      const f = liveField(reg, r.fieldId);
      if (!f || f.type !== 'user') throw badRequest('BAD_RULE', 'Получатель из записи — только поле «Сотрудник»');
      return { kind: 'field', fieldId: f.id };
    }
    if (r.kind === 'user') {
      const name = choices.users.get(r.userId);
      if (!name) throw badRequest('BAD_RULE', 'Получатель-сотрудник — только активный пользователь с доступом к разделам ИБ');
      return { kind: 'user', userId: r.userId, name };
    }
    // Метка — значение справочника «Получатели уведомлений» по id (ADR-0005); название берётся из справочника.
    const item = r.itemId ? choices.labels.find((l) => l.id === r.itemId) : undefined;
    if (!item) throw badRequest('BAD_RULE', 'Такой метки нет в справочнике «Получатели уведомлений» — выберите метку из списка или добавьте её в настройках');
    // Архивную метку новым правилам не выбрать; в правиле, где она уже была, она остаётся.
    const kept = before?.recipients.some((x) => x.kind === 'label' && x.itemId === item.id);
    if (item.archived && !kept) throw badRequest('BAD_RULE', `Метка «${item.value}» в архиве — выберите другую`);
    return { kind: 'label', itemId: item.id };
  });
  const title = action.title?.trim().replace(/\s+/g, ' ');
  return { condition: cond, action: { eventType: action.eventType, recipients, ...(title ? { title: title.slice(0, 200) } : {}) } };
}

const fieldName = (reg: RegisterDef, id: string | null | undefined) => reg.fields.find((f) => f.id === id)?.label ?? '(поле удалено)';

export function describeCondition(reg: RegisterDef, c: Condition): string {
  switch (c.kind) {
    case 'before':
      return c.days === 0 ? `В день «${fieldName(reg, c.fieldId)}»` : `За ${c.days} дн. до «${fieldName(reg, c.fieldId)}»`;
    case 'overdue': {
      const base = c.workdays ? `«${fieldName(reg, c.fieldId)}» просрочен на ${c.workdays} раб. дн.` : `«${fieldName(reg, c.fieldId)}» просрочен`;
      return c.unlessFilledFieldId ? `${base} и пусто «${fieldName(reg, c.unlessFilledFieldId)}»` : base;
    }
    case 'equals': {
      const f = reg.fields.find((x) => x.id === c.fieldId);
      return `«${f?.label ?? '(поле удалено)'}» = «${f?.options.find((o) => o.id === c.optionId)?.label ?? '?'}»`;
    }
    case 'yearly': {
      const status = reg.fields.find((f) => f.isStatus);
      const which = c.statusOptionIds?.length ? ` (статус ${c.statusOptionIds.map((id) => `«${status?.options.find((o) => o.id === id)?.label ?? '?'}»`).join(', ')})` : '';
      return `Ежегодно ${String(c.day).padStart(2, '0')}.${String(c.month).padStart(2, '0')} — сводка открытых записей${which}`;
    }
    case 'basis_missing':
      return `«${fieldName(reg, c.fieldId)}»: канал открыт без действующего основания`;
  }
}

/** Получатель-метка: актуальное название по id; без id или удалённая — «получатель не найден». */
export function resolveLabel(r: { itemId: string | null }, labels: LabelNames): { itemId: string | null; label: string; missing: boolean } {
  const name = r.itemId ? labels.get(r.itemId) : undefined;
  return name !== undefined
    ? { itemId: r.itemId, label: name, missing: false }
    : { itemId: r.itemId, label: '', missing: true };
}

export function describeAction(reg: RegisterDef, a: Action, labels: LabelNames): string {
  if (isSetOption(a)) {
    const f = reg.fields.find((x) => x.id === a.fieldId);
    const name = (id: string) => `«${f?.options.find((o) => o.id === id)?.label ?? '?'}»`;
    return `Установить «${f?.label ?? '(поле удалено)'}» = ${name(a.optionId)} (если ${a.fromOptionIds.map(name).join(' или ')})`;
  }
  const who = a.recipients.map((r) => {
    if (r.kind === 'field') return fieldName(reg, r.fieldId);
    if (r.kind === 'user') return r.name ?? 'сотрудник';
    const l = resolveLabel(r, labels);
    return l.missing ? `${l.label || 'метка'} (получатель не найден)` : l.label;
  }).join(', ');
  return `${EVENT_TYPE_NAMES[a.eventType]}: ${who}${a.title ? ` — «${a.title}»` : ''}`;
}

// ---------------------------------------------------------------- правила

type RuleRow = {
  id: string; registerId: string; systemKey: string | null; condition: Prisma.JsonValue; action: Prisma.JsonValue;
  enabled: boolean; version: number; archivedAt: Date | null; createdAt: Date;
};

function toRuleDto(reg: RegisterDef, r: RuleRow, labels: LabelNames) {
  const condition = r.condition as unknown as Condition;
  const stored = r.action as unknown as Action;
  // В ответе у метки — актуальное название и признак «получатель не найден».
  const action = {
    eventType: stored.eventType,
    recipients: stored.recipients.map((x) => (x.kind === 'label' ? { kind: 'label' as const, ...resolveLabel(x, labels) } : x)),
  };
  return {
    id: r.id,
    registerId: r.registerId,
    systemKey: r.systemKey,
    condition,
    action,
    /** Есть получатель-метка, которой нет в справочнике: задачи по ней — без ответственного. */
    recipientMissing: action.recipients.some((x) => x.kind === 'label' && x.missing),
    enabled: r.enabled,
    archived: r.archivedAt !== null,
    version: r.version,
    when: describeCondition(reg, condition),
    then: describeAction(reg, stored, labels),
    createdAt: r.createdAt.toISOString(),
  };
}
export type RuleDto = ReturnType<typeof toRuleDto>;

export async function listRules(db: Db, registerId: string, opts: { includeArchived: boolean }) {
  const reg = await loadRegister(db, registerId);
  const labels = await loadLabels(db);
  const rows = await db.registerAutomation.findMany({
    where: { registerId, deletedAt: null, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => toRuleDto(reg, r, labels));
}

async function getRule(db: Db, id: string) {
  const rule = await db.registerAutomation.findFirst({ where: { id, deletedAt: null } });
  if (!rule) throw notFound('Правило');
  const reg = await loadRegister(db, rule.registerId);
  return { rule, reg, labels: await loadLabels(db) };
}

export async function createRule(db: Db, actor: Actor, registerId: string, input: { condition: Condition; action: Action }) {
  return withTx(db, async (tx) => {
    const reg = await loadRegister(tx, registerId);
    assertNotArchived(reg);
    const v = validateRule(reg, input.condition, input.action, await recipientChoices(tx));
    const labels = await loadLabels(tx);
    const r = await tx.registerAutomation.create({
      data: {
        registerId, createdBy: actor.id,
        condition: v.condition as unknown as Prisma.InputJsonValue, action: v.action as unknown as Prisma.InputJsonValue,
      },
    });
    const dto = toRuleDto(reg, r, labels);
    await auditSettings(tx, actor, {
      action: 'register.automation.created', entity: 'register_automation', entityId: r.id,
      summary: `Реестр «${reg.name}»: правило «${dto.when} → ${dto.then}»`, after: { condition: v.condition, action: v.action },
    });
    return dto;
  });
}

export async function updateRule(
  db: Db, actor: Actor, id: string,
  input: { version: number; condition?: Condition; action?: Action; enabled?: boolean },
) {
  return withTx(db, async (tx) => {
    const { rule, reg, labels } = await getRule(tx, id);
    assertNotArchived(reg);
    if (rule.version !== input.version) throw versionConflict();
    const data: Prisma.RegisterAutomationUpdateManyMutationInput = {};
    const before = toRuleDto(reg, rule, labels);
    if (input.condition || input.action) {
      // Системные правила п. 7.4 заданы процедурой: их можно только выключить.
      if (rule.systemKey) throw conflict('SYSTEM_RULE', 'Системное правило не меняется — его можно только выключить');
      const storedAction = rule.action as unknown as Action;
      const v = validateRule(reg, input.condition ?? before.condition, input.action ?? storedAction, await recipientChoices(tx), storedAction);
      data.condition = v.condition as unknown as Prisma.InputJsonValue;
      data.action = v.action as unknown as Prisma.InputJsonValue;
    }
    if (input.enabled !== undefined && input.enabled !== rule.enabled) data.enabled = input.enabled;
    if (!Object.keys(data).length) return before;
    const res = await tx.registerAutomation.updateMany({ where: { id, version: input.version }, data: { ...data, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerAutomation.findFirst({ where: { id, deletedAt: null } }), 'Правило');
    const after = toRuleDto(reg, await tx.registerAutomation.findUniqueOrThrow({ where: { id } }), labels);
    const what = data.enabled === undefined ? `«${before.when} → ${before.then}» → «${after.when} → ${after.then}»` : `«${after.when} → ${after.then}» ${after.enabled ? 'включено' : 'выключено'}`;
    await auditSettings(tx, actor, {
      action: 'register.automation.updated', entity: 'register_automation', entityId: id,
      summary: `Реестр «${reg.name}», правило: ${what}`,
      before: { condition: before.condition, action: before.action, enabled: before.enabled },
      after: { condition: after.condition, action: after.action, enabled: after.enabled },
    });
    return after;
  });
}

export async function setRuleArchived(db: Db, actor: Actor, id: string, version: number, archived: boolean) {
  return withTx(db, async (tx) => {
    const { rule, reg, labels } = await getRule(tx, id);
    assertNotArchived(reg);
    if (archived && rule.systemKey) throw conflict('SYSTEM_RULE', 'Системное правило не уходит в архив — его можно выключить');
    if ((rule.archivedAt !== null) === archived) {
      if (rule.version !== version) throw versionConflict();
      return toRuleDto(reg, rule, labels);
    }
    const res = await tx.registerAutomation.updateMany({ where: { id, version }, data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerAutomation.findFirst({ where: { id, deletedAt: null } }), 'Правило');
    const dto = toRuleDto(reg, await tx.registerAutomation.findUniqueOrThrow({ where: { id } }), labels);
    await auditSettings(tx, actor, {
      action: archived ? 'register.automation.archived' : 'register.automation.restored', entity: 'register_automation', entityId: id,
      summary: `Реестр «${reg.name}»: правило «${dto.when} → ${dto.then}» ${archived ? 'в архиве' : 'возвращено из архива'}`,
    });
    return dto;
  });
}

/** Удалить можно только правило без событий; с событиями — в архив (события ссылаются на правило). */
export async function deleteRule(db: Db, actor: Actor, id: string, version: number) {
  await withTx(db, async (tx) => {
    const { rule, reg, labels } = await getRule(tx, id);
    assertNotArchived(reg);
    if (rule.systemKey) throw conflict('SYSTEM_RULE', 'Системное правило не удаляется — его можно выключить');
    const events = await tx.automationEvent.count({ where: { automationId: id } });
    if (events > 0) throw conflict('HAS_EVENTS', `По правилу есть события (${events}). Отправьте его в архив`);
    const res = await tx.registerAutomation.updateMany({ where: { id, version }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerAutomation.findFirst({ where: { id, deletedAt: null } }), 'Правило');
    const dto = toRuleDto(reg, rule, labels);
    await auditSettings(tx, actor, {
      action: 'register.automation.deleted', entity: 'register_automation', entityId: id,
      summary: `Реестр «${reg.name}»: удалено правило «${dto.when} → ${dto.then}»`,
      before: { condition: dto.condition, action: dto.action },
    });
  });
}

// ---------------------------------------------------------------- события

export type EventRecipient = { kind: 'user'; userId: string; name: string } | { kind: 'label'; label: string; itemId?: string | null };

export async function listEvents(
  db: Db, registerId: string,
  q: { status?: 'new' | 'processed'; recordId?: string; limit: number; cursor?: string },
) {
  const reg = await loadRegister(db, registerId);
  const labels = await loadLabels(db);
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const where: Prisma.AutomationEventWhereInput = {
    registerId, ...(q.status ? { status: q.status } : {}), ...(q.recordId ? { recordId: q.recordId } : {}),
    // Журнал реестра — по действующим записям; в карточке видны и события записи из архива.
    record: { deletedAt: null, ...(q.recordId ? {} : { archivedAt: null }) },
  };
  const [rows, total] = await Promise.all([
    db.automationEvent.findMany({
      where,
      include: {
        record: { select: { number: true, values: true } },
        automation: true,
        processor: { select: { fullName: true } },
        tasks: { include: { task: { select: { id: true, number: true, title: true, deletedAt: true } } } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: offset,
      take: q.limit + 1,
    }),
    db.automationEvent.count({ where }),
  ]);
  const title = reg.fields.find((f) => f.isTitle);
  return {
    items: rows.slice(0, q.limit).map((row) => {
      const e = registerEvent(row);
      const rule = toRuleDto(reg, e.automation, labels);
      const values = e.record.values as Values;
      return {
        id: e.id,
        recordId: e.recordId,
        recordNumber: e.record.number,
        recordTitle: title ? String(values[title.id] ?? '') : '',
        automationId: e.automationId,
        when: rule.when,
        then: rule.then,
        eventType: e.eventType as EventType | 'set_option',
        recipients: e.recipients as unknown as EventRecipient[],
        triggerKey: e.triggerKey,
        fireAt: e.fireAt.toISOString().slice(0, 10),
        status: e.status as 'new' | 'processed',
        processedAt: e.processedAt?.toISOString() ?? null,
        processedBy: e.processor?.fullName ?? null,
        /** Задачи, которые событие создало или прокомментировало (этап 5). */
        tasks: e.tasks.filter((t) => !t.task.deletedAt).map((t) => ({ id: t.task.id, number: t.task.number, title: t.task.title, action: t.action as 'created' | 'commented' })),
        createdAt: e.createdAt.toISOString(),
      };
    }),
    nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
    total,
  };
}

// ---------------------------------------------------------------- прогон

/**
 * Действие «установить значение» (этап 8б: 1 января — «Истекло»). Событие (уникальное по правилу, записи и ключу)
 * сразу обработано, значение меняется в той же транзакции; история записи и журнал — от имени системы.
 * Изменение, которое запрещает фиксация статусом (выход из фиксирующих статусов), пропускается с записью в журнал.
 */
async function applySetOptions(
  tx: Db, reg: RegisterDef,
  sets: { rule: { id: string; condition: Prisma.JsonValue; action: Prisma.JsonValue }; action: SetOptionAction; record: { id: string; number: number; values: Prisma.JsonValue; version: number }; triggerKey: string }[],
  today: string, labels: LabelNames,
): Promise<number> {
  let created = 0;
  for (const s of sets) {
    const exists = await tx.automationEvent.findFirst({ where: { automationId: s.rule.id, recordId: s.record.id, triggerKey: s.triggerKey }, select: { id: true } });
    if (exists) continue;
    const before = s.record.values as Values;
    const after: Values = { ...before, [s.action.fieldId]: s.action.optionId };
    const field = reg.fields.find((f) => f.id === s.action.fieldId) as FieldMeta;
    const label = (id: unknown) => field.options.find((o) => o.id === id)?.label ?? '';
    const rule = toRuleDto(reg, { ...(s.rule as RuleRow), registerId: reg.id, systemKey: null, enabled: true, version: 1, archivedAt: null, createdAt: new Date() }, labels);
    const event = await tx.automationEvent.create({
      data: {
        registerId: reg.id, recordId: s.record.id, automationId: s.rule.id, eventType: 'set_option', recipients: [],
        triggerKey: s.triggerKey, fireAt: new Date(`${today}T00:00:00Z`), status: 'processed', processedAt: new Date(),
      },
    });
    created++;
    const blocked = lockErrors(reg, before, after, [s.action.fieldId], null);
    if (blocked.length) {
      await tx.auditLog.create({
        data: {
          userId: null, action: 'automation.skipped', entity: 'register_record', entityId: s.record.id,
          diff: { summary: `«${reg.name}», запись #${s.record.number}: правило «${rule.when} → ${rule.then}» не применено — ${blocked[0]?.message}`, after: { eventId: event.id, via: 'automation' } } as Prisma.InputJsonValue,
        },
      });
      continue;
    }
    const users = await loadUsers(tx, userIdsIn(reg, [after]));
    const links = linkLabels(await loadLinkRefs(tx, linkIdsIn(reg, [after])));
    await tx.registerRecord.update({
      where: { id: s.record.id },
      data: { values: after as Prisma.InputJsonValue, searchText: searchTextOf(reg, s.record.number, after, users, links), version: { increment: 1 } },
    });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'register_record.updated', entity: 'register_record', entityId: s.record.id,
        diff: {
          summary: `«${reg.name}», запись #${s.record.number}: «${field.label}» → «${label(s.action.optionId)}» по правилу «${rule.when}»`,
          after: { changes: [{ fieldId: field.id, label: field.label, from: label(before[field.id]), to: label(s.action.optionId) }], via: 'automation', eventId: event.id },
        } as Prisma.InputJsonValue,
      },
    });
  }
  return created;
}

export interface RunResult {
  /** false — другой прогон уже идёт, этот пропущен. */
  ran: boolean;
  today: string;
  rules: number;
  checked: number;
  created: number;
  /** Задачи из новых событий: создано и дополнено комментарием. */
  tasksCreated: number;
  tasksCommented: number;
  /** Непривязанные файлы старше суток, помеченные удалённым (этап 7). */
  orphanFiles?: number;
}

/** Ключ advisory-блокировки: один прогон за раз, даже если backend запущен в нескольких экземплярах. */
const RUN_LOCK = 0x1b_a0_7e;

/**
 * Проверить правила и создать события. Идемпотентно: событие уникально по (правило, запись, trigger_key),
 * повторный прогон в тот же день — и через час, и после перезапуска — дублей не создаёт.
 */
export async function runAutomations(db: Db, opts: { now?: Date; registerId?: string } = {}): Promise<RunResult> {
  const today = todayIso(opts.now ?? new Date());
  return withTx(db, async (tx) => {
    const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${RUN_LOCK}::bigint) AS ok`;
    if (!lock?.ok) return { ran: false, today, rules: 0, checked: 0, created: 0, tasksCreated: 0, tasksCommented: 0 };
    const rules = await tx.registerAutomation.findMany({
      where: {
        enabled: true, archivedAt: null, deletedAt: null, register: { archivedAt: null },
        ...(opts.registerId ? { registerId: opts.registerId } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    const calendar = await loadFullWorkCalendar(tx);
    const labels = await loadLabels(tx);
    const byRegister = new Map<string, typeof rules>();
    for (const r of rules) byRegister.set(r.registerId, [...(byRegister.get(r.registerId) ?? []), r]);
    let checked = 0;
    let created = 0;
    for (const [registerId, regRules] of byRegister) {
      const reg = await loadRegister(tx, registerId);
      const records = (await tx.registerRecord.findMany({
        where: { registerId, deletedAt: null, archivedAt: null },
        select: { id: true, number: true, values: true, version: true },
      })).filter((r) => !isClosed(reg, r.values as Values));
      checked += records.length;
      const users = await loadUsers(tx, records.flatMap((r) => {
        const v = r.values as Values;
        return reg.fields.filter((f) => f.type === 'user' && typeof v[f.id] === 'string').map((f) => v[f.id] as string);
      }));
      const data: Prisma.AutomationEventCreateManyInput[] = [];
      const sets: { rule: (typeof regRules)[number]; action: SetOptionAction; record: (typeof records)[number]; triggerKey: string }[] = [];
      const snapshot = (action: TaskAction, values: Values): EventRecipient[] => action.recipients.map((x) => {
        if (x.kind === 'label') {
          // Снимок: актуальное название и id метки; метки нет — задача будет без ответственного.
          const l = resolveLabel(x, labels);
          return l.missing ? { kind: 'label', label: `«${l.label || 'метка'}»: получатель не найден`, itemId: null } : { kind: 'label', label: l.label, itemId: l.itemId };
        }
        if (x.kind === 'user') return { kind: 'user', userId: x.userId, name: x.name ?? 'сотрудник' };
        const uid = values[x.fieldId];
        const u = typeof uid === 'string' ? users.get(uid) : undefined;
        return u ? { kind: 'user', userId: u.id, name: u.fullName } : { kind: 'label', label: `«${fieldName(reg, x.fieldId)}» не назначен` };
      });
      // Статус основания (этап 8б): разрешения из реестра-источника — один раз на реестр.
      const needsBasis = regRules.some((r) => (r.condition as unknown as Condition).kind === 'basis_missing');
      const basisSources = needsBasis ? await loadBasisSources(tx, reg, null) : new Map();
      for (const rule of regRules) {
        const condition = rule.condition as unknown as Condition;
        const action = rule.action as unknown as Action;
        if (condition.kind === 'yearly') {
          // Сводное событие по реестру: одно на правило и день; список записей — в задаче.
          const t = evaluateYearly(condition, today);
          if (t && !isSetOption(action)) {
            data.push({
              registerId, recordId: null, automationId: rule.id, eventType: action.eventType,
              recipients: snapshot(action, {}) as unknown as Prisma.InputJsonValue, triggerKey: t.triggerKey, fireAt: new Date(`${today}T00:00:00Z`),
            });
          }
          continue;
        }
        for (const r of records) {
          const values = r.values as Values;
          const view = {
            values,
            dateOf: (fieldId: string) => {
              const f = reg.fields.find((x) => x.id === fieldId);
              return f ? dateOf(reg, f, values, calendar) : null;
            },
            basisOf: (fieldId: string) => {
              const rule = reg.fields.find((x) => x.id === fieldId)?.calcRule;
              if (!isBasisRule(rule)) return null;
              const b = basisOf(rule, r.id, values, basisSources.get(rule.sourceRegisterId) ?? [], today);
              return { state: b.state, permissionId: b.permission?.id ?? null, channel: String(values[rule.channelFieldId] ?? '') };
            },
          };
          const t = evaluate(condition, view, today, calendar);
          if (!t) continue;
          if (isSetOption(action)) {
            if (action.fromOptionIds.includes(String(values[action.fieldId] ?? ''))) sets.push({ rule, action, record: r, triggerKey: t.triggerKey });
            continue;
          }
          data.push({
            registerId, recordId: r.id, automationId: rule.id, eventType: action.eventType,
            recipients: snapshot(action, values) as unknown as Prisma.InputJsonValue,
            triggerKey: t.triggerKey, fireAt: new Date(`${today}T00:00:00Z`),
          });
        }
      }
      created += await applySetOptions(tx, reg, sets, today, labels);
      if (!data.length) continue;
      const res = await tx.automationEvent.createMany({ data, skipDuplicates: true });
      created += res.count;
      if (res.count > 0) {
        // Системное действие: автора нет (user_id пустой).
        await tx.auditLog.create({
          data: {
            userId: null, action: 'automation.run', entity: 'register', entityId: registerId,
            diff: { summary: `«${reg.name}»: автоматизации создали событий — ${res.count}`, today, created: res.count } as Prisma.InputJsonValue,
          },
        });
      }
    }
    // Новые события (и оставшиеся с прошлых прогонов) — сразу в задачи, в той же транзакции.
    const tasks = await tasksFromEvents(tx, {
      registerId: opts.registerId, today, calendar,
      describe: (reg, r) => {
        const dto = toRuleDto(reg, { ...(r as { condition: Prisma.JsonValue; action: Prisma.JsonValue }), id: '', registerId: reg.id, systemKey: null, enabled: true, version: 1, archivedAt: null, createdAt: new Date() }, labels);
        return { when: dto.when, then: dto.then };
      },
    });
    // Пересмотр документов (этап 6), срок действия доказательств и непривязанные файлы (этап 7) —
    // в общем прогоне, не в прогоне одного реестра.
    const none = { tasksCreated: 0, tasksCommented: 0 };
    const docs = opts.registerId ? none : await runDocumentReviews(tx, { today });
    const evidence = opts.registerId ? none : await runEvidenceExpiry(tx, { today });
    const orphanFiles = opts.registerId ? 0 : await sweepOrphanFiles(tx, opts.now ?? new Date());
    return {
      ran: true, today, rules: rules.length, checked, created, orphanFiles,
      tasksCreated: tasks.created + docs.tasksCreated + evidence.tasksCreated,
      tasksCommented: tasks.commented + docs.tasksCommented + evidence.tasksCommented,
    };
  });
}
