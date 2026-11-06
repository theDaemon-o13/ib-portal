// Автоматизации механизмов контроля документа (1.11.0, ADR-0043; план — раздел 5.2): периодическая задача ответственному.
//   - Периодичность — lib/cadence.ts (ADR-0041): ежедневно, еженедельно, ежемесячно, ежеквартально, раз в полгода, ежегодно.
//   - Запуск уникален по «автоматизация + номинальная дата» (document_control_runs); повторный прогон дублей не даёт.
//   - Срок в рабочих днях: дата запуска с выходного — на предыдущий рабочий день, не раньше даты первого запуска;
//     срок задачи — от фактического дня создания: + X рабочих (производственный календарь) или + X календарных дней.
//   - Догон после простоя: номинальная дата не старше 7 дней — задача; старше — запуск «пропущен» без задачи.
//   - Нет ответственного (отключён, без ib.work, служебный): запуск «нет ответственного», автору — одно уведомление.
//   - Документ в архиве — запуски не создаются (во вкладке — «Документ в архиве»); на пересмотре — работает.
//   - Событие automation_events создаётся и обрабатывается в той же транзакции (status = processed — CHECK в БД),
//     поэтому прогоны событий (и 1.10.0 после отката) его не берут. Задача — source = 'document_control'.
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { Day, nominalDates, plannedDate, type AnyCadence } from '../../lib/cadence.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, notFound, versionConflict } from '../../lib/errors.js';
import { formatDateRu } from '../../lib/register-values.js';
import { addDaysIso, todayIso } from '../../lib/today.js';
import { workUsersWhere } from '../../lib/work-users.js';
import { addWorkingDays, isoDate, parseIsoDate, type WorkCalendar } from '../../lib/working-days.js';
import { loadFullWorkCalendar } from '../calendar/service.js';
import { notify, notifyAssignee } from '../notifications/service.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { initialStatusId, recordTransition } from '../tasks/flow.js';
import { systemItemId, TITLE_MAX } from '../tasks/service.js';
import { canManageControls, controlDoc } from './controls.js';
import { accessOf, forbiddenWith } from './service.js';

export const CONTROL_CATEGORY_KEY = 'document_control';
/** Ключ advisory-блокировки прогона автоматизаций контроля (свой, не рассылок и не реестров). */
const CONTROL_LOCK = 0x1b_c0_21;
/** Догон после простоя: номинальная дата не старше стольких дней — задача; старше — «пропущен». */
export const CATCH_UP_DAYS = 7;
/** Самый большой перенос назад с нерабочего дня, который учитывается (длинные праздники). */
const MAX_SHIFT_DAYS = 31;

export const ControlCadenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily') }),
  z.object({ kind: z.literal('weekly'), weekday: z.number().int().min(1).max(7) }),
  z.object({ kind: z.literal('monthly'), day: Day }),
  z.object({ kind: z.literal('quarterly'), month: z.number().int().min(1).max(3), day: Day }),
  z.object({ kind: z.literal('semiannual'), month: z.number().int().min(1).max(6), day: Day }),
  z.object({ kind: z.literal('yearly'), month: z.number().int().min(1).max(12), day: Day }),
]);
export type ControlCadence = z.infer<typeof ControlCadenceSchema>;
const asAny = (c: ControlCadence): AnyCadence => (c.kind === 'weekly' ? { kind: 'weekly', every: 1, weekday: c.weekday } : c);

const KIND_NAMES: Record<ControlCadence['kind'], string> = {
  daily: 'ежедневно', weekly: 'еженедельно', monthly: 'ежемесячно', quarterly: 'ежеквартально', semiannual: 'раз в полгода', yearly: 'ежегодно',
};
const WEEKDAYS = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export function cadenceLabel(c: ControlCadence): string {
  if (c.kind === 'daily') return KIND_NAMES.daily;
  if (c.kind === 'weekly') return `еженедельно, ${WEEKDAYS[c.weekday]}`;
  if (c.kind === 'monthly') return `ежемесячно, ${c.day}-го`;
  if (c.kind === 'quarterly') return `ежеквартально, ${c.month}-й месяц квартала, ${c.day}-го`;
  if (c.kind === 'semiannual') return `раз в полгода, ${c.month}-й месяц полугодия, ${c.day}-го`;
  return `ежегодно, ${String(c.day).padStart(2, '0')}.${String(c.month).padStart(2, '0')}`;
}

