// Запросы раздела «Самооценка» (этап Д, docs/self-assessment.md). Типы — из сгенерированной схемы OpenAPI.
// Личный раздел: все маршруты — по праву assessment.manage, решает backend.
import { request, type JsonOf } from './client';
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

export const akeys = {
  all: ['assessments'] as const,
  list: ['assessments', 'list'] as const,
  one: (id: string) => ['assessments', 'one', id] as const,
  log: (id: string) => ['assessments', 'log', id] as const,
  history: (id: string, code: string) => ['assessments', 'history', id, code] as const,
  compare: (a: string, b: string) => ['assessments', 'compare', a, b] as const,
  assignees: ['assessments', 'assignees'] as const,
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
  log: (id: string) => request<{ items: LogEntry[] }>('GET', `${base}/${id}/log`),
  history: (id: string, code: string) => request<{ items: LogEntry[] }>('GET', `${base}/${id}/answers/${code}/history`),
  compare: (a: string, b: string) => request<Comparison>('GET', `${base}/compare?a=${a}&b=${b}`),
  // Задачи по разрывам (Д3): ставит раздел, исполнители — сотрудники с ib.work.
  assignees: () => request<{ items: Assignee[] }>('GET', `${base}/assignees`),
  createTask: (id: string, code: string, body: NewGapTask) => request<LinkedTask>('POST', `${base}/${id}/answers/${code}/tasks`, body),
};
