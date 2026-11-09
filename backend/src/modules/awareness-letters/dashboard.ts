// «Ближайшая рассылка» и счётчики учебных писем для дашборда и монитора (1.9.0; docs/specs/awareness.md, раздел 20).
// Открытый запуск — задача рассылки не выполнена, не в архиве и не удалена, а письмо (если есть) ещё не отмечено
// отправленным. Этапы и просрочка — по runStages (как блок «Этапы» в карточке задачи).
// Новых видов виджета и слайда нет (расхождение 8): виджет — вид list, показатели монитора — ключи KPI.
import type { Db } from '../../lib/db.js';
import { daysBetween } from '../../lib/today.js';
import { runStages, type Stage, type StageKey } from './origin.js';

export const AWARENESS_NEXT_WIDGET = 'awareness.next';
/** Раздел «Расписание» (frontend): ссылка счётчика «Рассылки с просрочкой». */
export const SCHEDULE_LINK = '/awareness/schedule';

const STAGE_TITLES: Record<StageKey, string> = { draft: 'Черновик', review: 'Согласование', send: 'Отправка' };
const ru = (iso: string) => iso.split('-').reverse().join('.');
export const taskLink = (taskId: string) => `/tasks?task=${taskId}`;

export interface OpenRun {
  ruleTitle: string;
  plannedDate: string;
  taskId: string;
  taskNumber: number;
  stages: Stage[];
  overdue: boolean;
}

/** Открытые запуски по плановой дате (ближайший — первый). */
export async function openRuns(db: Db, today: string): Promise<OpenRun[]> {
  const rows = await db.awarenessScheduleRun.findMany({
    where: {
      task: { completedAt: null, archivedAt: null, deletedAt: null },
      OR: [{ letterId: null }, { letter: { status: { not: 'sent' } } }],
    },
    select: {
      plannedDate: true, draftDue: true, reviewDue: true,
      rule: { select: { title: true } },
      task: { select: { id: true, number: true } },
      letter: { select: { status: true, deletedAt: true } },
    },
    orderBy: [{ plannedDate: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => {
    // Удалённое письмо (1.13.3) — как будто письма нет: этапы не закрыты.
    const stages = runStages(r, r.letter && r.letter.deletedAt === null ? r.letter.status : null, today);
    return {
      ruleTitle: r.rule.title, plannedDate: r.plannedDate.toISOString().slice(0, 10), taskId: r.task.id, taskNumber: r.task.number,
      stages, overdue: stages.some((s) => s.overdue),
    };
  });
}

/** «через N дн.», «сегодня», «просрочено на N дн.». */
export function whenText(days: number): string {
  if (days === 0) return 'сегодня';
  return days > 0 ? `через ${days} дн.` : `просрочено на ${-days} дн.`;
}

/** Отметки «Отправлено» за календарный год по дате отправки (каждая отметка — одна), по типу письма. */
export async function sentThisYear(db: Db, today: string): Promise<{ year: number; planned: number; urgent: number }> {
  const year = Number(today.slice(0, 4));
  const rows = await db.$queryRaw<{ kind: string; n: bigint }[]>`
    SELECT l.kind, count(*) AS n FROM awareness_letter_events e JOIN awareness_letters l ON l.id = e.letter_id
    WHERE l.deleted_at IS NULL AND e.action = 'sent' AND e.sent_on >= ${new Date(`${year}-01-01T00:00:00Z`)} AND e.sent_on < ${new Date(`${year + 1}-01-01T00:00:00Z`)}
    GROUP BY l.kind`;
  const n = (k: string) => Number(rows.find((r) => r.kind === k)?.n ?? 0);
  return { year, planned: n('planned'), urgent: n('urgent') };
}

/** Виджет дашборда «Ближайшая рассылка»: строка ближайшей, её этапы и счётчики. */
export async function nextMailingWidget(db: Db, today: string) {
  const [runs, sent] = await Promise.all([openRuns(db, today), sentThisYear(db, today)]);
  const next = runs[0] ?? null;
  const overdue = runs.filter((r) => r.overdue).length;
  const days = next ? daysBetween(today, next.plannedDate) : null;
  return {
    key: AWARENESS_NEXT_WIDGET,
    title: 'Ближайшая рассылка',
    kind: 'list' as const,
    source: 'Осведомлённость',
    registerId: null,
    link: next ? taskLink(next.taskId) : SCHEDULE_LINK,
    total: days,
    rows: [],
    stats: [
      next && days !== null
        ? { label: `${next.ruleTitle}, ${whenText(days)}`, value: days, tone: next.overdue ? 'crit' as const : null, link: taskLink(next.taskId) }
        : { label: 'Запланированных рассылок нет', value: null, tone: null, link: SCHEDULE_LINK },
      { label: `Отправлено писем за ${sent.year}: плановых`, value: sent.planned, tone: null, link: null },
      { label: `Отправлено писем за ${sent.year}: срочных`, value: sent.urgent, tone: null, link: null },
      { label: 'Рассылки с просрочкой', value: overdue, tone: overdue ? 'crit' as const : null, link: SCHEDULE_LINK },
    ],
    items: next
      ? next.stages.map((s) => ({
        id: `${next.taskId}:${s.key}`,
        title: STAGE_TITLES[s.key],
        sub: s.done ? `выполнен · до ${ru(s.due)}` : s.overdue ? `просрочен · до ${ru(s.due)}` : `до ${ru(s.due)}`,
        date: s.due,
        days: s.done ? null : daysBetween(today, s.due),
        link: taskLink(next.taskId),
      }))
      : [],
  };
}

/** Показатели монитора: awareness_next — дней до отправки ближайшей, awareness_overdue — рассылки с просрочкой. */
export async function awarenessKpis(db: Db, today: string) {
  const runs = await openRuns(db, today);
  const next = runs[0] ?? null;
  const overdue = runs.filter((r) => r.overdue).length;
  return [
    {
      key: 'awareness_next' as const,
      label: 'Ближайшая рассылка',
      value: next ? daysBetween(today, next.plannedDate) : null,
      tone: next?.overdue ? 'bad' as const : null,
      source: next ? `${next.ruleTitle} — ${ru(next.plannedDate)}` : 'запланированных рассылок нет',
      link: next ? taskLink(next.taskId) : SCHEDULE_LINK,
    },
    {
      key: 'awareness_overdue' as const,
      label: 'Рассылки с просрочкой',
      value: overdue,
      tone: overdue ? 'bad' as const : null,
      source: 'этапы задач рассылки',
      link: SCHEDULE_LINK,
    },
  ];
}
