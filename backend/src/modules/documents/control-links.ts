// Задачи автоматизаций контроля документов (1.11.0, ADR-0043): source = 'document_control', документ — через запуск
// (document_control_runs.task_id), а не tasks.document_id (1.10.0 после отката читает причину задачи строгим списком).
// Здесь — происхождение задачи для карточки и доски («Документ #N «…» · механизм контроля …») и запрет удаления:
// задачу запуска удалить нельзя (409), архивировать можно — как задачи учебных писем (awareness-letters/links.ts).
import type { Db } from '../../lib/db.js';

/** Добавляется в taskInclude (tasks/service.ts). */
export const controlOriginInclude = {
  controlRuns: {
    take: 1,
    select: {
      nominalDate: true,
      automation: {
        select: {
          id: true, title: true,
          document: { select: { id: true, number: true, approvedVersion: { select: { title: true } } } },
          control: { select: { position: true, requirement: true } },
        },
      },
    },
  },
} as const;

interface ControlOriginRows {
  controlRuns: {
    nominalDate: Date;
    automation: { id: string; title: string; document: { id: string; number: number; approvedVersion: { title: string } | null }; control: { position: number; requirement: string } | null };
  }[];
}

export interface ControlOrigin {
  kind: 'document_control';
  document: { id: string; number: number; title: string };
  automation: { id: string; title: string };
  control: { position: number; requirement: string } | null;
  nominalDate: string;
}

export function controlOrigin(rows: ControlOriginRows): ControlOrigin | null {
  const r = rows.controlRuns[0];
  if (!r) return null;
  const d = r.automation.document;
  return {
    kind: 'document_control',
    document: { id: d.id, number: d.number, title: d.approvedVersion?.title ?? '' },
    automation: { id: r.automation.id, title: r.automation.title },
    control: r.automation.control,
    nominalDate: r.nominalDate.toISOString().slice(0, 10),
  };
}

/** Задачи, созданные автоматизацией контроля: id задачи → номер документа. */
export async function taskControlLinks(db: Db, taskIds: readonly string[]): Promise<Map<string, number>> {
  if (!taskIds.length) return new Map();
  const rows = await db.documentControlRun.findMany({
    where: { taskId: { in: [...taskIds] } },
    select: { taskId: true, automation: { select: { document: { select: { number: true } } } } },
  });
  return new Map(rows.map((r) => [r.taskId as string, r.automation.document.number]));
}

export const controlLinkMessage = (taskNumber: number, docNumber: number) =>
  `Задачу #${taskNumber} создала автоматизация контроля документа #${docNumber}: удалить её нельзя, можно отправить в архив`;
