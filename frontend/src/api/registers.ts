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
/** Правило срока. Оценка уязвимости — только у системного поля. */
export type DueRule = Exclude<CalcRule, { kind: 'vuln_score' } | { kind: 'link_basis' }>;
export type ScoreRule = Extract<CalcRule, { kind: 'vuln_score' }>;
/** Статус основания (сверка с DLP, этап 8б): канал записи и разрешения другого реестра. */
export type BasisRule = Extract<CalcRule, { kind: 'link_basis' }>;
export type FieldSettings = RegisterField['settings'];
export type FileLink = RegisterRecord['files'][string][number];
export type LinkRef = RegisterRecord['links'][string][number];
export type Basis = RegisterRecord['basis'][string];
export type BacklinkGroup = Res<'/api/v1/register-records/{id}/backlinks', 'get'>['items'][number];
export type RecordPage = Res<'/api/v1/registers/{id}/records', 'get'>;
export type RegisterRecord = RecordPage['items'][number];
export type HistoryEntry = Res<'/api/v1/register-records/{id}/history', 'get'>['items'][number];
export type TypePreview = Res<'/api/v1/register-fields/{id}/type/preview', 'post'>;
export type ImportPreview = Res<'/api/v1/registers/{id}/imports', 'post', 201>;
export type ImportResult = Res<'/api/v1/register-imports/{id}/apply', 'post'>;
export type NewField = Body<'/api/v1/registers/{id}/fields', 'post'>;
export type FieldPatch = Body<'/api/v1/register-fields/{id}', 'patch'>;
export type RecordValues = Body<'/api/v1/registers/{id}/records', 'post'>['values'];
export type Widget = Res<'/api/v1/registers/{id}/analytics', 'get'>['items'][number];
export type Deadline = NonNullable<RegisterRecord['deadline']>;
export type ScanPreview = Res<'/api/v1/registers/{id}/scan-imports', 'post', 201>;
/** Предпросмотр «Импорта из Excel»: как распознан файл и что в нём. */
export type FilePreview = Res<'/api/v1/registers/{id}/file-imports', 'post', 201>;
export type ScanResult = Res<'/api/v1/scan-imports/{id}/apply', 'post'>;
export type ScanApply = Body<'/api/v1/scan-imports/{id}/apply', 'post'>;
export type ScanReport = Res<'/api/v1/registers/{id}/scan-reports', 'get'>['items'][number];
export type AutomationRule = Res<'/api/v1/registers/{id}/automations', 'get'>['items'][number];
export type NewRule = Body<'/api/v1/registers/{id}/automations', 'post'>;
export type RuleCondition = NewRule['condition'];
export type RuleAction = NewRule['action'];
export type RulePatch = Body<'/api/v1/register-automations/{id}', 'patch'>;
export type EventPage = Res<'/api/v1/registers/{id}/automation-events', 'get'>;
export type AutomationEvent = EventPage['items'][number];
export type RunResult = Res<'/api/v1/registers/{id}/automations/run', 'post'>;
export type NewDecision = Body<'/api/v1/register-records/{id}/decisions', 'post'>;
export type DecisionEntry = Res<'/api/v1/register-records/{id}/decisions', 'get'>['items'][number];
/** Системный «Реестр рисков ИБ»: решение ОУР заполняет «№ в реестре ОУР» и «Пересмотр до». */
export const RISK_REGISTER_KEY = 'risks';

/** Системный реестр уязвимостей: импорт отчёта сканера и формулы п. 7.1–7.4. */
export const VULN_REGISTER_KEY = 'vulns';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface RecordQuery {
  q?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  includeArchived?: boolean;
  /** Только архивные записи (кнопка «Архив»). */
  archivedOnly?: boolean;
  withTasks?: boolean;
  cursor?: string;
  /** Фильтр из адреса (ссылки дашборда, этап 8): state, deadline, f, date, from, to — как есть. */
  filter?: RecordFilterParams;
}

