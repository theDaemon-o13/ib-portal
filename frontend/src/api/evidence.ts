// Запросы раздела «Доказательства». Типы — из сгенерированной схемы OpenAPI.
import { request, type JsonOf } from './client';
import type { paths } from './generated/schema';

type Res<P extends keyof paths, M extends keyof paths[P], S extends number = 200> = paths[P][M] extends { responses: infer R }
  ? S extends keyof R ? JsonOf<R[S]> : never
  : never;
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never;

export type EvidencePage = Res<'/api/v1/evidence', 'get'>;
export type EvidenceItem = EvidencePage['items'][number];
export type EvidenceState = EvidenceItem['state'];
export type EvidenceDetail = Res<'/api/v1/evidence/{id}', 'get'>;
export type NewEvidence = Body<'/api/v1/evidence', 'post'>;
export type Coverage = Res<'/api/v1/evidence/coverage', 'get'>;
export type EvidenceSummary = Res<'/api/v1/evidence/summary', 'get'>;

export interface EvidenceQuery {
  archived: boolean;
  state?: EvidenceState;
  q?: string;
}

function qs(q: EvidenceQuery): string {
  const p = new URLSearchParams({ archived: String(q.archived) });
  if (q.state) p.set('state', q.state);
  if (q.q?.trim()) p.set('q', q.q.trim());
  return p.toString();
}

export const evidenceApi = {
  list: (q: EvidenceQuery) => request<EvidencePage>('GET', `/api/v1/evidence?${qs(q)}`),
  summary: () => request<EvidenceSummary>('GET', '/api/v1/evidence/summary'),
  coverage: (templateId: string) => request<Coverage>('GET', `/api/v1/evidence/coverage?templateId=${templateId}`),
  get: (id: string) => request<EvidenceDetail>('GET', `/api/v1/evidence/${id}`),
  create: (body: NewEvidence) => request<EvidenceDetail>('POST', '/api/v1/evidence', body),
  update: (id: string, body: { version: number; title?: string; ownerId?: string }) => request<EvidenceDetail>('PATCH', `/api/v1/evidence/${id}`, body),
  addFiles: (id: string, version: number, fileIds: string[]) => request<EvidenceDetail>('POST', `/api/v1/evidence/${id}/files`, { version, fileIds }),
  removeFile: (id: string, fileId: string, version: number) => request<EvidenceDetail>('POST', `/api/v1/evidence/${id}/files/${fileId}/remove`, { version }),
  review: (id: string, body: { version: number; decision: 'accept' | 'reject'; comment?: string }) => request<EvidenceDetail>('POST', `/api/v1/evidence/${id}/review`, body),
  archive: (id: string, version: number) => request<EvidenceDetail>('POST', `/api/v1/evidence/${id}/archive`, { version }),
  restore: (id: string, version: number) => request<EvidenceDetail>('POST', `/api/v1/evidence/${id}/restore`, { version }),
};

export const ekeys = {
  all: ['evidence'] as const,
  list: (q: EvidenceQuery) => ['evidence', 'list', q] as const,
  detail: (id: string) => ['evidence', 'detail', id] as const,
  summary: ['evidence', 'summary'] as const,
  coverage: (templateId: string) => ['evidence', 'coverage', templateId] as const,
};
