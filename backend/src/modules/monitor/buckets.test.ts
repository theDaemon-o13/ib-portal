import { describe, expect, it } from 'vitest';
import { needsReview } from '../documents/status.js';
import { bucketOf } from './service.js';

describe('распределение по срокам на мониторинге', () => {
  it('границы: −1 просрочено, 0 и 7 — 0–7, 8 и 14 — 8–14, 15 и 30 — 15–30, 31 — более 30', () => {
    expect([-1, 0, 7, 8, 14, 15, 30, 31, null].map(bucketOf)).toEqual(['overdue', 'd0_7', 'd0_7', 'd8_14', 'd8_14', 'd15_30', 'd15_30', 'd31', 'none']);
  });
});

describe('документ «к пересмотру» (KPI дашборда)', () => {
  const today = '2026-10-27';
  it('утверждённый: за 30 дней до даты — да, за 31 — нет; просрочен и на пересмотре — всегда', () => {
    expect(needsReview({ status: 'approved', reviewDue: '2026-11-26' }, today)).toBe(true);
    expect(needsReview({ status: 'approved', reviewDue: '2026-11-27' }, today)).toBe(false);
    expect(needsReview({ status: 'review_overdue', reviewDue: '2026-10-26' }, today)).toBe(true);
    expect(needsReview({ status: 'in_review', reviewDue: '2027-10-01' }, today)).toBe(true);
    expect(needsReview({ status: 'draft', reviewDue: null }, today)).toBe(false);
    expect(needsReview({ status: 'in_approval', reviewDue: null }, today)).toBe(false);
  });
});