export type BulkSelection = Body<'/api/v1/registers/{id}/records/bulk-delete/preview', 'post'>['selection'];
export type BulkPreview = Res<'/api/v1/registers/{id}/records/bulk-delete/preview', 'post'>;
export type BulkResult = Res<'/api/v1/registers/{id}/records/bulk-delete/apply', 'post'>;
export type BulkExpected = Pick<BulkPreview, 'total' | 'willDelete' | 'willArchive' | 'willRestore'>;

/** Параметры фильтра записей — те же имена, что в адресе страницы и в API. */
export const FILTER_PARAMS = ['state', 'deadline', 'f', 'date', 'from', 'to'] as const;
export type RecordFilterParams = Partial<Record<(typeof FILTER_PARAMS)[number], string>>;

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
  analytics: (id: string) => request<Res<'/api/v1/registers/{id}/analytics', 'get'>>('GET', `/api/v1/registers/${id}/analytics`),
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
      archived: q.archivedOnly ? 'only' : undefined,
      withTasks: q.withTasks ? 'true' : undefined, ...q.filter,
    })}`),
  // Массовые действия (релиз 1.1.0): предпросмотр → применение с числами предпросмотра.
  bulkArchivePreview: (registerId: string, action: 'archive' | 'restore', selection: BulkSelection) =>
    request<BulkPreview>('POST', `/api/v1/registers/${registerId}/records/bulk-archive/preview`, { action, selection }),
  bulkArchiveApply: (registerId: string, action: 'archive' | 'restore', selection: BulkSelection, expected: BulkExpected) =>
    request<BulkResult>('POST', `/api/v1/registers/${registerId}/records/bulk-archive/apply`, { action, selection, expected }),
  bulkDeletePreview: (registerId: string, selection: BulkSelection) =>
    request<BulkPreview>('POST', `/api/v1/registers/${registerId}/records/bulk-delete/preview`, { selection }),
  bulkDeleteApply: (registerId: string, selection: BulkSelection, expected: BulkExpected) =>
    request<BulkResult>('POST', `/api/v1/registers/${registerId}/records/bulk-delete/apply`, { selection, expected }),
  deleteAllPreview: (registerId: string) => request<BulkPreview>('POST', `/api/v1/registers/${registerId}/records/delete-all/preview`),
  deleteAllApply: (registerId: string, confirmName: string, expected: BulkExpected) =>
    request<BulkResult>('POST', `/api/v1/registers/${registerId}/records/delete-all/apply`, { confirmName, expected }),
  record: (id: string) => request<RegisterRecord>('GET', `/api/v1/register-records/${id}`),
  history: (id: string) => request<Res<'/api/v1/register-records/{id}/history', 'get'>>('GET', `/api/v1/register-records/${id}/history`),
  createRecord: (registerId: string, values: RecordValues) => request<RegisterRecord>('POST', `/api/v1/registers/${registerId}/records`, { values }),
  /** reason — причина изменения поля «с причиной» при фиксирующем статусе (этап 8б). */
  updateRecord: (id: string, version: number, values: RecordValues, reason?: string) =>
    request<RegisterRecord>('PATCH', `/api/v1/register-records/${id}`, { version, values, ...(reason ? { reason } : {}) }),
  /** Приложить загруженные файлы к полю «Файл». */
  attachFiles: (id: string, version: number, fieldId: string, fileIds: string[]) =>
    request<RegisterRecord>('POST', `/api/v1/register-records/${id}/files`, { version, fieldId, fileIds }),
  removeFile: (id: string, linkId: string, version: number) => request<RegisterRecord>('POST', `/api/v1/register-records/${id}/files/${linkId}/remove`, { version }),
  backlinks: (id: string) => request<Res<'/api/v1/register-records/{id}/backlinks', 'get'>>('GET', `/api/v1/register-records/${id}/backlinks`),
  archiveRecord: (id: string, version: number) => request<RegisterRecord>('POST', `/api/v1/register-records/${id}/archive`, { version }),
  restoreRecord: (id: string, version: number) => request<RegisterRecord>('POST', `/api/v1/register-records/${id}/restore`, { version }),
  deleteRecord: (id: string, version: number) => request<undefined>('POST', `/api/v1/register-records/${id}/delete`, { version }),
  /** Решение другого отдела: только с файлом документа-основания (загружен через filesApi.upload). */
  addDecision: (id: string, body: NewDecision) => request<RegisterRecord>('POST', `/api/v1/register-records/${id}/decisions`, body),
  decisions: (id: string, fieldId?: string) =>
    request<Res<'/api/v1/register-records/{id}/decisions', 'get'>>('GET', `/api/v1/register-records/${id}/decisions${qs({ fieldId })}`),
  /** «Считать автоматически»: снять ручную правку (критичность уязвимости). */
  resetToAuto: (id: string, fieldId: string, version: number) =>
    request<RegisterRecord>('POST', `/api/v1/register-records/${id}/auto/${fieldId}`, { version }),

  /** Скачать Excel: файл формирует backend. */
  async exportFile(registerId: string): Promise<{ blob: Blob; fileName: string }> {
    const res = await fetch(`/api/v1/registers/${registerId}/export`, { credentials: 'same-origin' });
    if (!res.ok) throw await errorOf(res);
    return { blob: await res.blob(), fileName: fileNameFrom(res.headers.get('Content-Disposition'), 'реестр.xlsx') };
  },
  /** Выгрузка для проверки: Excel за период по полю-дате и файлы полей «Файл» одним zip. */
  async exportZip(registerId: string, q: { dateFieldId: string; from?: string; to?: string; nameFieldId?: string; linkFieldId?: string }): Promise<{ blob: Blob; fileName: string }> {
    const res = await fetch(`/api/v1/registers/${registerId}/export.zip${qs(q)}`, { credentials: 'same-origin' });
    if (!res.ok) throw await errorOf(res);
    return { blob: await res.blob(), fileName: fileNameFrom(res.headers.get('Content-Disposition'), 'выгрузка.zip') };
  },
  /**
   * Импорт из Excel, шаг 1: файл уходит телом запроса как есть, backend сам определяет,
   * отчёт сканера это или выгрузка реестра, и возвращает соответствующий предпросмотр.
   */
  async previewFile(registerId: string, file: File): Promise<FilePreview> {
    const res = await fetch(`/api/v1/registers/${registerId}/file-imports`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': XLSX_TYPE, 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    });
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as FilePreview;
  },
  applyImport: (id: string) => request<ImportResult>('POST', `/api/v1/register-imports/${id}/apply`),
  cancelImport: (id: string) => request<undefined>('POST', `/api/v1/register-imports/${id}/cancel`),

  applyScan: (id: string, body: ScanApply) => request<ScanResult>('POST', `/api/v1/scan-imports/${id}/apply`, body),
  scanReports: (registerId: string) => request<Res<'/api/v1/registers/{id}/scan-reports', 'get'>>('GET', `/api/v1/registers/${registerId}/scan-reports`),

  rules: (registerId: string) => request<Res<'/api/v1/registers/{id}/automations', 'get'>>('GET', `/api/v1/registers/${registerId}/automations`),
  createRule: (registerId: string, body: NewRule) => request<AutomationRule>('POST', `/api/v1/registers/${registerId}/automations`, body),
  updateRule: (id: string, body: RulePatch) => request<AutomationRule>('PATCH', `/api/v1/register-automations/${id}`, body),
  archiveRule: (id: string, version: number) => request<AutomationRule>('POST', `/api/v1/register-automations/${id}/archive`, { version }),
  deleteRule: (id: string, version: number) => request<undefined>('POST', `/api/v1/register-automations/${id}/delete`, { version }),
  runRules: (registerId: string) => request<RunResult>('POST', `/api/v1/registers/${registerId}/automations/run`),
  events: (registerId: string, q: { status?: 'new' | 'processed'; recordId?: string; cursor?: string }) =>
    request<EventPage>('GET', `/api/v1/registers/${registerId}/automation-events${qs({ status: q.status, recordId: q.recordId, cursor: q.cursor, limit: '50' })}`),
};
