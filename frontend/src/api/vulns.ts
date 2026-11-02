// Раздел «Уязвимости» (релиз 1.5.0, ADR-0029, ADR-0030): группы, узлы, сканы, продления. Типы — из OpenAPI.
import { ApiError, request, type JsonOf } from './client';
import type { paths } from './generated/schema';

type Res<P extends keyof paths, M extends keyof paths[P], S extends number = 200> =
  paths[P][M] extends { responses: infer R } ? (S extends keyof R ? JsonOf<R[S]> : never) : never;
type Body<P extends keyof paths, M extends keyof paths[P]> =
  paths[P][M] extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never;

export type VulnGroup = Res<'/api/v1/vulns/groups', 'get'>['items'][number];
export type VulnNode = VulnGroup['nodes'][number];
export type VulnOverview = Res<'/api/v1/vulns/overview', 'get'>;
export type NodeStats = VulnOverview['nodes'][number];
export type NodeRecordsPage = Res<'/api/v1/vulns/nodes/{id}/records', 'get'>;
export type NodeRecord = NodeRecordsPage['items'][number];
export type RecordState = NodeRecord['vuln']['state'];
export type RecordInfo = Res<'/api/v1/vulns/records/{id}', 'get'>;
export type ScanBrief = Res<'/api/v1/vulns/nodes/{id}/scans', 'get'>['items'][number];
export type ScanDetail = Res<'/api/v1/vulns/scans/{id}', 'get'>;
export type ScanPreview = Res<'/api/v1/vulns/nodes/{id}/scan-imports', 'post', 201>;
export type ScanSummary = ScanPreview['summary'];
export type ScanItem = ScanSummary['groups']['new'][number];
export type ScanGone = ScanSummary['groups']['gone'][number];
export type ScanApply = Body<'/api/v1/vulns/scan-imports/{id}/apply', 'post'>;
export type Extension = Res<'/api/v1/vulns/extensions', 'get'>['items'][number];
export type ExtensionDetail = Res<'/api/v1/vulns/extensions/{id}', 'get'>;
export type ExtensionPlan = Body<'/api/v1/vulns/extensions/preview', 'post'>;
export type ExtensionPreview = Res<'/api/v1/vulns/extensions/preview', 'post'>;
export type ExtensionApply = Body<'/api/v1/vulns/extensions', 'post'>;
export type TransferResult = Res<'/api/v1/vulns/records/transfer', 'post'>;
export type DeletePreview = Res<'/api/v1/vulns/groups/{id}/delete/preview', 'post'>;
export type DeletionStats = Res<'/api/v1/vulns/deletions/stats', 'get'>;

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const vkeys = {
  all: ['vulns'] as const,
  groups: ['vulns', 'groups'] as const,
  overview: ['vulns', 'overview'] as const,
  records: (nodeId: string, q: unknown) => ['vulns', 'records', nodeId, q] as const,
  recordInfo: (id: string) => ['vulns', 'record', id] as const,
  nodeHistory: (id: string) => ['vulns', 'node-history', id] as const,
  scans: (nodeId: string) => ['vulns', 'scans', nodeId] as const,
  scan: (id: string) => ['vulns', 'scan', id] as const,
  extensions: (scope: { nodeId?: string; groupId?: string }) => ['vulns', 'extensions', scope] as const,
  deletionStats: (scope: { nodeId?: string; groupId?: string }, from: string, to: string) => ['vulns', 'deletion-stats', scope, from, to] as const,
  systemTypes: ['vulns', 'system-types'] as const,
};

/** Шаг 1 импорта скана: файл уходит телом запроса, как обычный импорт Excel. */
async function uploadScan(url: string, file: File): Promise<ScanPreview> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? 'Не удалось прочитать файл');
  }
  return (await res.json()) as ScanPreview;
}

