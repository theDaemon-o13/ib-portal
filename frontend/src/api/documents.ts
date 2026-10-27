// Запросы раздела «Документы». Типы — из сгенерированной схемы OpenAPI.
import { request, type JsonOf } from './client';
import type { paths } from './generated/schema';

type Res<P extends keyof paths, M extends keyof paths[P], S extends number = 200> = paths[P][M] extends { responses: infer R }
  ? S extends keyof R ? JsonOf<R[S]> : never
  : never;
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never;

export type DocPage = Res<'/api/v1/documents', 'get'>;
export type DocItem = DocPage['items'][number];
export type DocStatus = DocItem['status'];
export type DocDetail = Res<'/api/v1/documents/{id}', 'get'>;
export type DocResult = Res<'/api/v1/documents/{id}/approve', 'post'>;
export type NewDoc = Body<'/api/v1/documents', 'post'>;
export type DocPatch = Body<'/api/v1/documents/{id}', 'patch'>;
export type DocRevise = Body<'/api/v1/documents/{id}/revise', 'post'>;
export type DocSummary = Res<'/api/v1/documents/summary', 'get'>;

export interface DocQuery {
  archived: boolean;
  status?: DocStatus;
  waiting?: boolean;
  q?: string;
}

function qs(q: DocQuery): string {
  const p = new URLSearchParams({ archived: String(q.archived) });
  if (q.status) p.set('status', q.status);
  if (q.waiting) p.set('waiting', 'me');
  if (q.q?.trim()) p.set('q', q.q.trim());
  return p.toString();
}

const route = (action: 'submit' | 'approve' | 'return') =>
  (id: string, body: { version: number; stage: number; comment?: string; pdfFileId?: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/${action}`, body);

export const docsApi = {
  list: (q: DocQuery) => request<DocPage>('GET', `/api/v1/documents?${qs(q)}`),
  summary: () => request<DocSummary>('GET', '/api/v1/documents/summary'),
  get: (id: string) => request<DocDetail>('GET', `/api/v1/documents/${id}`),
  create: (body: NewDoc) => request<DocResult>('POST', '/api/v1/documents', body),
  update: (id: string, body: DocPatch) => request<DocResult>('PATCH', `/api/v1/documents/${id}`, body),
  submit: route('submit'),
  approve: route('approve'),
  return: route('return'),
  /** Приложить или заменить итоговый PDF; замена на этапах 1–3 возвращает маршрут к началу. */
  attachPdf: (id: string, body: { version: number; stage: number; fileId: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/pdf`, body),
  revise: (id: string, body: DocRevise) => request<DocResult>('POST', `/api/v1/documents/${id}/revise`, body),
  archive: (id: string, version: number) => request<DocResult>('POST', `/api/v1/documents/${id}/archive`, { version }),
  restore: (id: string, version: number) => request<DocResult>('POST', `/api/v1/documents/${id}/restore`, { version }),
};

export const dkeys = {
  all: ['documents'] as const,
  list: (q: DocQuery) => ['documents', 'list', q] as const,
  detail: (id: string) => ['documents', 'detail', id] as const,
  summary: ['documents', 'summary'] as const,
  types: ['settings', 'items', 'document_types'] as const,
};