export interface AutomationInput {
  title: string;
  description?: string;
  controlId?: string | null;
  cadence: ControlCadence;
  startsOn: string;
  dueDays: number;
  dueKind: 'calendar' | 'working';
  assigneeId: string;
  active?: boolean;
}
export type AutomationPatch = Partial<AutomationInput> & { version: number };

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const isIsoDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && day(v).toISOString().slice(0, 10) === v;

/** Плановая дата запуска: со сроком в рабочих днях — с переносом на предыдущий рабочий день, не раньше первого запуска. */
export function runDate(a: { dueKind: string; startsOn: string }, nominal: string, cal: WorkCalendar): string {
  const p = plannedDate(nominal, cal, a.dueKind === 'working' ? 'prev' : 'none');
  return p < a.startsOn ? a.startsOn : p;
}

/** Срок задачи от фактического дня создания: + X рабочих или + X календарных дней. */
export function taskDue(a: { dueKind: string; dueDays: number }, createdOn: string, cal: WorkCalendar): string {
  return a.dueKind === 'working' ? isoDate(addWorkingDays(parseIsoDate(createdOn), a.dueDays, cal)) : addDaysIso(createdOn, a.dueDays);
}

/** Ближайший запуск, начиная с from: номинальная и плановая дата. */
export function nextRun(a: { cadence: ControlCadence; startsOn: string; dueKind: string }, from: string, cal: WorkCalendar): { nominal: string; planned: string } | null {
  for (const nominal of nominalDates(asAny(a.cadence), a.startsOn, from, addDaysIso(from, 400))) {
    const planned = runDate(a, nominal, cal);
    if (planned >= from) return { nominal, planned };
  }
  return null;
}

const automationInclude = {
  assignee: { select: { id: true, fullName: true } },
  control: { select: { id: true, position: true, requirement: true } },
  runs: {
    orderBy: { nominalDate: 'desc' }, take: 20,
    select: {
      nominalDate: true, plannedDate: true, status: true, createdAt: true,
      task: { select: { id: true, number: true, completedAt: true, archivedAt: true, status: { select: { value: true } } } },
    },
  },
} as const satisfies Prisma.DocumentControlAutomationInclude;
type AutomationRow = Prisma.DocumentControlAutomationGetPayload<{ include: typeof automationInclude }>;

function dto(a: AutomationRow, cal: WorkCalendar, today: string) {
  const cadence = a.cadence as ControlCadence;
  const startsOn = isoDate(a.startsOn);
  return {
    id: a.id, title: a.title, description: a.description, cadence, cadenceLabel: cadenceLabel(cadence), startsOn, dueDays: a.dueDays,
    dueKind: a.dueKind as 'calendar' | 'working', assignee: a.assignee, control: a.control, active: a.active, version: a.version,
    /** «Нет ответственного»: ответственный отключён, без ib.work или служебный — запуски без задачи. */
    noAssignee: a.noAssigneeSince !== null,
    next: a.active ? nextRun({ cadence, startsOn, dueKind: a.dueKind }, today, cal) : null,
    runs: a.runs.map((r) => ({
      nominalDate: isoDate(r.nominalDate), plannedDate: isoDate(r.plannedDate), status: r.status as RunStatus, at: r.createdAt.toISOString(),
      task: r.task ? { id: r.task.id, number: r.task.number, status: r.task.status.value, completed: r.task.completedAt !== null, archived: r.task.archivedAt !== null } : null,
    })),
  };
}
export type RunStatus = 'created' | 'skipped_late' | 'no_assignee' | 'doc_archived';
export type AutomationDto = ReturnType<typeof dto>;

export async function listAutomations(db: Db, actor: Actor, id: string) {
  const a = await accessOf(db, actor.id);
  if (!a.ibWork) throw forbiddenWith('FORBIDDEN', 'Автоматизации видят сотрудники ИБ');
  const d = await controlDoc(db, id, false);
  const rows = await db.documentControlAutomation.findMany({ where: { documentId: id }, include: automationInclude, orderBy: { createdAt: 'asc' } });
  const cal = await loadFullWorkCalendar(db);
  const today = todayIso();
  return { items: rows.map((r) => dto(r, cal, today)), canManage: canManageControls(a, d) && !d.archivedAt };
}

async function manageContext(db: Db, actor: Actor, id: string) {
  const a = await accessOf(db, actor.id);
  const d = await controlDoc(db, id, true);
  if (!canManageControls(a, d)) throw forbiddenWith('FORBIDDEN', 'Автоматизации ведут владелец документа, начальник ИБ и «Документы: управление»');
  return d;
}

