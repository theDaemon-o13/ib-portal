// Контроль пересмотра документов (этап 6): за 30 дней до даты пересмотра — задача владельцу.
// Идёт через automation_events, как автоматизации реестров (ADR-0008, ADR-0009): событие уникально по
// (документ, дата пересмотра), создаётся и превращается в задачу в одной транзакции под блокировкой прогона.
// Повторный прогон дублей не даёт; смена цикла (новая дата) — новое событие.
import type { Prisma } from '@prisma/client';
import type { Db } from '../../lib/db.js';
import { daysBetween } from '../../lib/today.js';
import { formatDateRu } from '../../lib/register-values.js';
import { REVIEW_NOTICE_DAYS } from './status.js';
import { documentTask } from './tasks.js';

export interface ReviewResult {
  events: number;
  tasksCreated: number;
  tasksCommented: number;
}

/** Последний день, при котором пора ставить задачу: дата пересмотра ≤ сегодня + 30 дней. */
function noticeLimit(today: string): Date {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + REVIEW_NOTICE_DAYS);
  return d;
}

export async function runDocumentReviews(tx: Db, opts: { today: string }): Promise<ReviewResult> {
  // Утверждённые документы без новой версии в работе: если пересмотр уже начат, задача не нужна.
  const docs = await tx.document.findMany({
    where: { archivedAt: null, approvedVersionId: { not: null }, workingVersionId: null, reviewDue: { lte: noticeLimit(opts.today) } },
    select: { id: true, reviewDue: true, owner: { select: { id: true, fullName: true } } },
  });
  const data: Prisma.AutomationEventCreateManyInput[] = docs.flatMap((d) => (d.reviewDue
    ? [{
      documentId: d.id, eventType: 'remind', triggerKey: d.reviewDue.toISOString().slice(0, 10),
      recipients: [{ kind: 'user', userId: d.owner.id, name: d.owner.fullName }] as Prisma.InputJsonValue,
      fireAt: new Date(`${opts.today}T00:00:00Z`),
    }]
    : []));
  const created = data.length ? (await tx.automationEvent.createMany({ data, skipDuplicates: true })).count : 0;

  const result: ReviewResult = { events: created, tasksCreated: 0, tasksCommented: 0 };
  const events = await tx.automationEvent.findMany({
    where: { status: 'new', documentId: { not: null } },
    include: { document: { include: { approvedVersion: { select: { title: true, no: true } } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const now = new Date();
  for (const e of events) {
    const d = e.document;
    // Документ успели убрать в архив или начали пересмотр — событие закрывается без задачи.
    if (d && !d.archivedAt && !d.workingVersionId && d.approvedVersion) {
      const due = e.triggerKey;
      const left = daysBetween(opts.today, due);
      const t = await documentTask(tx, {
        documentId: d.id,
        reason: 'review',
        eventId: e.id,
        title: `Пересмотреть документ «${d.approvedVersion.title}»`,
        description: `Документ #${d.number}, действующая версия ${d.approvedVersion.no}. Пересмотр — до ${formatDateRu(due)}.\n`
          + 'Создайте новую версию (с изменениями или без) и отправьте её на согласование: задача закроется, когда версию утвердят.',
        repeatComment: `Срок пересмотра ${left < 0 ? `просрочен на ${-left} дн.` : `через ${left} дн.`} (${formatDateRu(due)})`,
        due,
      });
      await tx.automationEventTask.create({ data: { eventId: e.id, taskId: t.taskId, action: t.action } });
      if (t.action === 'created') result.tasksCreated++;
      else result.tasksCommented++;
    }
    await tx.automationEvent.updateMany({ where: { id: e.id, status: 'new' }, data: { status: 'processed', processedAt: now } });
  }
  if (created > 0) {
    await tx.auditLog.create({
      data: {
        userId: null, action: 'document.review_check', entity: 'document', entityId: null,
        diff: { summary: `Пересмотр документов: событий — ${created}, задач — ${result.tasksCreated}`, today: opts.today } as Prisma.InputJsonValue,
      },
    });
  }
  return result;
}
