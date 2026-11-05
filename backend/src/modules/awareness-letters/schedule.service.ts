// Прогон расписания рассылок (1.9.0, ADR-0040; docs/specs/awareness.md, раздел 19.3–19.7). Шаг ежечасного tick
// (plugins/jobs.ts) после автоматизаций и «Проверить сейчас» на правиле. Своя транзакция и advisory-блокировка:
// второй экземпляр backend шаг пропускает, ошибка расписания не откатывает автоматизации.
//  - Окно: запуски с плановой датой в [сегодня; сегодня + опережение]; раньше сегодня — никогда (так ограничен догон).
//  - Идемпотентность: запуск — «правило + номинальная дата» (UNIQUE); плановая дата, этапы и задача — в той же строке.
//    Тот же день по другой номинальной дате (перенос, смена календаря) второго запуска не даёт.
//  - Задача: общая, без исполнителя, кандидаты — держатели роли (workUsersWhere); source = 'manual' без автора
//    (вариант A), связь — awareness_schedule_runs.task_id. Пока никто не взял — кандидаты обновляются каждый прогон.
//  - Шаблон правила (не в архиве) — черновик письма сразу, переменные остаются в тексте.
//  - Эскалация: за 3 рабочих дня до срока (и позже) никто не взял, или у роли нет держателей — уведомление
//    awareness_unclaimed начальнику ИБ (отметка; нет — держатели роли «Начальник ИБ»), один раз на задачу.
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { todayIso } from '../../lib/today.js';
import { isoDate, parseIsoDate, workingDaysBetween, type WorkCalendar } from '../../lib/working-days.js';
import { workUsersWhere } from '../../lib/work-users.js';
import { loadFullWorkCalendar } from '../calendar/service.js';
import { setTaskCandidates } from '../documents/tasks.js';
import { notify } from '../notifications/service.js';
import { initialStatusId, recordTransition } from '../tasks/flow.js';
import { systemItemId, TITLE_MAX } from '../tasks/service.js';
import { occurrencesInWindow, stageDates, type Cadence } from './cadence.js';
import { AWARENESS_CATEGORY_KEY } from './definition.js';
import { cleanContent, insertLetter } from './letters.service.js';

/** Ключ advisory-блокировки прогона расписания (свой, не автоматизаций). */
const SCHEDULE_LOCK = 0x1b_a1_9a;
/** Эскалация — когда до срока осталось столько рабочих дней или меньше. */
export const ESCALATE_WORKDAYS = 3;

const ru = (iso: string) => iso.split('-').reverse().join('.');
const ruShort = (iso: string) => ru(iso).slice(0, 5);
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

export interface ScheduleResult {
  ran: boolean;
  today: string;
  rules: number;
  created: number;
  letters: number;
  candidatesUpdated: number;
  escalated: number;
}

/** Держатели роли, участвующие в работе: кандидаты задачи рассылки. */
export async function roleHolders(db: Db, roleId: string): Promise<string[]> {
  const rows = await db.user.findMany({ where: { AND: [workUsersWhere(), { roles: { some: { roleId } } }] }, select: { id: true }, orderBy: { id: 'asc' } });
  return rows.map((r) => r.id);
}

/** Получатели эскалации: пользователь с отметкой «Является начальником ИБ»; нет — держатели роли «Начальник ИБ». */
export async function escalationRecipients(db: Db): Promise<string[]> {
  const head = await db.user.findMany({ where: { AND: [workUsersWhere(), { isIbHead: true }] }, select: { id: true } });
  if (head.length) return head.map((u) => u.id);
  const holders = await db.user.findMany({ where: { AND: [workUsersWhere(), { roles: { some: { role: { code: 'ib_head' } } } }] }, select: { id: true } });
  return holders.map((u) => u.id);
}

