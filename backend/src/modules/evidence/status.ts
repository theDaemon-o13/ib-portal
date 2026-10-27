// Состояние доказательства для реестра, фильтров и мониторинга. Хранится только проверка ИБ (pending, accepted,
// rejected); «истекает» и «истекло» зависят от сегодняшней даты и считаются при чтении.
import { daysBetween } from '../../lib/today.js';

export const EXPIRY_NOTICE_DAYS = 30;

export const EVIDENCE_STATES = ['pending', 'accepted', 'expiring', 'expired', 'rejected'] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export const EVIDENCE_STATE_NAMES: Record<EvidenceState, string> = {
  pending: 'На проверке',
  accepted: 'Принято',
  expiring: 'Истекает',
  expired: 'Истекло',
  rejected: 'Отклонено',
};

export const EVIDENCE_KINDS = ['form', 'decision', 'file'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EVIDENCE_KIND_NAMES: Record<EvidenceKind, string> = {
  form: 'Форма подтверждения',
  decision: 'Решение другого отдела',
  file: 'Файл',
};

/** validUntil — 'YYYY-MM-DD' или null (бессрочно). Срок действия имеет смысл только у принятого. */
export function evidenceState(status: string, validUntil: string | null, today: string): EvidenceState {
  if (status === 'pending') return 'pending';
  if (status === 'rejected') return 'rejected';
  if (!validUntil) return 'accepted';
  const left = daysBetween(today, validUntil);
  if (left < 0) return 'expired';
  if (left <= EXPIRY_NOTICE_DAYS) return 'expiring';
  return 'accepted';
}