/** Проверка полей автоматизации; ответственный — из «кто работает» (активный, ib.work, не служебный). */
async function cleanInput(db: Db, docId: string, input: Partial<AutomationInput>, cur?: AutomationRow) {
  const out: Partial<Omit<AutomationInput, 'cadence'>> & { cadence?: ControlCadence } = {};
  if (input.title !== undefined) {
    out.title = trimmed(input.title);
    if (!out.title) throw badRequest('EMPTY', 'Укажите название задачи');
    if (out.title.length > TITLE_MAX) throw badRequest('TOO_LONG', `Название — не длиннее ${TITLE_MAX} символов`);
  }
  if (input.description !== undefined) {
    out.description = input.description.trim();
    if (out.description.length > 4000) throw badRequest('TOO_LONG', 'Описание — не длиннее 4000 символов');
  }
  if (input.cadence !== undefined) {
    const c = ControlCadenceSchema.safeParse(input.cadence);
    if (!c.success) throw badRequest('BAD_CADENCE', 'Периодичность указана неверно');
    if ('month' in c.data && 'day' in c.data && c.data.kind === 'yearly' && c.data.day > new Date(Date.UTC(2024, c.data.month, 0)).getUTCDate()) {
      throw badRequest('BAD_CADENCE', 'В этом месяце нет такого дня');
    }
    out.cadence = c.data;
  }
  if (input.startsOn !== undefined) {
    if (!isIsoDay(input.startsOn)) throw badRequest('BAD_DATE', 'Укажите дату первого запуска');
    out.startsOn = input.startsOn;
  }
  if (input.dueDays !== undefined) {
    if (!Number.isInteger(input.dueDays) || input.dueDays < 1 || input.dueDays > 365) throw badRequest('BAD_DUE_DAYS', 'Срок — от 1 до 365 дней');
    out.dueDays = input.dueDays;
  }
  if (input.dueKind !== undefined) {
    if (input.dueKind !== 'calendar' && input.dueKind !== 'working') throw badRequest('BAD_DUE_KIND', 'Срок — в календарных или рабочих днях');
    out.dueKind = input.dueKind;
  }
  if (input.assigneeId !== undefined && input.assigneeId !== cur?.assigneeId) {
    const ok = await db.user.findFirst({ where: { id: input.assigneeId, ...workUsersWhere() }, select: { id: true } });
    if (!ok) throw badRequest('BAD_ASSIGNEE', 'Ответственный — активный сотрудник ИБ');
    out.assigneeId = input.assigneeId;
  }
  if (input.controlId !== undefined) {
    if (input.controlId !== null) {
      const c = await db.documentControl.findFirst({ where: { id: input.controlId, documentId: docId }, select: { id: true } });
      if (!c) throw badRequest('BAD_CONTROL', 'Механизм контроля — этого документа');
    }
    out.controlId = input.controlId;
  }
  if (input.active !== undefined) out.active = input.active;
  return out;
}