/** Описание задачи рассылки: этапы с датами текстом — 1.8.0 после отката покажет их так же. */
export function runDescription(input: { rule: string; role: string; planned: string; draftDue: string; reviewDue: string; letterNumber?: number; templateNote?: string }): string {
  return [
    `Плановая рассылка по правилу «${input.rule}». Плановая дата отправки — ${ru(input.planned)}.`,
    `Взять задачу могут держатели роли «${input.role}».`,
    '',
    'Этапы:',
    `• черновик — до ${ru(input.draftDue)}: письмо отправлено на согласование;`,
    `• согласование — до ${ru(input.reviewDue)}: письмо утверждено начальником ИБ;`,
    `• отправка — ${ru(input.planned)}: письмо отмечено отправленным.`,
    '',
    input.letterNumber
      ? `Черновик — учебное письмо № ${input.letterNumber} (из шаблона; заполните переменные).`
      : 'Черновика нет: создайте письмо из карточки задачи — «Создать письмо» или «Письмо из шаблона».',
    ...(input.templateNote ? [input.templateNote] : []),
  ].join('\n');
}

type RuleRow = Prisma.AwarenessScheduleRuleGetPayload<{ include: { role: { select: { name: true } }; template: true } }>;

/** Один запуск: задача (общая, кандидаты роли), черновик из шаблона, строка запуска, журнал. */
async function createRun(tx: Db, rule: RuleRow, occ: { nominal: string; planned: string }, today: string, cal: WorkCalendar) {
  const stages = stageDates(occ.planned, today, cal);
  const candidates = await roleHolders(tx, rule.roleId);
  const tpl = rule.template;
  const tplArchived = tpl?.archivedAt != null;
  // Черновик из шаблона: текст уже прошёл санитайзер при сохранении шаблона; лимиты могли уменьшить — тогда без черновика.
  let draft: { texts: Awaited<ReturnType<typeof cleanContent>>['texts'] } | null = null;
  let templateNote: string | undefined;
  if (tpl && tplArchived) templateNote = `Шаблон «${tpl.title}» в архиве — черновик не создан.`;
  if (tpl && !tplArchived) {
    try {
      draft = { texts: (await cleanContent(tx, { subjectRu: tpl.subjectRu, subjectTj: tpl.subjectTj, htmlRu: tpl.htmlRu, htmlTj: tpl.htmlTj }, {})).texts };
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      templateNote = `Шаблон «${tpl.title}» не подошёл (${err.message}) — черновик не создан.`;
    }
  }
  const title = `Рассылка: ${rule.title} — ${ru(occ.planned)}`.slice(0, TITLE_MAX);
  const task = await tx.task.create({
    data: {
      title,
      description: '',
      statusId: await initialStatusId(tx, null),
      priorityId: await systemItemId(tx, 'task_priorities', 'normal'),
      categoryId: await systemItemId(tx, 'task_categories', AWARENESS_CATEGORY_KEY),
      assigneeId: null,
      dueDate: day(occ.planned),
      source: 'manual',
      createdBy: null,
      recipientLabel: `Роль «${rule.role.name}»`,
    },
    select: { id: true, number: true, statusId: true },
  });
  if (candidates.length) await tx.taskCandidate.createMany({ data: candidates.map((userId) => ({ taskId: task.id, userId })) });
  await recordTransition(tx, { taskId: task.id, from: null, to: task.statusId, actorId: null, kind: 'system' });

  let letter: { id: string; number: number } | null = null;
  if (draft && tpl) {
    // Автор черновика — создатель правила (письму нужен автор); действия системы в журнале — без пользователя.
    letter = await insertLetter(tx, { id: rule.createdBy, roleNames: [], ip: null }, {
      title: `${rule.title} — ${ru(occ.planned)}`.slice(0, 200), kind: 'planned', reason: '', templateId: tpl.id, taskId: task.id,
    }, draft.texts, 'template');
    await tx.auditLog.create({
      data: {
        userId: null, action: 'awareness_letter.created', entity: 'awareness_letter', entityId: letter.id,
        diff: { summary: `Письмо № ${letter.number}: черновик из шаблона «${tpl.title}» по правилу «${rule.title}» (задача #${task.number})`, ruleId: rule.id, taskId: task.id } as Prisma.InputJsonValue,
      },
    });
  }
  await tx.task.update({
    where: { id: task.id },
    data: { description: runDescription({ rule: rule.title, role: rule.role.name, planned: occ.planned, ...stages, letterNumber: letter?.number, templateNote }) },
  });
  await tx.awarenessScheduleRun.create({
    data: {
      ruleId: rule.id, nominalDate: day(occ.nominal), plannedDate: day(occ.planned),
      draftDue: day(stages.draftDue), reviewDue: day(stages.reviewDue), taskId: task.id, letterId: letter?.id ?? null,
    },
  });
  await tx.auditLog.create({
    data: {
      userId: null, action: 'task.created', entity: 'task', entityId: task.id,
      diff: {
        summary: `Задача #${task.number} создана расписанием «${rule.title}» на ${ru(occ.planned)} (общая, могут взять: ${candidates.length})`,
        after: { source: 'manual', ruleId: rule.id, nominalDate: occ.nominal, plannedDate: occ.planned, letterId: letter?.id ?? null },
      } as Prisma.InputJsonValue,
    },
  });
  return { letter: letter !== null };
}

