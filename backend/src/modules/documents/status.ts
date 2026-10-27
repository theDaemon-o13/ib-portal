// Документы (этап 6): этапы маршрута, статус и дата пересмотра — чистые функции без БД.
import type { PermissionCode } from '../../lib/permissions.js';

/** Маршрут согласования: Автор → Начальник ИБ → Юридический отдел → Утверждение правлением (правило 8). */
export const STAGES = [
  { stage: 0, name: 'Автор', perm: null },
  { stage: 1, name: 'Начальник ИБ', perm: 'docs.approve.head' },
  { stage: 2, name: 'Юридический отдел', perm: 'docs.approve.legal' },
  { stage: 3, name: 'Утверждение правлением', perm: 'docs.approve.board' },
] as const satisfies readonly { stage: number; name: string; perm: PermissionCode | null }[];

export const LAST_STAGE = STAGES.length - 1;

export const stageName = (stage: number): string => STAGES[stage]?.name ?? `этап ${stage}`;

export const DEFAULT_REVIEW_MONTHS = 12;
/** За сколько дней до даты пересмотра владельцу ставится задача. */
export const REVIEW_NOTICE_DAYS = 30;

export const DOC_STATUSES = ['draft', 'in_approval', 'approved', 'review_overdue', 'in_review'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const DOC_STATUS_NAMES: Record<DocStatus, string> = {
  draft: 'Черновик',
  in_approval: 'На согласовании',
  approved: 'Утверждён',
  review_overdue: 'Пересмотр просрочен',
  in_review: 'На пересмотре',
};

/**
 * Статус документа. Хранить его нельзя: «пересмотр просрочен» зависит от сегодняшней даты.
 * Просрочка важнее «на пересмотре»: пока новая версия не утверждена, срок пересмотра нарушен.
 */
export function docStatus(d: { hasApproved: boolean; workingStage: number | null; reviewDue: string | null }, today: string): DocStatus {
  if (!d.hasApproved) return d.workingStage !== null && d.workingStage > 0 ? 'in_approval' : 'draft';
  if (d.reviewDue !== null && d.reviewDue < today) return 'review_overdue';
  return d.workingStage !== null ? 'in_review' : 'approved';
}

/**
 * «Документ к пересмотру» (дашборд, этап 8): пересмотр просрочен или идёт, либо утверждённый документ
 * с датой пересмотра в ближайшие REVIEW_NOTICE_DAYS дней (включительно).
 */
export function needsReview(d: { status: DocStatus; reviewDue: string | null }, today: string): boolean {
  if (d.status === 'review_overdue' || d.status === 'in_review') return true;
  if (d.status !== 'approved' || d.reviewDue === null) return false;
  const left = (Date.parse(`${d.reviewDue}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return left <= REVIEW_NOTICE_DAYS;
}

/**
 * Дата + N месяцев (YYYY-MM-DD). Если такого дня в месяце нет — последний день месяца:
 * 31.01 + 1 мес. = 28.02 (29.02 в високосный год).
 */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Ссылка на файл в OnlyOffice: только http(s), без пробелов. Интеграции с API OnlyOffice пока нет (ADR-0010). */
export function isDocUrl(v: string): boolean {
  if (v.length > 2000 || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}