export async function createAutomation(db: Db, actor: Actor, id: string, input: AutomationInput) {
  return withTx(db, async (tx) => {
    const d = await manageContext(tx, actor, id);
    for (const k of ['title', 'cadence', 'startsOn', 'dueDays', 'dueKind', 'assigneeId'] as const) {
      if (input[k] === undefined || input[k] === null) throw badRequest('EMPTY', 'Заполните название, периодичность, первый запуск, срок и ответственного');
    }
    const c = await cleanInput(tx, id, input);
    const row = await tx.documentControlAutomation.create({
      data: {
        documentId: id, controlId: c.controlId ?? null, title: c.title as string, description: c.description ?? '', cadence: c.cadence as Prisma.InputJsonValue,
        startsOn: day(c.startsOn as string), dueDays: c.dueDays as number, dueKind: c.dueKind as string, assigneeId: c.assigneeId as string,
        active: c.active ?? true, createdBy: actor.id,
      },
      include: automationInclude,
    });
    await auditSettings(tx, actor, {
      action: 'document_control_automation.created', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${d.title}»: автоматизация «${row.title}» — ${cadenceLabel(row.cadence as ControlCadence)}, срок ${row.dueDays} ${row.dueKind === 'working' ? 'раб.' : 'кал.'} дн., ответственный ${row.assignee.fullName}`,
      after: { automationId: row.id, cadence: row.cadence, startsOn: c.startsOn, dueDays: row.dueDays, dueKind: row.dueKind, assigneeId: row.assigneeId, controlId: row.controlId },
    });
    return dto(row, await loadFullWorkCalendar(tx), todayIso());
  });
}

export async function updateAutomation(db: Db, actor: Actor, id: string, automationId: string, input: AutomationPatch) {
  return withTx(db, async (tx) => {
    const d = await manageContext(tx, actor, id);
    const cur = await tx.documentControlAutomation.findFirst({ where: { id: automationId, documentId: id }, include: automationInclude });
    if (!cur) throw notFound('Автоматизация');
    if (cur.version !== input.version) throw versionConflict();
    const c = await cleanInput(tx, id, input, cur);
    const data: Prisma.DocumentControlAutomationUncheckedUpdateManyInput = {};
    const changes: string[] = [];
    if (c.title !== undefined && c.title !== cur.title) { data.title = c.title; changes.push('название'); }
    if (c.description !== undefined && c.description !== cur.description) { data.description = c.description; changes.push('описание'); }
    if (c.cadence !== undefined && JSON.stringify(c.cadence) !== JSON.stringify(cur.cadence)) { data.cadence = c.cadence as Prisma.InputJsonValue; changes.push('периодичность'); }
    if (c.startsOn !== undefined && c.startsOn !== isoDate(cur.startsOn)) { data.startsOn = day(c.startsOn); changes.push('первый запуск'); }
    if (c.dueDays !== undefined && c.dueDays !== cur.dueDays) { data.dueDays = c.dueDays; changes.push('срок'); }
    if (c.dueKind !== undefined && c.dueKind !== cur.dueKind) { data.dueKind = c.dueKind; changes.push('вид срока'); }
    if (c.assigneeId !== undefined && c.assigneeId !== cur.assigneeId) { data.assigneeId = c.assigneeId; data.noAssigneeSince = null; changes.push('ответственный'); }
    if (c.controlId !== undefined && c.controlId !== cur.controlId) { data.controlId = c.controlId; changes.push('механизм контроля'); }
    if (c.active !== undefined && c.active !== cur.active) { data.active = c.active; changes.push(c.active ? 'включена' : 'отключена'); }
    if (!changes.length) return dto(cur, await loadFullWorkCalendar(tx), todayIso());
    const res = await tx.documentControlAutomation.updateMany({ where: { id: automationId, version: input.version }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    await auditSettings(tx, actor, {
      action: data.active === false ? 'document_control_automation.disabled' : data.active === true ? 'document_control_automation.enabled' : 'document_control_automation.updated',
      entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${d.title}»: автоматизация «${cur.title}» — ${changes.join(', ')}`,
      before: { title: cur.title, cadence: cur.cadence, startsOn: isoDate(cur.startsOn), dueDays: cur.dueDays, dueKind: cur.dueKind, assigneeId: cur.assigneeId, active: cur.active },
      after: { automationId, changes, ...data, startsOn: c.startsOn, cadence: c.cadence },
    });
    const fresh = await tx.documentControlAutomation.findUniqueOrThrow({ where: { id: automationId }, include: automationInclude });
    return dto(fresh, await loadFullWorkCalendar(tx), todayIso());
  });
}

export interface RunResult { ran: boolean; today: string; automations: number; created: number; skipped: number; noAssignee: number; archived: number }

/**
 * Прогон автоматизаций контроля — шаг ежечасного tick (plugins/jobs.ts) и «Проверить сейчас» (automationId).
 * Своя транзакция и advisory-блокировка; ran: false — прогон уже идёт в другом процессе.
 */
