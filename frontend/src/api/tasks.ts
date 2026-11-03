// Запросы раздела «Задачи». Типы — из сгенерированной схемы OpenAPI.
import { fileNameFrom } from './audit';
import { ApiError, request, type JsonOf } from './client';
import type { paths } from './generated/schema';

type Res<P extends keyof paths, M extends keyof paths[P], S extends number = 200> = paths[P][M] extends { responses: infer R }
  ? S extends keyof R ? JsonOf<R[S]> : never
  : never;
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never;

export type TaskPage = Res<'/api/v1/tasks', 'get'>;
export type Task = TaskPage['items'][number];
export type TaskDetail = Res<'/api/v1/tasks/{id}', 'get'>;
export type TaskComment = Res<'/api/v1/tasks/{id}/comments', 'get'>['items'][number];
export type TaskHistoryEntry = Res<'/api/v1/tasks/{id}/history', 'get'>['items'][number];
export type MailDraft = Res<'/api/v1/tasks/mail-draft', 'post'>;
export type NewTask = Body<'/api/v1/tasks', 'post'>;
export type TaskPatch = Body<'/api/v1/tasks/{id}', 'patch'>;
export type TaskSummary = Res<'/api/v1/tasks/summary', 'get'>;
export type TaskBulkPreview = Res<'/api/v1/tasks/bulk-delete/preview', 'post'>;
export type TaskBulkResult = Res<'/api/v1/tasks/bulk-delete/apply', 'post'>;
/** Фильтр отчёта: период — по дате создания (по умолчанию), сроку или выполнению; даты YYYY-MM-DD включительно. */
export type TaskReportFilter = NonNullable<paths['/api/v1/tasks/report']['get']['parameters']['query']>;
export type TaskStats = Res<'/api/v1/tasks/stats', 'get'>;
export type TaskStatsFilter = NonNullable<paths['/api/v1/tasks/stats']['get']['parameters']['query']>;

export const tasksApi = {
  list: (q: { archived: boolean; categoryId?: string; automationId?: string; overdue?: boolean }) =>
    request<TaskPage>('GET', `/api/v1/tasks?archived=${q.archived}${q.categoryId ? `&categoryId=${q.categoryId}` : ''}${q.automationId ? `&automationId=${q.automationId}` : ''}${q.overdue ? '&overdue=true' : ''}`),
  // Выбранные на доске (релиз 1.1.0): архив — ib.work, удаление — tasks.delete.
  bulkPreview: (action: 'archive' | 'delete', ids: string[]) => request<TaskBulkPreview>('POST', `/api/v1/tasks/bulk-${action}/preview`, { ids }),
  bulkApply: (action: 'archive' | 'delete', ids: string[], expected: { total: number; affected: number }) =>
    request<TaskBulkResult>('POST', `/api/v1/tasks/bulk-${action}/apply`, { ids, expected }),
  summary: () => request<TaskSummary>('GET', '/api/v1/tasks/summary'),
  get: (id: string) => request<TaskDetail>('GET', `/api/v1/tasks/${id}`),
  create: (body: NewTask) => request<Task>('POST', '/api/v1/tasks', body),
  update: (id: string, body: TaskPatch) => request<Task>('PATCH', `/api/v1/tasks/${id}`, body),
  // Кнопки процесса (релиз 1.2.0, ADR-0022): кто может — решает backend.
  action: (id: string, action: Task['actions'][number], version: number, comment?: string) =>
    request<Task>('POST', `/api/v1/tasks/${id}/actions/${action}`, { version, ...(comment ? { comment } : {}) }),
  // «Заменить проверяющего» (релиз 1.4.0): задача «На проверке», право «Задачи: свободная смена статуса».
  replaceReviewer: (id: string, version: number, reviewerId: string, comment?: string) =>
    request<Task>('POST', `/api/v1/tasks/${id}/reviewer`, { version, reviewerId, ...(comment ? { comment } : {}) }),
  archive: (id: string, version: number) => request<Task>('POST', `/api/v1/tasks/${id}/archive`, { version }),
  restore: (id: string, version: number) => request<Task>('POST', `/api/v1/tasks/${id}/restore`, { version }),
  remove: (id: string, version: number) => request<undefined>('POST', `/api/v1/tasks/${id}/delete`, { version }),
  comments: (id: string) => request<Res<'/api/v1/tasks/{id}/comments', 'get'>>('GET', `/api/v1/tasks/${id}/comments`),
  addComment: (id: string, body: string) => request<TaskComment>('POST', `/api/v1/tasks/${id}/comments`, { body }),
  history: (id: string) => request<Res<'/api/v1/tasks/{id}/history', 'get'>>('GET', `/api/v1/tasks/${id}/history`),
  /** Отчёт по выполненным задачам (1.6.4) — по праву tasks.report. */
  stats: (f: TaskStatsFilter) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
    return request<TaskStats>('GET', `/api/v1/tasks/stats?${p.toString()}`);
  },
  mailDraft: (raw: string) => request<MailDraft>('POST', '/api/v1/tasks/mail-draft', { raw }),
  // Отчёт в Excel (релиз 1.2.0) — по праву tasks.report; больше 100 000 задач — 409 «Сузьте период».
  async report(f: TaskReportFilter): Promise<{ blob: Blob; fileName: string }> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
    const res = await fetch(`/api/v1/tasks/report?${p.toString()}`, { credentials: 'same-origin' });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? 'Не удалось выгрузить отчёт');
    }
    return { blob: await res.blob(), fileName: fileNameFrom(res.headers.get('Content-Disposition'), 'отчёт по задачам.xlsx') };
  },
};

export const tkeys = {
  all: ['tasks'] as const,
  list: (archived: boolean, categoryId: string, overdue = false, automationId = '') => ['tasks', 'list', archived, categoryId, overdue, automationId] as const,
  detail: (id: string) => ['tasks', 'detail', id] as const,
  comments: (id: string) => ['tasks', 'comments', id] as const,
  history: (id: string) => ['tasks', 'history', id] as const,
  summary: ['tasks', 'summary'] as const,
  statuses: ['settings', 'items', 'task_statuses'] as const,
  categories: ['settings', 'items', 'task_categories'] as const,
  priorities: ['settings', 'items', 'task_priorities'] as const,
};
