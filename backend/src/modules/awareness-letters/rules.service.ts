// Правила расписания рассылок (1.9.0, ADR-0040; docs/specs/awareness.md, раздел 19.1–19.4).
// Правило: название, периодичность (cadence.ts), дата начала, опережение 7–90 дней, роль-исполнитель (только рабочая
// роль — workRolesWhere), шаблон (необязательно), «активно». Правка — ib.work с version, архив вместо удаления.
// Правка и отключение не трогают созданные запуски и задачи: новые запуски строятся по новой периодичности.
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, notFound, versionConflict } from '../../lib/errors.js';
import { todayIso } from '../../lib/today.js';
import { isoDate, isoWeekday, parseIsoDate } from '../../lib/working-days.js';
import { workRolesWhere, workUsersWhere } from '../../lib/work-users.js';
import { loadFullWorkCalendar } from '../calendar/service.js';
import type { Actor } from '../settings/common.js';
import type { LetterStatus } from './flow.js';
import { CadenceSchema, LEAD_DAYS, LeadDaysSchema, upcoming, type Cadence } from './cadence.js';

export const RULE_ENTITY = 'awareness_rule';
export const RULE_TITLE_MAX = 200;
export const PREVIEW_COUNT = 6;

const userBrief = { select: { id: true, fullName: true } } as const;
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

/** Периодичность словами — для журнала и подсказок. */
export function cadenceText(c: Cadence): string {
  switch (c.kind) {
    case 'monthly': return `ежемесячно, ${c.day}-го`;
    case 'twice_monthly': return `дважды в месяц, ${c.days[0]}-го и ${c.days[1]}-го`;
    case 'quarterly': return `ежеквартально, ${c.day}-го в ${c.month}-й месяц квартала`;
    case 'yearly': return `ежегодно, ${String(c.day).padStart(2, '0')}.${String(c.month).padStart(2, '0')}`;
    case 'weekly': return `${c.every === 1 ? 'еженедельно' : `каждую ${c.every}-ю неделю`}, ${WEEKDAYS[c.weekday - 1]}`;
  }
}

async function auditRule(tx: Db, actor: Actor, ruleId: string, action: string, summary: string, extra: Record<string, unknown> = {}) {
  await tx.auditLog.create({
    data: {
      userId: actor.id, action: `${RULE_ENTITY}.${action}`, entity: RULE_ENTITY, entityId: ruleId, ip: actor.ip,
      diff: { summary, actorRoles: [...actor.roleNames], ...extra } as Prisma.InputJsonValue,
    },
  });
}

// ———————————————————————————————————————————————— проверка ввода

export interface RuleInput {
  title: string;
  cadence: unknown;
  startsOn: string;
  leadDays?: number;
  roleId: string;
  templateId?: string | null;
  active?: boolean;
}

interface CleanRule {
  title: string;
  cadence: Cadence;
  startsOn: string;
  leadDays: number;
  roleId: string;
  templateId: string | null;
  active: boolean;
}

/** Роль — только рабочая (ib.work, не служебная): иначе 400 BAD_ROLE. */
export async function assertWorkRole(db: Db, roleId: string): Promise<{ id: string; name: string }> {
  const role = await db.role.findFirst({ where: { AND: [{ id: roleId }, workRolesWhere()] }, select: { id: true, name: true } });
  if (!role) throw badRequest('BAD_ROLE', 'Выберите роль сотрудников ИБ: у неё должно быть право «Работа в разделах ИБ», служебная роль не подходит');
  return role;
}

async function cleanRule(db: Db, input: RuleInput, prev?: { templateId: string | null }): Promise<CleanRule> {
  const title = oneLine(input.title);
  if (!title) throw badRequest('TITLE_REQUIRED', 'Укажите название правила');
  if (title.length > RULE_TITLE_MAX) throw badRequest('TITLE_TOO_LONG', `Название длиннее ${RULE_TITLE_MAX} символов`);
  const cadence = CadenceSchema.safeParse(input.cadence);
  if (!cadence.success) throw badRequest('BAD_CADENCE', `Периодичность: ${cadence.error.issues[0]?.message ?? 'неверное значение'}`);
  try {
    parseIsoDate(input.startsOn);
  } catch {
    throw badRequest('BAD_DATE', 'Неверная дата начала');
  }
  const lead = LeadDaysSchema.safeParse(input.leadDays ?? LEAD_DAYS.default);
  if (!lead.success) throw badRequest('BAD_LEAD_DAYS', lead.error.issues[0]?.message ?? 'Неверное опережение');
  await assertWorkRole(db, input.roleId);
  const templateId = input.templateId ?? null;
  if (templateId) {
    const t = await db.awarenessTemplate.findUnique({ where: { id: templateId }, select: { title: true, archivedAt: true } });
    if (!t) throw notFound('Шаблон');
    // Архивный шаблон не выбирается в новом правиле; уже выбранный остаётся (правило создаёт задачи без черновика).
    if (t.archivedAt && prev?.templateId !== templateId) throw new AppError(409, 'TEMPLATE_ARCHIVED', `Шаблон «${t.title}» в архиве — выберите другой`);
  }
  return { title, cadence: cadence.data, startsOn: input.startsOn, leadDays: lead.data, roleId: input.roleId, templateId, active: input.active ?? true };
}

