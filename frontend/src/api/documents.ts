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
type DocListParams = NonNullable<paths['/api/v1/documents']['get']['parameters']['query']>;
/** «Срок пересмотра»: прошёл или в ближайшие 30 / 90 / 365 дней. */
export type DocDue = NonNullable<DocListParams['due']>;
/** Порядок реестра: по типам (дерево, сначала «Политика») или по алфавиту. */
export type DocSort = NonNullable<DocListParams['sort']>;

/** Версия документа и этап на экране: устаревший экран получает 409. */
export interface At { version: number; stage: number }
/** Ответственное лицо: внешний человек — ФИО, подразделение или должность; срок — днями в драфте (21), датой на «Согласовании» (22). */
export interface PartyFields { fullName: string; department?: string; dueDate?: string; dueDays?: number }
/** Ячейка файла этапа 24 «Утверждение». */
export type ApprovalSlot = 'pdf' | 'docx' | 'translation_docx' | 'translation_pdf';

export interface DocQuery {
  archived: boolean;
  status?: DocStatus;
  waiting?: boolean;
  /** «К пересмотру» (этап 8): пересмотр просрочен или идёт, либо дата пересмотра в ближайшие 30 дней. */
  review?: boolean;
  q?: string;
  typeId?: string;
  /** Автор — владелец документа. */
  ownerId?: string;
  due?: DocDue;
  /** Пересмотр не позже даты (YYYY-MM-DD). */
  dueTo?: string;
  sort?: DocSort;
}

function qs(q: DocQuery): string {
  const p = new URLSearchParams({ archived: String(q.archived) });
  if (q.status) p.set('status', q.status);
  if (q.waiting) p.set('waiting', 'me');
  if (q.review) p.set('review', 'due');
  if (q.q?.trim()) p.set('q', q.q.trim());
  if (q.typeId) p.set('typeId', q.typeId);
  if (q.ownerId) p.set('ownerId', q.ownerId);
  if (q.due) p.set('due', q.due);
  if (q.dueTo) p.set('dueTo', q.dueTo);
  if (q.sort) p.set('sort', q.sort);
  return p.toString();
}

export const docsApi = {
  list: (q: DocQuery) => request<DocPage>('GET', `/api/v1/documents?${qs(q)}`),
  summary: () => request<DocSummary>('GET', '/api/v1/documents/summary'),
  get: (id: string) => request<DocDetail>('GET', `/api/v1/documents/${id}`),
  create: (body: NewDoc) => request<DocResult>('POST', '/api/v1/documents', body),
  update: (id: string, body: DocPatch) => request<DocResult>('PATCH', `/api/v1/documents/${id}`, body),
  /** Действие маршрута 1.11.0 (ADR-0042); «Отправить на перевод» — с подтверждением, что документ не изменялся. */
  action: (id: string, action: DocAction, body: { version: number; stage: number; comment?: string; confirmUnchanged?: boolean }) =>
    request<DocResult>('POST', `/api/v1/documents/${id}/actions/${action}`, body),
  /** Этап 24 «Утвердить»: дата утверждения и приказ; файлы — заранее, approvalFile. */
  sign: (id: string, body: { version: number; stage: number; signedOn: string; orderNo?: string; orderDate?: string | null }) => request<DocResult>('POST', `/api/v1/documents/${id}/sign`, body),
  /** Этап 24: загрузить, заменить или снять (fileId null) файл утверждения. */
  approvalFile: (id: string, body: At & { slot: ApprovalSlot; translationId?: string; fileId: string | null }) => request<DocResult>('POST', `/api/v1/documents/${id}/approval-files`, body),
  cancelRevision: (id: string, body: { version: number; comment: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/cancel-revision`, body),
  comment: (id: string, body: string) => request<DocResult>('POST', `/api/v1/documents/${id}/comments`, { body }),
  remove: (id: string, body: { version: number; comment?: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/delete`, body),
  /** Ответственные лица: автор ведёт в драфте и на «Согласовании». */
  /** Активные записи справочника «Ответственные лица» — тем, кто ведёт лиц документа (1.6.7). */
  partyDirectory: (id: string) => request<{ items: Res<'/api/v1/documents/{id}/party-directory', 'get'>['items'] }>('GET', `/api/v1/documents/${id}/party-directory`),
  addParty: (id: string, body: At & PartyFields) => request<DocResult>('POST', `/api/v1/documents/${id}/parties`, body),
  updateParty: (id: string, partyId: string, body: At & Partial<PartyFields> & { comment?: string }) => request<DocResult>('PATCH', `/api/v1/documents/${id}/parties/${partyId}`, body),
  removeParty: (id: string, partyId: string, body: At) => request<DocResult>('POST', `/api/v1/documents/${id}/parties/${partyId}/remove`, body),
  /** Отметка согласования (этап 22): дата согласования и комментарий, без файла. */
  approveParty: (id: string, partyId: string, body: At & { comment?: string; approvedOn?: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/parties/${partyId}/approve`, body),
  /** «Запросить повторно» (этап 22): отметка снимается, новый срок. */
  recheckParty: (id: string, partyId: string, body: At & { dueDate: string; comment?: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/parties/${partyId}/recheck`, body),
  /** Этап 23: переводы — язык, переводчик текстом, срок, ссылка на перевод в OnlyOffice. */
  addTranslation: (id: string, body: At & { language: string; translatorName?: string; dueDate: string; onlyofficeUrl?: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/translations`, body),
  updateTranslation: (id: string, tid: string, body: At & { language?: string; translatorName?: string; dueDate?: string; comment?: string; onlyofficeUrl?: string }) =>
    request<DocResult>('PATCH', `/api/v1/documents/${id}/translations/${tid}`, body),
  removeTranslation: (id: string, tid: string, body: At) => request<DocResult>('POST', `/api/v1/documents/${id}/translations/${tid}/remove`, body),
  addBlocker: (id: string, body: At & { text: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/blockers`, body),
  resolveBlocker: (id: string, blockerId: string, body: At & { comment: string }) => request<DocResult>('POST', `/api/v1/documents/${id}/blockers/${blockerId}/resolve`, body),
  revise: (id: string, body: DocRevise) => request<DocResult>('POST', `/api/v1/documents/${id}/revise`, body),
  archive: (id: string, version: number) => request<DocResult>('POST', `/api/v1/documents/${id}/archive`, { version }),
  restore: (id: string, version: number) => request<DocResult>('POST', `/api/v1/documents/${id}/restore`, { version }),
};

export const dkeys = {
  all: ['documents'] as const,
  list: (q: DocQuery) => ['documents', 'list', q] as const,
  detail: (id: string) => ['documents', 'detail', id] as const,
  partyDirectory: (id: string) => ['documents', 'party-directory', id] as const,
  summary: ['documents', 'summary'] as const,
  types: ['settings', 'items', 'document_types'] as const,
};