/** Кандидаты открытых невзятых задач рассылки — по текущим держателям роли правила. */
async function refreshCandidates(tx: Db, ruleIds?: string[]): Promise<number> {
  const runs = await tx.awarenessScheduleRun.findMany({
    where: {
      ...(ruleIds ? { ruleId: { in: ruleIds } } : {}),
      task: { assigneeId: null, completedAt: null, archivedAt: null, deletedAt: null },
    },
    select: { taskId: true, rule: { select: { roleId: true } }, task: { select: { candidates: { select: { userId: true } } } } },
  });
  const holders = new Map<string, string[]>();
  let changed = 0;
  for (const r of runs) {
    if (!holders.has(r.rule.roleId)) holders.set(r.rule.roleId, await roleHolders(tx, r.rule.roleId));
    const next = holders.get(r.rule.roleId) ?? [];
    const was = r.task.candidates.map((c) => c.userId);
    if (was.length === next.length && was.every((id) => next.includes(id))) continue;
    await setTaskCandidates(tx, r.taskId, was, next);
    changed++;
  }
  return changed;
}

/** Эскалация невзятых задач: за ESCALATE_WORKDAYS рабочих дня до срока и позже, или без кандидатов — один раз. */
async function escalate(tx: Db, today: string, cal: WorkCalendar, ruleIds?: string[]): Promise<number> {
  const runs = await tx.awarenessScheduleRun.findMany({
    where: {
      ...(ruleIds ? { ruleId: { in: ruleIds } } : {}),
      escalatedAt: null,
      task: { assigneeId: null, completedAt: null, archivedAt: null, deletedAt: null },
    },
    select: {
      id: true, plannedDate: true, rule: { select: { title: true } },
      task: { select: { id: true, number: true, _count: { select: { candidates: true } } } },
    },
  });
  let count = 0;
  let recipients: string[] | null = null;
  for (const r of runs) {
    const planned = isoDate(r.plannedDate);
    const left = planned <= today ? 0 : workingDaysBetween(parseIsoDate(today), r.plannedDate, cal);
    if (left > ESCALATE_WORKDAYS && r.task._count.candidates > 0) continue;
    recipients ??= await escalationRecipients(tx);
    await notify(tx, {
      kind: 'awareness_unclaimed',
      to: recipients,
      title: `Рассылку «${r.rule.title}» никто не взял, срок ${ruShort(planned)}`,
      body: r.task._count.candidates ? `Задача #${r.task.number}` : `Задача #${r.task.number}: у роли нет сотрудников — назначьте исполнителя`,
      taskId: r.task.id,
      actorId: null,
      dedupeKey: `awareness_unclaimed:${r.task.id}`,
    });
    await tx.awarenessScheduleRun.update({ where: { id: r.id }, data: { escalatedAt: new Date() } });
    count++;
  }
  return count;
}

