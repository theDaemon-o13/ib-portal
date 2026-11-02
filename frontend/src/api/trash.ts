// Корзина (1.6.1, ADR-0033): события удаления; восстановление — только супер-администратор. Типы — из OpenAPI.
import { request, type JsonOf } from './client';
import type { paths } from './generated/schema';

type Res<P extends keyof paths, M extends keyof paths[P]> =
  paths[P][M] extends { responses: infer R } ? (200 extends keyof R ? JsonOf<R[200]> : never) : never;

export type TrashPage = Res<'/api/v1/trash', 'get'>;
export type Deletion = TrashPage['items'][number];
export type DeletionEntity = Deletion['entity'];
export interface TrashQuery { entity?: DeletionEntity; scope?: 'vulns'; nodeId?: string; groupId?: string; restored?: boolean; cursor?: string }

/** Причины удаления записей: «Ложное срабатывание» — только у уязвимостей; «Другое» — с текстом. */
export const RECORD_REASONS = [
  { code: 'wrong_import', label: 'Ошибочный импорт', vulnOnly: false },
  { code: 'false_positive', label: 'Ложное срабатывание', vulnOnly: true },
  { code: 'duplicate', label: 'Дубль', vulnOnly: false },
  { code: 'other', label: 'Другое', vulnOnly: false },
] as const;
export type RecordReasonCode = (typeof RECORD_REASONS)[number]['code'];

export const trashKeys = {
  all: ['trash'] as const,
  list: (q: TrashQuery) => ['trash', q] as const,
};

const qs = (q: Record<string, string | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const trashApi = {
  list: (q: TrashQuery) => request<TrashPage>('GET', `/api/v1/trash${qs({ ...q })}`),
  restore: (id: string, newName?: string) => request<Res<'/api/v1/trash/{id}/restore', 'post'>>('POST', `/api/v1/trash/${id}/restore`, newName ? { newName } : {}),
};

/** Причина в окне удаления: код из списка и текст. */
export interface ReasonDraft { code: RecordReasonCode | ''; text: string }
export const EMPTY_REASON: ReasonDraft = { code: '', text: '' };
export const reasonReady = (r: ReasonDraft) => r.code !== '' && (r.code !== 'other' || r.text.trim() !== '');
export const toReason = (r: ReasonDraft) => ({ reasonCode: r.code as RecordReasonCode, reason: r.text.trim() || null });
