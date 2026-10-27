// Раздел «Документы»: подписи и тона без React — проверяются юнит-тестами.
import type { DocDetail, DocItem, DocStatus } from '../../api/documents';
import { formatDate } from '../registers/logic';

/** Тон плашки статуса: как в прототипе — согласование синим, просрочка красным, пересмотр оранжевым. */
export const STATUS_TONE: Record<DocStatus, string> = {
  draft: '',
  in_approval: 'acc',
  approved: 'low',
  review_overdue: 'crit',
  in_review: 'high',
};

/** «Версия 3 · ред. 3.1» — номер ставит портал, редакция — для отображения. */
export function versionLabel(v: { no: number; edition: string }): string {
  return v.edition ? `${v.no} · ред. ${v.edition}` : String(v.no);
}

/** Строка истории согласования. */
export function historyText(h: DocDetail['history'][number]): string {
  switch (h.decision) {
    case 'submitted':
      return `отправил(а) версию ${h.versionNo} на согласование`;
    case 'approved':
      return h.stage === 3 ? `утвердил(а) версию ${h.versionNo}` : `согласовал(а) этап «${h.stageName}», версия ${h.versionNo}`;
    case 'returned':
      return `вернул(а) версию ${h.versionNo} на доработку с этапа «${h.stageName}»: ${h.comment}`;
    case 'revision_started':
      return `создал(а) версию ${h.versionNo} для пересмотра${h.comment ? `: ${h.comment}` : ''}`;
  }
}

/** Пересмотр: «до 27.10.2027», «просрочен с 01.01.2026» или пусто для неутверждённого. */
export function reviewLabel(d: Pick<DocItem, 'reviewDue' | 'status'>): string {
  if (!d.reviewDue) return '—';
  return d.status === 'review_overdue' ? `просрочен с ${formatDate(d.reviewDue)}` : formatDate(d.reviewDue);
}

/** Подпись под точками маршрута: «ждёт вас», название текущего этапа или ничего. */
export function stageHint(d: Pick<DocItem, 'waitingForMe' | 'stageName'>): string {
  if (d.waitingForMe) return 'ждёт вас';
  return d.stageName ?? '';
}
