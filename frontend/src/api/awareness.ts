// Запросы раздела «Осведомлённость → учебные письма» (1.9.0, ADR-0039, ADR-0040). Типы — из сгенерированной схемы
// OpenAPI. Права решает backend: интерфейс только прячет кнопки по `actions`.
import { fileNameFrom } from './audit';
import { ApiError, request, type JsonOf } from './client';
import type { paths } from './generated/schema';

type Res<P extends keyof paths, M extends keyof paths[P], S extends number = 200> = paths[P][M] extends { responses: infer R }
  ? S extends keyof R ? JsonOf<R[S]> : never
  : never;
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never;

export type LetterPage = Res<'/api/v1/awareness/letters', 'get'>;
export type LetterItem = LetterPage['items'][number];
export type Letter = Res<'/api/v1/awareness/letters/{id}', 'get'>;
export type LetterContent = Letter['content'];
export type LetterSave = Res<'/api/v1/awareness/letters/{id}', 'put'>;
export type LetterSaveBody = Body<'/api/v1/awareness/letters/{id}', 'put'>;
export type NewLetter = Body<'/api/v1/awareness/letters', 'post'>;
export type LetterVersion = Res<'/api/v1/awareness/letters/{id}/versions/{no}', 'get'>;
export type LetterSent = Res<'/api/v1/awareness/letters/{id}/send', 'post'>;
export type LetterAction = Letter['actions'][number];
export type LetterStatus = Letter['status'];
export type LetterKind = Letter['kind'];
export type ExportLang = Letter['exportLangs'][number];
export type ExportHtml = Res<'/api/v1/awareness/letters/{id}/export/html', 'get'>;
export type ExportPrint = Res<'/api/v1/awareness/letters/{id}/export/print', 'get'>;
export type Audience = Res<'/api/v1/awareness/audiences', 'get'>['items'][number];
export type LetterRef = Res<'/api/v1/awareness/letters/refs', 'get'>['items'][number];

export type TemplatePage = Res<'/api/v1/awareness/templates', 'get'>;
export type TemplateItem = TemplatePage['items'][number];
export type Template = Res<'/api/v1/awareness/templates/{id}', 'get'>;
export type TemplateSave = Res<'/api/v1/awareness/templates/{id}', 'put'>;
export type TemplateBody = Body<'/api/v1/awareness/templates', 'post'>;
export type FromTemplateBody = Body<'/api/v1/awareness/templates/{id}/letter', 'post'>;
export type Signature = Res<'/api/v1/awareness/signature', 'get'>;
export type SignatureSave = Res<'/api/v1/awareness/signature', 'put'>;

export type RulePage = Res<'/api/v1/awareness/rules', 'get'>;
export type RuleItem = RulePage['items'][number];
export type Rule = Res<'/api/v1/awareness/rules/{id}', 'get'>;
export type RuleBody = Body<'/api/v1/awareness/rules', 'post'>;
export type Cadence = RuleBody['cadence'];
export type PreviewDate = Res<'/api/v1/awareness/rules/preview', 'post'>['dates'][number];
export type WorkRole = Res<'/api/v1/awareness/rules/roles', 'get'>['items'][number];
export type RunResult = Res<'/api/v1/awareness/rules/{id}/run', 'post'>;

type Scope = 'active' | 'archived' | 'all';
const qs = (o: Record<string, string | number | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
};