// ———————————————————————————————————————————————— предпросмотр

export interface PreviewDate {
  nominal: string;
  planned: string;
  shifted: boolean;
  /** Почему перенесено: название праздника или «выходной». */
  reason: string | null;
}

/** Ближайшие даты правила: номинальная, плановая, перенос и причина. */
export async function previewDates(db: Db, rule: { cadence: Cadence; startsOn: string }, now = new Date(), count = PREVIEW_COUNT): Promise<PreviewDate[]> {
  const cal = await loadFullWorkCalendar(db);
  const today = todayIso(now);
  const list = upcoming(rule, today, count, cal);
  if (!list.length) return [];
  const holidays = await db.workCalendarDay.findMany({
    where: { deletedAt: null, kind: 'holiday', day: { gte: parseIsoDate(today), lte: parseIsoDate(list[list.length - 1]?.nominal ?? today) } },
    select: { day: true, title: true },
  });
  const titles = new Map(holidays.map((h) => [isoDate(h.day), h.title]));
  return list.map((o) => {
    let reason: string | null = null;
    if (o.shifted) {
      const h = titles.get(o.nominal);
      reason = h ? `праздник: ${h}` : cal.weekendDays.includes(isoWeekday(parseIsoDate(o.nominal))) ? 'выходной' : 'нерабочий день';
    }
    return { nominal: o.nominal, planned: o.planned, shifted: o.shifted, reason };
  });
}

/** Предпросмотр для формы: правило ещё не сохранено. */
export async function previewForm(db: Db, input: { cadence: unknown; startsOn: string }, now = new Date()) {
  const cadence = CadenceSchema.safeParse(input.cadence);
  if (!cadence.success) throw badRequest('BAD_CADENCE', `Периодичность: ${cadence.error.issues[0]?.message ?? 'неверное значение'}`);
  try {
    parseIsoDate(input.startsOn);
  } catch {
    throw badRequest('BAD_DATE', 'Неверная дата начала');
  }
  return { cadenceText: cadenceText(cadence.data), dates: await previewDates(db, { cadence: cadence.data, startsOn: input.startsOn }, now) };
}

// ———————————————————————————————————————————————— чтение

const ruleInclude = {
  role: { select: { id: true, name: true } },
  template: { select: { id: true, title: true, archivedAt: true } },
  creator: userBrief,
} as const;
type RuleRow = Prisma.AwarenessScheduleRuleGetPayload<{ include: typeof ruleInclude }>;

async function holdersCount(db: Db, roleIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const roleId of [...new Set(roleIds)]) {
    out.set(roleId, await db.user.count({ where: { AND: [workUsersWhere(), { roles: { some: { roleId } } }] } }));
  }
  return out;
}

