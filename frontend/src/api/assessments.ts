// Запросы раздела «Самооценка» (этап Д, docs/self-assessment.md). Типы — из сгенерированной схемы OpenAPI.
// Личный раздел: все маршруты — по праву assessment.manage, решает backend.
import { fileNameFrom } from './audit';
import { ApiError, request, type JsonOf } from './client';
import type { paths } from './generated/schema';

type Res<P extends keyof paths, M extends keyof paths[P], S extends number = 200> = paths[P][M] extends { responses: infer R }
  ? S extends keyof R ? JsonOf<R[S]> : never
  : never;
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never;

export type AssessmentSummary = Res<'/api/v1/assessments', 'get'>['items'][number];
export type Assessment = Res<'/api/v1/assessments/{id}', 'get'>;
export type Methodology = Assessment['methodology'];
export type Score = Assessment['score'];
export type Answer = Assessment['answers'][number];
export type Profile = Assessment['profile'];
export type Comparison = Res<'/api/v1/assessments/compare', 'get'>;
export type LogEntry = Res<'/api/v1/assessments/{id}/log', 'get'>['items'][number];
export type SaveAnswerResult = Res<'/api/v1/assessments/{id}/answers/{code}', 'put'>;
export type NewAssessment = Body<'/api/v1/assessments', 'post'>;
export type AssessmentPatch = Body<'/api/v1/assessments/{id}', 'patch'>;
export type AnswerPatch = Body<'/api/v1/assessments/{id}/answers/{code}', 'put'>;
export type LinkedTask = Assessment['tasks'][number];
export type NewGapTask = Body<'/api/v1/assessments/{id}/answers/{code}/tasks', 'post'>;
export type Assignee = Res<'/api/v1/assessments/assignees', 'get'>['items'][number];
export type ImportResult = Res<'/api/v1/assessments/{id}/import', 'post'>;

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function errorOf(res: Response, fallback: string): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? fallback);
}

export const akeys = {
  all: ['assessments'] as const,
  list: ['assessments', 'list'] as const,
  one: (id: string) => ['assessments', 'one', id] as const,
  log: (id: string) => ['assessments', 'log', id] as const,
  history: (id: string, code: string) => ['assessments', 'history', id, code] as const,
  compare: (a: string, b: string) => ['assessments', 'compare', a, b] as const,
  assignees: ['assessments', 'assignees'] as const,
  presentation: ['assessments', 'presentation'] as const,
};

const base = '/api/v1/assessments';

export const assessmentsApi = {
  list: () => request<{ items: AssessmentSummary[] }>('GET', base),
  get: (id: string) => request<Assessment>('GET', `${base}/${id}`),
  create: (body: NewAssessment) => request<Assessment>('POST', base, body),
  update: (id: string, body: AssessmentPatch) => request<Assessment>('PATCH', `${base}/${id}`, body),
  saveAnswer: (id: string, code: string, body: AnswerPatch) => request<SaveAnswerResult>('PUT', `${base}/${id}/answers/${code}`, body),
  finalize: (id: string, version: number) => request<Assessment>('POST', `${base}/${id}/finalize`, { version }),
  reopen: (id: string, version: number, comment: string) =>
    request<Assessment>('POST', `${base}/${id}/reopen`, { version, ...(comment ? { comment } : {}) }),
  archive: (id: string, version: number) => request<Assessment>('POST', `${base}/${id}/archive`, { version }),
  /** Обновить методику черновика до активной (1.13.8): ответы сохраняются, новые разделы пустые. */
  upgradeMethodology: (id: string, version: number) => request<Assessment>('POST', `${base}/${id}/upgrade-methodology`, { version }),
  log: (id: string) => request<{ items: LogEntry[] }>('GET', `${base}/${id}/log`),
  history: (id: string, code: string) => request<{ items: LogEntry[] }>('GET', `${base}/${id}/answers/${code}/history`),
  compare: (a: string, b: string) => request<Comparison>('GET', `${base}/compare?a=${a}&b=${b}`),
  // Задачи по разрывам (Д3): ставит раздел, исполнители — сотрудники с ib.work.
  assignees: () => request<{ items: Assignee[] }>('GET', `${base}/assignees`),
  createTask: (id: string, code: string, body: NewGapTask) => request<LinkedTask>('POST', `${base}/${id}/answers/${code}/tasks`, body),
  /**
   * Импорт Excel (Д4): файл телом запроса как есть. dryRun — предпросмотр, ничего не пишет; применение — тот же файл
   * и version из предпросмотра (оценку успели изменить — 409). Файл в портале не сохраняется.
   */
  async importFile(id: string, file: File, q: { dryRun: boolean; version?: number; sourceId?: string | null }): Promise<ImportResult> {
    const p = new URLSearchParams();
    if (q.dryRun) p.set('dryRun', 'true');
    if (q.version !== undefined) p.set('version', String(q.version));
    if (q.sourceId) p.set('sourceId', q.sourceId);
    let res: Response;
    try {
      res = await fetch(`${base}/${id}/import?${p.toString()}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': XLSX_TYPE }, body: file });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Нет связи с сервером. Проверьте сеть и попробуйте ещё раз');
    }
    if (!res.ok) throw await errorOf(res, 'Не удалось прочитать файл');
    return (await res.json()) as ImportResult;
  },
  /** Строка «Спроектировано» для презентации (только чтение; правится в «Настройки → Презентация»). */
  presentationSettings: () => request<{ signature: string }>('GET', `${base}/presentation-settings`),
  /** Выгрузка таблиц для анализа; без ids — все оценки, кроме архивных. */
  async exportFile(ids?: readonly string[]): Promise<{ blob: Blob; fileName: string }> {
    const res = await fetch(`${base}/export.xlsx${ids?.length ? `?ids=${ids.join(',')}` : ''}`, { credentials: 'same-origin' });
    if (!res.ok) throw await errorOf(res, 'Не удалось выгрузить оценки');
    return { blob: await res.blob(), fileName: fileNameFrom(res.headers.get('Content-Disposition'), 'Самооценка_КБ.xlsx') };
  },
};
