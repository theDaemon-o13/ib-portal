// Запросы конструктора реестров. Типы — из сгенерированной схемы OpenAPI.
import { ApiError, request, type JsonOf } from './client';
import type { paths } from './generated/schema';

type Res<P extends keyof paths, M extends keyof paths[P], S extends number = 200> = paths[P][M] extends { responses: infer R }
  ? S extends keyof R ? JsonOf<R[S]> : never
  : never;
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never;

export type RegisterListItem = Res<'/api/v1/registers', 'get'>['items'][number];
export type RegisterDetail = Res<'/api/v1/registers/{id}', 'get'>;
export type RegisterField = RegisterDetail['fields'][number];
export type FieldOption = RegisterField['options'][number];
export type FieldType = RegisterField['type'];
export type CalcRule = NonNullable<RegisterField['calcRule']>;
export type RecordPage = Res<'/api/v1/registers/{id}/records', 'get'>;
export type RegisterRecord = RecordPage['items'][number];
export type HistoryEntry = Res<'/api/v1/register-records/{id}/history', 'get'>['items'][number];
export type TypePreview = Res<'/api/v1/register-fields/{id}/type/preview', 'post'>;
export type ImportPreview = Res<'/api/v1/registers/{id}/imports', 'post', 201>;
export type ImportResult = Res<'/api/v1/register-imports/{id}/apply', 'post'>;
export type NewField = Body<'/api/v1/registers/{id}/fields', 'post'>;
export type FieldPatch = Body<'/api/v1/register-fields/{id}', 'patch'>;
export type RecordValues = Body<'/api/v1/registers/{id}/records', 'post'>['values'];

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface RecordQuery {
  q?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  includeArchived?: boolean;
  cursor?: string;
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Имя файла из Content-Disposition (filename*=UTF-8''…). */
export function fileNameFrom(header: string | null, fallback: string): string {
  const m = header ? /filename\*=UTF-8''([^;]+)/i.exec(header) : null;
  if (!m?.[1]) return fallback;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return fallback;
  }
}

async function errorOf(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? 'Не удалось выполнить запрос');
}

export const registersApi = {
  list: (includeArchived: boolean) =>
    request<Res<'/api/v1/registers', 'get'>>('GET', `/api/v1/registers${includeArchived ? '?includeArchived=true' : ''}`),
  get: (id: string) => request<RegisterDetail>('GET', `/api/v1/registers/${id}`),
  create: (body: Body<'/api/v1/registers', 'post'>) => request<RegisterDetail>('POST', '/api/v1/registers', body),
  update: (id: string, body: Body<'/api/v1/registers/{id}', 'patch'>) => request<RegisterDetail>('PATCH', `/api/v1/registers/${id}`, body),
  archive: (id: string, version: number) => request<RegisterDetail>('POST', `/api/v1/registers/${id}/archive`, { version }),
  restore: (id: string, version: number) => request<RegisterDetail>('POST', `/api/v1/registers/${id}/restore`, { version }),

  addField: (registerId: string, body: NewField) => request<RegisterDetail>('POST', `/api/v1/registers/${registerId}/fields`, body),
  updateField: (id: string, body: FieldPatch) => request<RegisterDetail>('PATCH', `/api/v1/register-fields/${id}`, body),
  moveField: (id: string, direction: 'up' | 'down') => request<RegisterDetail>('POST', `/api/v1/register-fields/${id}/move`, { direction }),
  archiveField: (id: string, version: number) => request<RegisterDetail>('POST', `/api/v1/register-fields/${id}/archive`, { version }),
  restoreField: (id: string, version: number) => request<RegisterDetail>('POST', `/api/v1/register-fields/${id}/restore`, { version }),
  deleteField: (id: string, version: number) => request<RegisterDetail>('POST', `/api/v1/register-fields/${id}/delete`, { version }),
  previewType: (id: string, to: FieldType) => request<TypePreview>('POST', `/api/v1/register-fields/${id}/type/preview`, { to }),
  changeType: (id: string, version: number, to: FieldType) => request<RegisterDetail>('POST', `/api/v1/register-fields/${id}/type`, { version, to }),

  addOption: (fieldId: string, label: string) => request<RegisterDetail>('POST', `/api/v1/register-fields/${fieldId}/options`, { label }),
  updateOption: (id: string, body: Body<'/api/v1/register-field-options/{id}', 'patch'>) =>
    request<RegisterDetail>('PATCH', `/api/v1/register-field-options/${id}`, body),
  moveOption: (id: string, direction: 'up' | 'down') => request<RegisterDetail>('POST', `/api/v1/register-field-options/${id}/move`, { direction }),
  archiveOption: (id: string, version: number) => request<RegisterDetail>('POST', `/api/v1/register-field-options/${id}/archive`, { version }),
  restoreOption: (id: string, version: number) => request<RegisterDetail>('POST', `/api/v1/register-field-options/${id}/restore`, { version }),
  deleteOption: (id: string, version: number) => request<RegisterDetail>('POST', `/api/v1/register-field-options/${id}/delete`, { version }),

  records: (registerId: string, q: RecordQuery) =>
    request<RecordPage>('GET', `/api/v1/registers/${registerId}/records${qs({
      q: q.q, sort: q.sort, dir: q.dir, cursor: q.cursor, limit: '100', includeArchived: q.includeArchived ? 'true' : undefined,
    })}`),
  record: (id: string) => request<RegisterRecord>('GET', `/api/v1/register-records/${id}`),
  history: (id: string) => request<Res<'/api/v1/register-records/{id}/history', 'get'>>('GET', `/api/v1/register-records/${id}/history`),
  createRecord: (registerId: string, values: RecordValues) => request<RegisterRecord>('POST', `/api/v1/registers/${registerId}/records`, { values }),
  updateRecord: (id: string, version: number, values: RecordValues) => request<RegisterRecord>('PATCH', `/api/v1/register-records/${id}`, { version, values }),
  archiveRecord: (id: string, version: number) => request<RegisterRecord>('POST', `/api/v1/register-records/${id}/archive`, { version }),
  restoreRecord: (id: string, version: number) => request<RegisterRecord>('POST', `/api/v1/register-records/${id}/restore`, { version }),
  deleteRecord: (id: string, version: number) => request<undefined>('POST', `/api/v1/register-records/${id}/delete`, { version }),

  /** Скачать Excel: файл формирует backend. */
  async exportFile(registerId: string): Promise<{ blob: Blob; fileName: string }> {
    const res = await fetch(`/api/v1/registers/${registerId}/export`, { credentials: 'same-origin' });
    if (!res.ok) throw await errorOf(res);
    return { blob: await res.blob(), fileName: fileNameFrom(res.headers.get('Content-Disposition'), 'реестр.xlsx') };
  },
  /** Импорт, шаг 1: файл уходит телом запроса как есть. */
  async previewImport(registerId: string, file: File): Promise<ImportPreview> {
    const res = await fetch(`/api/v1/registers/${registerId}/imports`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': XLSX_TYPE, 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    });
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as ImportPreview;
  },
  applyImport: (id: string) => request<ImportResult>('POST', `/api/v1/register-imports/${id}/apply`),
  cancelImport: (id: string) => request<undefined>('POST', `/api/v1/register-imports/${id}/cancel`),
};