export const vulnsApi = {
  groups: () => request<Res<'/api/v1/vulns/groups', 'get'>>('GET', '/api/v1/vulns/groups'),
  createGroup: (body: Body<'/api/v1/vulns/groups', 'post'>) => request<VulnGroup>('POST', '/api/v1/vulns/groups', body),
  renameGroup: (id: string, body: Body<'/api/v1/vulns/groups/{id}', 'patch'>) => request<VulnGroup>('PATCH', `/api/v1/vulns/groups/${id}`, body),
  scanTarget: (groupId: string, fileName: string) => request<Res<'/api/v1/vulns/groups/{id}/scan-target', 'get'>>('GET', `/api/v1/vulns/groups/${groupId}/scan-target${qs({ fileName })}`),
  addNodes: (id: string, systemTypeIds: string[]) => request<VulnGroup>('POST', `/api/v1/vulns/groups/${id}/nodes`, { systemTypeIds }),
  deleteGroupPreview: (id: string) => request<DeletePreview>('POST', `/api/v1/vulns/groups/${id}/delete/preview`),
  deleteGroup: (id: string, reason: string, confirmName: string) => request<unknown>('POST', `/api/v1/vulns/groups/${id}/delete`, { reason, confirmName }),
  deleteNodePreview: (id: string) => request<DeletePreview>('POST', `/api/v1/vulns/nodes/${id}/delete/preview`),
  deleteNode: (id: string, reason: string) => request<unknown>('POST', `/api/v1/vulns/nodes/${id}/delete`, { reason }),
  deletionStats: (scope: { nodeId?: string; groupId?: string }, from: string, to: string) =>
    request<DeletionStats>('GET', `/api/v1/vulns/deletions/stats${qs({ ...scope, from, to })}`),
  overview: () => request<VulnOverview>('GET', '/api/v1/vulns/overview'),
  records: (nodeId: string, q: { search?: string; crit?: string; state?: string; cursor?: string }) =>
    request<NodeRecordsPage>('GET', `/api/v1/vulns/nodes/${nodeId}/records${qs({ ...q, limit: '100' })}`),
  recordInfo: (id: string) => request<RecordInfo>('GET', `/api/v1/vulns/records/${id}`),
  transfer: (recordIds: string[], nodeId: string) => request<TransferResult>('POST', '/api/v1/vulns/records/transfer', { recordIds, nodeId }),
  scans: (nodeId: string) => request<Res<'/api/v1/vulns/nodes/{id}/scans', 'get'>>('GET', `/api/v1/vulns/nodes/${nodeId}/scans`),
  scan: (id: string) => request<ScanDetail>('GET', `/api/v1/vulns/scans/${id}`),
  handover: (id: string, body: Body<'/api/v1/vulns/scans/{id}/handover', 'post'>) =>
    request<Res<'/api/v1/vulns/scans/{id}/handover', 'post'>>('POST', `/api/v1/vulns/scans/${id}/handover`, body),
  previewScan: (nodeId: string, file: File) => uploadScan(`/api/v1/vulns/nodes/${nodeId}/scan-imports`, file),
  /** Импорт с группы в тип, которого там нет: узел появится только при применении. */
  previewNewNodeScan: (groupId: string, systemTypeId: string, file: File) => uploadScan(`/api/v1/vulns/groups/${groupId}/scan-imports${qs({ systemTypeId })}`, file),
  changeNodeType: (nodeId: string, body: Body<'/api/v1/vulns/nodes/{id}/type', 'patch'>) => request<VulnGroup>('PATCH', `/api/v1/vulns/nodes/${nodeId}/type`, body),
  nodeHistory: (nodeId: string) => request<Res<'/api/v1/vulns/nodes/{id}/history', 'get'>>('GET', `/api/v1/vulns/nodes/${nodeId}/history`),
  applyScan: (id: string, body: ScanApply) => request<Res<'/api/v1/vulns/scan-imports/{id}/apply', 'post'>>('POST', `/api/v1/vulns/scan-imports/${id}/apply`, body),
  extensions: (scope: { nodeId?: string; groupId?: string }) => request<Res<'/api/v1/vulns/extensions', 'get'>>('GET', `/api/v1/vulns/extensions${qs(scope)}`),
  extension: (id: string) => request<ExtensionDetail>('GET', `/api/v1/vulns/extensions/${id}`),
  previewExtension: (body: ExtensionPlan) => request<ExtensionPreview>('POST', '/api/v1/vulns/extensions/preview', body),
  applyExtension: (body: ExtensionApply) => request<Res<'/api/v1/vulns/extensions', 'post', 201>>('POST', '/api/v1/vulns/extensions', body),
  cancelExtension: (id: string) => request<Res<'/api/v1/vulns/extensions/{id}/cancel', 'post'>>('POST', `/api/v1/vulns/extensions/${id}/cancel`),
};