export async function runControlAutomations(db: Db, opts: { now?: Date; automationId?: string } = {}): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const today = todayIso(now);
  const empty: RunResult = { ran: false, today, automations: 0, created: 0, skipped: 0, noAssignee: 0, archived: 0 };
  return withTx(db, async (tx) => {
    const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${CONTROL_LOCK}::bigint) AS ok`;
    if (!lock?.ok) return empty;
    const rows = await tx.documentControlAutomation.findMany({
      where: { active: true, document: { deletedAt: null, archivedAt: null, approvedVersionId: { not: null } }, ...(opts.automationId ? { id: opts.automationId } : {}) },
      include: {
        document: { select: { id: true, number: true, ownerId: true, archivedAt: true, approvedVersion: { select: { title: true } } } },
        control: { select: { position: true, requirement: true } },
        assignee: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const cal = await loadFullWorkCalendar(tx);
    const res: RunResult = { ...empty, ran: true, automations: rows.length };
    for (const a of rows) {
      const startsOn = isoDate(a.startsOn);
      // Не раньше дня создания автоматизации: первый запуск в прошлом не создаёт задач задним числом.
      const createdOn = todayIso(a.createdAt);
      const last = await tx.documentControlRun.findFirst({ where: { automationId: a.id }, orderBy: { nominalDate: 'desc' }, select: { nominalDate: true } });
      const lo = [startsOn, createdOn, last ? addDaysIso(isoDate(last.nominalDate), 1) : ''].sort().at(-1) as string;
      const due = nominalDates(asAny(a.cadence as ControlCadence), startsOn, lo, addDaysIso(today, MAX_SHIFT_DAYS))
        .map((nominal) => ({ nominal, planned: runDate({ dueKind: a.dueKind, startsOn }, nominal, cal) }))
        .filter((o) => o.planned <= today);
      if (!due.length) continue;
      const valid = await tx.user.findFirst({ where: { id: a.assigneeId, ...workUsersWhere() }, select: { id: true } });
      if (valid && a.noAssigneeSince) await tx.documentControlAutomation.update({ where: { id: a.id }, data: { noAssigneeSince: null } });
      let since = a.noAssigneeSince;
      if (!valid && !since) {
        since = now;
        await tx.documentControlAutomation.update({ where: { id: a.id }, data: { noAssigneeSince: since } });
      }
      const docLabel = `#${a.document.number} «${a.document.approvedVersion?.title ?? ''}»`;
      for (const o of due) {
        const late = addDaysIso(o.nominal, CATCH_UP_DAYS) < today;
        const status: RunStatus = late ? 'skipped_late' : !valid ? 'no_assignee' : 'created';
        let taskId: string | null = null;
        let eventId: string | null = null;
        if (status === 'created') {
          const ev = await tx.automationEvent.create({
            data: {
              controlAutomationId: a.id, eventType: 'remind', triggerKey: o.nominal, fireAt: day(o.planned), status: 'processed', processedAt: now,
              recipients: [{ kind: 'user', userId: a.assigneeId, name: a.assignee.fullName }] as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
          eventId = ev.id;
          const control = a.control ? `\nМеханизм контроля ${a.control.position}: ${a.control.requirement}` : '';
          const task = await tx.task.create({
            data: {
              title: a.title.slice(0, TITLE_MAX),
              description: `${a.description ? `${a.description}\n\n` : ''}Документ ${docLabel}${control}\nПериодичность: ${cadenceLabel(a.cadence as ControlCadence)}; запуск ${formatDateRu(o.nominal)}.`,
              statusId: await initialStatusId(tx, a.assigneeId),
              priorityId: await systemItemId(tx, 'task_priorities', 'normal'),
              categoryId: await systemItemId(tx, 'task_categories', CONTROL_CATEGORY_KEY),
              assigneeId: a.assigneeId,
              dueDate: day(taskDue(a, today, cal)),
              source: 'document_control',
              createdBy: null,
            },
            select: { id: true, number: true, title: true, statusId: true },
          });
          taskId = task.id;
          await recordTransition(tx, { taskId: task.id, from: null, to: task.statusId, actorId: null, kind: 'system' });
          await notifyAssignee(tx, task, null, a.assigneeId, null);
          res.created++;
        } else if (status === 'no_assignee') {
          res.noAssignee++;
        } else {
          res.skipped++;
        }
        await tx.documentControlRun.create({ data: { automationId: a.id, nominalDate: day(o.nominal), plannedDate: day(o.planned), status, taskId, eventId } });
      }
      if (!valid && since) {
        // Автору — один раз на состояние «нет ответственного» (dedupe_key — по моменту, с которого его нет).
        await notify(tx, {
          kind: 'doc_control_no_assignee', to: [a.document.ownerId], documentId: a.document.id, actorId: null,
          dedupeKey: `doc_control_no_assignee:${a.id}:${since.toISOString()}`,
          title: `Документ ${docLabel}: у автоматизации «${a.title}» нет ответственного — задачи не создаются`,
          body: 'Назначьте ответственного во вкладке «Автоматизации» карточки документа',
        });
      }
    }
    return res;
  });
}

/** «Проверить сейчас»: прогон одной автоматизации (права — как на изменение). */
export async function runAutomationNow(db: Db, actor: Actor, id: string, automationId: string, now?: Date): Promise<RunResult> {
  await manageContext(db, actor, id);
  const a = await db.documentControlAutomation.findFirst({ where: { id: automationId, documentId: id }, select: { id: true } });
  if (!a) throw notFound('Автоматизация');
  return runControlAutomations(db, { automationId, now });
}
