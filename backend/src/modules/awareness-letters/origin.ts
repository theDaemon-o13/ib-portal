// Происхождение задач модуля писем (1.9.0, вариант A; docs/specs/awareness.md, раздел 19.5): задачи модуля —
// source = 'manual' без автора, поэтому «откуда задача» берётся по таблицам модуля. Карточка и доска показывают
// «Создана расписанием: <правило>» или «Учебное письмо № N» вместо «поставлена вручную»; блок «Этапы» — по статусу
// письма (этап отметить вручную нельзя). Здесь — только include для Prisma и сборка DTO, без зависимостей от задач.
import type { LetterStatus } from './flow.js';

const letterBrief = { select: { id: true, number: true, status: true, kind: true, deletedAt: true } } as const;

/** Добавляется в taskInclude (tasks/service.ts). */
export const taskOriginInclude = {
  awarenessRun: {
    select: {
      plannedDate: true, draftDue: true, reviewDue: true,
      rule: { select: { id: true, title: true } },
      letter: letterBrief,
    },
  },
  awarenessLetters: { ...letterBrief, take: 1, orderBy: { number: 'asc' } },
  awarenessEvents: { select: { letter: letterBrief }, where: { action: 'returned' }, take: 1, orderBy: { at: 'asc' } },
} as const;

interface LetterRow { id: string; number: number; status: string; kind: string; deletedAt: Date | null }
export interface OriginRows {
  awarenessRun: { plannedDate: Date; draftDue: Date; reviewDue: Date; rule: { id: string; title: string }; letter: LetterRow | null } | null;
  awarenessLetters: LetterRow[];
  awarenessEvents: { letter: LetterRow }[];
}

export type StageKey = 'draft' | 'review' | 'send';
export interface Stage { key: StageKey; due: string; done: boolean; overdue: boolean }
/** deleted (1.13.3): письмо удалено — карточка задачи показывает «письмо удалено» без ссылки. */
export interface OriginLetter { id: string; number: number; status: LetterStatus; deleted: boolean }

export type TaskOrigin =
  | { kind: 'schedule'; rule: { id: string; title: string }; plannedDate: string; letter: OriginLetter | null; stages: Stage[]; letterSent: boolean }
  | { kind: 'letter'; reason: 'urgent' | 'rework'; letter: OriginLetter; letterSent: boolean };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const brief = (l: LetterRow): OriginLetter => ({ id: l.id, number: l.number, status: l.status as LetterStatus, deleted: l.deletedAt !== null });

/** Этап выполнен по статусу письма: черновик — отправлено на согласование, согласование — утверждено, отправка — отмечено. */
const DONE: Record<StageKey, readonly string[]> = {
  draft: ['review', 'approved', 'sent'],
  review: ['approved', 'sent'],
  send: ['sent'],
};

/** Этапы запуска по статусу письма; просрочен — невыполненный этап с датой раньше сегодня. Общая для карточки и дашборда. */
export function runStages(run: { draftDue: Date; reviewDue: Date; plannedDate: Date }, letterStatus: string | null, today: string): Stage[] {
  return ([['draft', run.draftDue], ['review', run.reviewDue], ['send', run.plannedDate]] as const).map(([key, d]) => {
    const due = iso(d);
    const done = letterStatus !== null && DONE[key].includes(letterStatus);
    return { key, due, done, overdue: !done && due < today };
  });
}

export function taskOrigin(rows: OriginRows, today: string): TaskOrigin | null {
  const run = rows.awarenessRun;
  if (run) {
    // Письмо запуска: черновик из шаблона или созданное из задачи — по letterId; на случай старых строк — по task_id.
    const letter = run.letter ?? rows.awarenessLetters[0] ?? null;
    // Удалённое письмо этапы не закрывает (оно никогда не отправлялось): как будто письма нет.
    const status = letter && letter.deletedAt === null ? letter.status : null;
    const stages = runStages(run, status, today);
    return {
      kind: 'schedule', rule: run.rule, plannedDate: iso(run.plannedDate), letter: letter ? brief(letter) : null, stages, letterSent: status === 'sent',
    };
  }
  const own = rows.awarenessLetters[0];
  if (own) return { kind: 'letter', reason: own.kind === 'urgent' ? 'urgent' : 'rework', letter: brief(own), letterSent: own.status === 'sent' };
  const ev = rows.awarenessEvents[0];
  if (ev) return { kind: 'letter', reason: 'rework', letter: brief(ev.letter), letterSent: ev.letter.status === 'sent' };
  return null;
}
