// Отображение доказательств: тона состояний, подсказка сверки формы до отправки, тексты сроков.
// Окончательная сверка и снимок формы — на backend (evidence.checks).
import type { EvidenceItem, EvidenceState } from '../../api/evidence';
import type { TemplateField } from '../../api/settings';
import { formatDate } from '../registers/logic';

export const STATE_TONE: Record<EvidenceState, string> = {
  pending: 'acc',
  accepted: 'low',
  expiring: 'high',
  expired: 'crit',
  rejected: 'crit',
};

export const STATE_FILTERS: { key: EvidenceState; title: string }[] = [
  { key: 'pending', title: 'На проверке' },
  { key: 'accepted', title: 'Принято' },
  { key: 'expiring', title: 'Истекает' },
  { key: 'expired', title: 'Истекло' },
  { key: 'rejected', title: 'Отклонено' },
];

export function requirementText(f: Pick<TemplateField, 'checkKind' | 'threshold'>): string {
  if (f.checkKind === 'min') return `не менее ${f.threshold ?? 0}`;
  if (f.checkKind === 'max') return `не более ${f.threshold ?? 0}`;
  if (f.checkKind === 'yes') return 'да';
  return 'заполнено';
}

/** Отметка у поля формы, пока её заполняют: true — соответствует, false — нет, null — не заполнено. */
export function liveCheck(f: Pick<TemplateField, 'checkKind' | 'threshold'>, raw: string): boolean | null {
  const v = raw.trim();
  if (!v) return null;
  if (f.checkKind === 'yes') return v === 'да' ? true : v === 'нет' ? false : null;
  if (f.checkKind === 'text') return true;
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return f.checkKind === 'min' ? n >= (f.threshold ?? 0) : n <= (f.threshold ?? 0);
}

/** «до 27.10.2027 · осталось 12 дн.», «истекло 3 дн. назад», «бессрочно». */
export function validText(e: Pick<EvidenceItem, 'validUntil' | 'daysLeft' | 'status'>): string {
  if (!e.validUntil) return 'бессрочно';
  const date = formatDate(e.validUntil);
  if (e.status !== 'accepted' || e.daysLeft === null) return date;
  if (e.daysLeft < 0) return `${date} · истекло ${-e.daysLeft} дн. назад`;
  if (e.daysLeft <= 30) return `${date} · осталось ${e.daysLeft} дн.`;
  return date;
}

export function resultText(e: Pick<EvidenceItem, 'result'>): string | null {
  return e.result ? `${e.result.passed} из ${e.result.total}` : null;
}
