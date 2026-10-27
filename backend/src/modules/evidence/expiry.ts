// Срок действия доказательств (этап 7): за 30 дней до окончания — задача ответственному «Обновить доказательство».
// Через automation_events, как пересмотр документов (ADR-0008, ADR-0009, ADR-0010): событие уникально по
// (доказательство, дата окончания), создаётся и превращается в задачу в одной транзакции под блокировкой прогона.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { formatDateRu } from '../../lib/register-values.js';
import { daysBetween } from '../../lib/today.js';
import { EXPIRY_NOTICE_DAYS } from './status.js';
import { evidenceTask } from './tasks.js';

export interface ExpiryResult { events: number; tasksCreated: number; tasksCommented: number }

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Есть ли у формы замена: принятая форма того же шаблона по тому же объекту с более поздним сроком. */
async function superseded(tx: Db, e: { id: string; kind: string; templateId: string | null; recordId: string | null; documentId: string | null; systemItemId: string | null; validUntil: Date | null }) {
  if (e.kind !== 'form' || !e.validUntil) return false;
  const newer = await tx.evidence.count({
    where: {
      id: { not: e.id }, templateId: e.templateId, status: 'accepted', archivedAt: null, deletedAt: null,
      recordId: e.recordId, documentId: e.documentId, systemItemId: e.systemItemId,
      OR: [{ validUntil: null }, { validUntil: { gt: e.validUntil } }],
    },
  });
  return newer > 0;
}

export async function runEvidenceExpiry(tx: Db, opts: { today: string }): Promise<ExpiryResult> {
  const limit = day(opts.today);
  limit.setUTCDate(limit.getUTCDate() + EXPIRY_NOTICE_DAYS);
  const rows = await tx.evidence.findMany({
    where: { status: 'accepted', archivedAt: null, deletedAt: null, validUntil: { not: null, lte: limit } },
    select: { id: true, validUntil: true, owner: { select: { id: true, fullName: true } } },
  });
  const data: Prisma.AutomationEventCreateManyInput[] = rows.flatMap((e) => (e.validUntil
    ? [{
      evidenceId: e.id, eventType: 'remind', triggerKey: isoDay(e.validUntil),
      recipients: [{ kind: 'user', userId: e.owner.id, name: e.owner.fullName }] as Prisma.InputJsonValue,
      fireAt: day(opts.today),
    }]
    : []));
  const created = data.length ? (await tx.automationEvent.createMany({ data, skipDuplicates: true })).count : 0;

  const result: ExpiryResult = { events: created, tasksCreated: 0, tasksCommented: 0 };
  const events = await tx.automationEvent.findMany({
    where: { status: 'new', evidenceId: { not: null } },
    include: { evidence: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const now = new Date();
  for (const ev of events) {
    const e = ev.evidence;
    // Доказательство убрали в архив, вернули на проверку, продлили или заменили новой формой — без задачи.
    const actual = e && e.status === 'accepted' && !e.archivedAt && !e.deletedAt && e.validUntil && isoDay(e.validUntil) === ev.triggerKey;
    if (e && actual && !(await superseded(tx, e))) {
      const due = ev.triggerKey;
      const left = daysBetween(opts.today, due);
      const t = await evidenceTask(tx, {
        evidenceId: e.id,
        reason: 'expiring',
        userId: e.ownerId,
        label: 'Ответственный за доказательство',
        eventId: ev.id,
        title: `Обновить доказательство: ${e.title}`,
        description: `Доказательство #${e.number} действует до ${formatDateRu(due)}.\n`
          + 'Загрузите новую форму или файлы и отправьте на проверку: после принятия новой формы задача закроется сама.',
        repeatComment: `Срок действия ${left < 0 ? `истёк ${-left} дн. назад` : `заканчивается через ${left} дн.`} (${formatDateRu(due)})`,
        due,
      });
      await tx.automationEventTask.create({ data: { eventId: ev.id, taskId: t.taskId, action: t.action } });
      if (t.action === 'created') result.tasksCreated++;
      else result.tasksCommented++;
    }
    await tx.automationEvent.updateMany({ where: { id: ev.id, status: 'new' }, data: { status: 'processed', processedAt: now } });
  }
  if (created > 0) {
    await tx.auditLog.create({
      data: {
        userId: null, action: 'evidence.expiry_check', entity: 'evidence', entityId: null,
        diff: { summary: `Срок действия доказательств: событий — ${created}, задач — ${result.tasksCreated}`, today: opts.today } as Prisma.InputJsonValue,
      },
    });
  }
  return result;
}