/**
 * Прогон расписания. ruleId — «Проверить сейчас» для одного правила (только активного и не в архиве).
 * Возвращает ran: false, если прогон уже идёт в другом процессе.
 */
export async function runAwarenessSchedule(db: Db, opts: { now?: Date; ruleId?: string } = {}): Promise<ScheduleResult> {
  const today = todayIso(opts.now ?? new Date());
  const empty: ScheduleResult = { ran: false, today, rules: 0, created: 0, letters: 0, candidatesUpdated: 0, escalated: 0 };
  return withTx(db, async (tx) => {
    const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(${SCHEDULE_LOCK}::bigint) AS ok`;
    if (!lock?.ok) return empty;
    const rules = await tx.awarenessScheduleRule.findMany({
      where: { active: true, archivedAt: null, ...(opts.ruleId ? { id: opts.ruleId } : {}) },
      include: { role: { select: { name: true } }, template: true },
      orderBy: { createdAt: 'asc' },
    });
    const cal = await loadFullWorkCalendar(tx);
    let created = 0;
    let letters = 0;
    for (const rule of rules) {
      const occs = occurrencesInWindow({ cadence: rule.cadence as Cadence, startsOn: isoDate(rule.startsOn), leadDays: rule.leadDays }, today, cal);
      if (!occs.length) continue;
      const existing = await tx.awarenessScheduleRun.findMany({
        where: { ruleId: rule.id, OR: [{ nominalDate: { in: occs.map((o) => day(o.nominal)) } }, { plannedDate: { in: occs.map((o) => day(o.planned)) } }] },
        select: { nominalDate: true, plannedDate: true },
      });
      const nominals = new Set(existing.map((e) => isoDate(e.nominalDate)));
      const planneds = new Set(existing.map((e) => isoDate(e.plannedDate)));
      for (const occ of occs) {
        if (nominals.has(occ.nominal) || planneds.has(occ.planned)) continue;
        const r = await createRun(tx, rule, occ, today, cal);
        planneds.add(occ.planned);
        created++;
        if (r.letter) letters++;
      }
    }
    const scope = opts.ruleId ? [opts.ruleId] : undefined;
    const candidatesUpdated = await refreshCandidates(tx, scope);
    const escalated = await escalate(tx, today, cal, scope);
    if (created || escalated) {
      await tx.auditLog.create({
        data: {
          userId: null, action: 'awareness_schedule.run', entity: 'awareness_rule', entityId: opts.ruleId ?? null,
          diff: { summary: `Расписание рассылок: создано задач ${created}, черновиков ${letters}, эскалаций ${escalated}`, today, created, letters, escalated, candidatesUpdated } as Prisma.InputJsonValue,
        },
      });
    }
    return { ran: true, today, rules: rules.length, created, letters, candidatesUpdated, escalated };
  });
}

/** «Проверить сейчас» на правиле: тот же прогон для одного правила. */
export async function checkRuleNow(db: Db, ruleId: string, now?: Date): Promise<ScheduleResult> {
  const rule = await db.awarenessScheduleRule.findUnique({ where: { id: ruleId }, select: { active: true, archivedAt: true } });
  if (!rule) throw new AppError(404, 'NOT_FOUND', 'Правило не найдено');
  if (!rule.active || rule.archivedAt) throw new AppError(409, 'RULE_INACTIVE', 'Правило отключено или в архиве — оно не создаёт задач');
  const r = await runAwarenessSchedule(db, { now, ruleId });
  if (!r.ran) throw new AppError(409, 'SCHEDULE_BUSY', 'Расписание сейчас проверяется фоновым прогоном. Повторите через минуту');
  return r;
}