export const awarenessApi = {
  // ——— письма
  letters: (q: { scope?: Scope; status?: LetterStatus; kind?: LetterKind; q?: string; limit?: number }) =>
    request<LetterPage>('GET', `/api/v1/awareness/letters${qs({ ...q, limit: q.limit ?? 200 })}`),
  letter: (id: string) => request<Letter>('GET', `/api/v1/awareness/letters/${id}`),
  createLetter: (body: NewLetter) => request<LetterSave>('POST', '/api/v1/awareness/letters', body),
  saveLetter: (id: string, body: LetterSaveBody) => request<LetterSave>('PUT', `/api/v1/awareness/letters/${id}`, body),
  version: (id: string, no: number) => request<LetterVersion>('GET', `/api/v1/awareness/letters/${id}/versions/${no}`),
  restore: (id: string, no: number, version: number, confirmDropApproval?: boolean) =>
    request<Letter>('POST', `/api/v1/awareness/letters/${id}/versions/${no}/restore`, { version, ...(confirmDropApproval ? { confirmDropApproval } : {}) }),
  submit: (id: string, version: number) => request<Letter>('POST', `/api/v1/awareness/letters/${id}/submit`, { version }),
  withdraw: (id: string, version: number) => request<Letter>('POST', `/api/v1/awareness/letters/${id}/withdraw`, { version }),
  approve: (id: string, version: number, comment?: string) =>
    request<Letter>('POST', `/api/v1/awareness/letters/${id}/approve`, { version, ...(comment ? { comment } : {}) }),
  returnLetter: (id: string, version: number, comment: string) => request<Letter>('POST', `/api/v1/awareness/letters/${id}/return`, { version, comment }),
  send: (id: string, body: { version: number; sentOn: string; audience: string; comment?: string }) =>
    request<LetterSent>('POST', `/api/v1/awareness/letters/${id}/send`, body),
  copy: (id: string) => request<Letter>('POST', `/api/v1/awareness/letters/${id}/copy`),
  archive: (id: string, version: number, archived: boolean) =>
    request<Letter>('POST', `/api/v1/awareness/letters/${id}/${archived ? 'archive' : 'unarchive'}`, { version }),
  urgent: (body: { title: string; reason: string; templateId?: string | null }) => request<LetterSave>('POST', '/api/v1/awareness/urgent', body),
  fromTask: (taskId: string, body: { title: string; templateId?: string; values?: Record<string, string> }) =>
    request<LetterSave>('POST', `/api/v1/awareness/tasks/${taskId}/letter`, body),
  audiences: (q?: string) => request<{ items: Audience[] }>('GET', `/api/v1/awareness/audiences${qs({ q })}`),
  refs: (numbers: number[]) => request<{ items: LetterRef[] }>('GET', `/api/v1/awareness/letters/refs?numbers=${numbers.join(',')}`),

  // ——— экспорт
  exportHtml: (id: string, lang: ExportLang, version?: number) =>
    request<ExportHtml>('GET', `/api/v1/awareness/letters/${id}/export/html${qs({ lang, version })}`),
  exportPrint: (id: string, lang: ExportLang, version?: number) =>
    request<ExportPrint>('GET', `/api/v1/awareness/letters/${id}/export/print${qs({ lang, version })}`),
  /** .eml файлом: имя — из Content-Disposition (название письма). */
  exportEml: async (id: string, lang: ExportLang, version?: number): Promise<{ blob: Blob; fileName: string }> => {
    const res = await fetch(`/api/v1/awareness/letters/${id}/export.eml${qs({ lang, version })}`, { credentials: 'same-origin' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(res.status, body?.error?.code ?? 'EXPORT_FAILED', body?.error?.message ?? 'Не удалось выгрузить письмо');
    }
    return { blob: await res.blob(), fileName: fileNameFrom(res.headers.get('Content-Disposition'), 'Письмо.eml') };
  },

  // ——— шаблоны и подпись
  templates: (q: { scope?: Scope; q?: string } = {}) => request<TemplatePage>('GET', `/api/v1/awareness/templates${qs({ ...q, limit: 200 })}`),
  template: (id: string) => request<Template>('GET', `/api/v1/awareness/templates/${id}`),
  createTemplate: (body: TemplateBody) => request<TemplateSave>('POST', '/api/v1/awareness/templates', body),
  saveTemplate: (id: string, body: TemplateBody & { version: number }) => request<TemplateSave>('PUT', `/api/v1/awareness/templates/${id}`, body),
  archiveTemplate: (id: string, version: number, archived: boolean) =>
    request<Template>('POST', `/api/v1/awareness/templates/${id}/${archived ? 'archive' : 'unarchive'}`, { version }),
  fromTemplate: (id: string, body: FromTemplateBody) => request<LetterSave>('POST', `/api/v1/awareness/templates/${id}/letter`, body),
  signature: () => request<Signature>('GET', '/api/v1/awareness/signature'),
  saveSignature: (body: { htmlRu: string; htmlTj: string; version: number }) => request<SignatureSave>('PUT', '/api/v1/awareness/signature', body),

  // ——— расписание
  rules: (scope: Scope = 'active') => request<RulePage>('GET', `/api/v1/awareness/rules${qs({ scope })}`),
  rule: (id: string) => request<Rule>('GET', `/api/v1/awareness/rules/${id}`),
  workRoles: () => request<{ items: WorkRole[] }>('GET', '/api/v1/awareness/rules/roles'),
  preview: (body: { cadence: Cadence; startsOn: string }) =>
    request<{ cadenceText: string; dates: PreviewDate[] }>('POST', '/api/v1/awareness/rules/preview', body),
  createRule: (body: RuleBody) => request<Rule>('POST', '/api/v1/awareness/rules', body),
  saveRule: (id: string, body: RuleBody & { version: number }) => request<Rule>('PUT', `/api/v1/awareness/rules/${id}`, body),
  archiveRule: (id: string, version: number, archived: boolean) =>
    request<Rule>('POST', `/api/v1/awareness/rules/${id}/${archived ? 'archive' : 'unarchive'}`, { version }),
  runRule: (id: string) => request<RunResult>('POST', `/api/v1/awareness/rules/${id}/run`),
};

export const awarenessKeys = {
  letters: ['awareness', 'letters'] as const,
  letter: (id: string) => ['awareness', 'letter', id] as const,
  version: (id: string, no: number) => ['awareness', 'letter', id, 'version', no] as const,
  templates: ['awareness', 'templates'] as const,
  template: (id: string) => ['awareness', 'template', id] as const,
  signature: ['awareness', 'signature'] as const,
  rules: ['awareness', 'rules'] as const,
  rule: (id: string) => ['awareness', 'rule', id] as const,
  roles: ['awareness', 'roles'] as const,
  refs: (numbers: readonly number[]) => ['awareness', 'refs', ...numbers] as const,
};
