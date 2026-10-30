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
export type DocResult = Res<'/api/v1/documents/{id}/actions/{action}', 'post'>;
export type DocAction = DocDetail['can']['actions'][number];
export type NewDoc = Body<'/api/v1/documents', 'post'>;
export type DocPatch = Body<'/api/v1/documents/{id}', 'patch'>;
export type DocRevise = Body<'/api/v1/documents/{id}/revise', 'post'>;
export type DocSummary = Res<'/api/v1/documents/summary', 'get'>;

export interface DocQuery {
  archived: boolean;
  status?: DocStatus;
  waiting?: boolean;
  /** «К пересмотру» (этап 8): пересмотр просрочен или идёт, либо дата пересмотра в ближайшие 30 дней. */
  review?: boolean;
  q?: string;
}

function qs(q: DocQuery): string {
  const p = new URLSearchParams({ archived: String(q.archived) });
  if (q.status) p.set('status', q.status);
  if (q.waiting) p.set('waiting', 'me');
  if (q.review) p.set('review', 'due');
  if (q.q?.trim()) p.set('q', q.q.trim());
  return p.toString();
}

export const docsApi = {
  list: (q: DocQuery) => request<DocPage>('GET', `/api/v1/documents?${qs(q)}`),
  summary: () => request<DocSummary>('GET', '/api/v1/documents/summary'),
  get: (id: string) => request<DocDetail>('GET', `/api/v1/documents/${id}`),
  create: (body: NewDoc) => request<DocResult>('POST', '/api/v1/documents', body),
  update: (id: string, body: DocPatch) => request<DocResult>('PATCH', `/api/v1/documents/${id}`, body),
  /** Действие маршрута (ADR-0024): переход вперёд или возврат на «Драфт». */
  action: (id: string, action: DocAction, body: { version: number; stage: number; comment?: string; fileId?: string }) =>
    request<DocResult>('POST', `/api/v1/documents/${id}/actions/${action}`, body),
  /** Этап 16: подписанный PDF и дата подписания. */
  sign: (id: string, body: { version: number; stage: number; fileId: string; signedOn: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/sign`, body),
  cancelRevision: (id: string, body: { version: number; comment: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/cancel-revision`, body),
  addFiles: (id: string, body: { version: number; stage: number; fileIds: string[] }) => request<DocResult>('POST', `/api/v1/documents/${id}/files`, body),
  removeFile: (id: string, linkId: string, body: { version: number; stage: number }) => request<DocResult>('POST', `/api/v1/documents/${id}/files/${linkId}/remove`, body),
  comment: (id: string, body: string) => request<DocResult>('POST', `/api/v1/documents/${id}/comments`, { body }),
  remove: (id: string, body: { version: number; comment?: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/delete`, body),
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