function ruleDto(r: RuleRow, holders: number) {
  const cadence = r.cadence as Cadence;
  return {
    id: r.id,
    title: r.title,
    cadence,
    cadenceText: cadenceText(cadence),
    startsOn: isoDate(r.startsOn),
    leadDays: r.leadDays,
    role: r.role,
    /** Держателей роли, участвующих в работе: 0 — задача без кандидатов и эскалация сразу. */
    roleHolders: holders,
    template: r.template ? { id: r.template.id, title: r.template.title, archived: r.template.archivedAt !== null } : null,
    active: r.active,
    archived: r.archivedAt !== null,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    createdBy: r.creator,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}

export async function listRules(db: Db, q: { scope: 'active' | 'archived' | 'all' }, now = new Date()) {
  const where: Prisma.AwarenessScheduleRuleWhereInput = q.scope === 'active' ? { archivedAt: null } : q.scope === 'archived' ? { archivedAt: { not: null } } : {};
  const rows = await db.awarenessScheduleRule.findMany({ where, include: ruleInclude, orderBy: [{ active: 'desc' }, { title: 'asc' }, { id: 'asc' }] });
  const holders = await holdersCount(db, rows.map((r) => r.roleId));
  const items = [];
  for (const r of rows) {
    const next = r.active && !r.archivedAt ? (await previewDates(db, { cadence: r.cadence as Cadence, startsOn: isoDate(r.startsOn) }, now, 1))[0] ?? null : null;
    items.push({ ...ruleDto(r, holders.get(r.roleId) ?? 0), next });
  }
  return { items };
}

export async function getRule(db: Db, id: string, now = new Date()) {
  const r = await db.awarenessScheduleRule.findUnique({ where: { id }, include: ruleInclude });
  if (!r) throw notFound('Правило');
  const holders = await holdersCount(db, [r.roleId]);
  const runs = await db.awarenessScheduleRun.findMany({
    where: { ruleId: id }, orderBy: { plannedDate: 'desc' }, take: 20,
    include: {
      task: { select: { id: true, number: true, title: true, completedAt: true, archivedAt: true, deletedAt: true } },
      letter: { select: { id: true, number: true, status: true } },
    },
  });
  return {
    ...ruleDto(r, holders.get(r.roleId) ?? 0),
    dates: await previewDates(db, { cadence: r.cadence as Cadence, startsOn: isoDate(r.startsOn) }, now),
    runs: runs.map((x) => ({
      id: x.id, nominalDate: isoDate(x.nominalDate), plannedDate: isoDate(x.plannedDate),
      draftDue: isoDate(x.draftDue), reviewDue: isoDate(x.reviewDue), escalatedAt: x.escalatedAt?.toISOString() ?? null,
      task: x.task.deletedAt ? null : { id: x.task.id, number: x.task.number, title: x.task.title, done: x.task.completedAt !== null, archived: x.task.archivedAt !== null },
      letter: x.letter ? { id: x.letter.id, number: x.letter.number, status: x.letter.status as LetterStatus } : null,
    })),
  };
}
export type RuleDetail = Awaited<ReturnType<typeof getRule>>;

/** Роли для выбора исполнителя: рабочие, с числом держателей. */
export async function listWorkRoles(db: Db) {
  const roles = await db.role.findMany({ where: workRolesWhere(), select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const holders = await holdersCount(db, roles.map((r) => r.id));
  return { items: roles.map((r) => ({ ...r, holders: holders.get(r.id) ?? 0 })) };
}

// ———————————————————————————————————————————————— запись

function trace(r: CleanRule) {
  return { title: r.title, cadence: cadenceText(r.cadence), startsOn: r.startsOn, leadDays: r.leadDays, roleId: r.roleId, templateId: r.templateId, active: r.active };
}

export async function createRule(db: Db, actor: Actor, input: RuleInput, now = new Date()) {
  const r = await cleanRule(db, input);
  const id = await withTx(db, async (tx) => {
    const row = await tx.awarenessScheduleRule.create({
      data: { ...r, cadence: r.cadence as Prisma.InputJsonValue, startsOn: parseIsoDate(r.startsOn), createdBy: actor.id },
    });
    await auditRule(tx, actor, row.id, 'created', `Правило рассылки «${r.title}» создано: ${cadenceText(r.cadence)}`, { after: trace(r) });
    return row.id;
  });
  return getRule(db, id, now);
}

/** Изменить правило. Созданные запуски и задачи не меняются; новые — по новой периодичности. */
export async function updateRule(db: Db, actor: Actor, id: string, input: RuleInput & { version: number }, now = new Date()) {
  const row = await db.awarenessScheduleRule.findUnique({ where: { id } });
  if (!row) throw notFound('Правило');
  if (row.archivedAt) throw new AppError(409, 'RULE_ARCHIVED', 'Правило в архиве. Верните его из архива, чтобы изменить');
  if (row.version !== input.version) throw versionConflict();
  const r = await cleanRule(db, input, row);
  const before: CleanRule = {
    title: row.title, cadence: row.cadence as Cadence, startsOn: isoDate(row.startsOn), leadDays: row.leadDays,
    roleId: row.roleId, templateId: row.templateId, active: row.active,
  };
  if (JSON.stringify(trace(before)) === JSON.stringify(trace(r))) return getRule(db, id, now);
  await withTx(db, async (tx) => {
    const { count } = await tx.awarenessScheduleRule.updateMany({
      where: { id, version: input.version },
      data: { ...r, cadence: r.cadence as Prisma.InputJsonValue, startsOn: parseIsoDate(r.startsOn), version: { increment: 1 } },
    });
    if (!count) throw versionConflict();
    const what = before.active !== r.active && JSON.stringify({ ...trace(before), active: 0 }) === JSON.stringify({ ...trace(r), active: 0 })
      ? (r.active ? 'включено' : 'отключено') : 'изменено';
    await auditRule(tx, actor, id, 'updated', `Правило рассылки «${r.title}» ${what}`, { before: trace(before), after: trace(r) });
  });
  return getRule(db, id, now);
}

export async function archiveRule(db: Db, actor: Actor, id: string, input: { version: number; archived: boolean }, now = new Date()) {
  const row = await db.awarenessScheduleRule.findUnique({ where: { id } });
  if (!row) throw notFound('Правило');
  if ((row.archivedAt !== null) === input.archived) throw new AppError(409, 'RULE_STATE', input.archived ? 'Правило уже в архиве' : 'Правило не в архиве');
  if (!input.archived) await assertWorkRole(db, row.roleId);
  await withTx(db, async (tx) => {
    const { count } = await tx.awarenessScheduleRule.updateMany({
      where: { id, version: input.version }, data: { archivedAt: input.archived ? new Date() : null, version: { increment: 1 } },
    });
    if (!count) throw versionConflict();
    await auditRule(tx, actor, id, input.archived ? 'archived' : 'unarchived', `Правило рассылки «${row.title}» ${input.archived ? 'отправлено в архив' : 'возвращено из архива'}`);
  });
  return getRule(db, id, now);
}

