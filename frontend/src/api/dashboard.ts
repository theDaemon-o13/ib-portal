// Дашборд и экран мониторинга (этап 8). Типы — из сгенерированной схемы OpenAPI.
import { request, type JsonOf } from './client';
import type { paths } from './generated/schema';

type Res<P extends keyof paths, M extends keyof paths[P], S extends number = 200> = paths[P][M] extends { responses: infer R }
  ? S extends keyof R ? JsonOf<R[S]> : never
  : never;
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never;

export type KpiList = Res<'/api/v1/dashboard/kpis', 'get'>;
export type Kpi = KpiList['items'][number];
export type WidgetList = Res<'/api/v1/dashboard/widgets', 'get'>;
export type WidgetRef = WidgetList['widgets'][number];
export type WidgetData = Res<'/api/v1/dashboard/widgets/{key}', 'get'>;
export type Tile = Res<'/api/v1/dashboard/tiles', 'get'>['items'][number];
export type NewTile = Body<'/api/v1/dashboard/tiles', 'post'>;
export type TilePatch = Body<'/api/v1/dashboard/tiles/{id}', 'patch'>;
export type MonitorData = Res<'/api/v1/monitor', 'get'>;
export type MonitorVuln = NonNullable<MonitorData['vulns']>['items'][number];
export type MonitorItem = MonitorData['items'][number];

export const dashboardApi = {
  kpis: () => request<KpiList>('GET', '/api/v1/dashboard/kpis'),
  widgets: () => request<WidgetList>('GET', '/api/v1/dashboard/widgets'),
  widget: (key: string) => request<WidgetData>('GET', `/api/v1/dashboard/widgets/${encodeURIComponent(key)}`),
  tiles: () => request<Res<'/api/v1/dashboard/tiles', 'get'>>('GET', '/api/v1/dashboard/tiles'),
  createTile: (body: NewTile) => request<Tile>('POST', '/api/v1/dashboard/tiles', body),
  updateTile: (id: string, body: TilePatch) => request<Tile>('PATCH', `/api/v1/dashboard/tiles/${id}`, body),
  deleteTile: (id: string, version: number) => request<undefined>('POST', `/api/v1/dashboard/tiles/${id}/delete`, { version }),
  monitor: () => request<MonitorData>('GET', '/api/v1/monitor'),
};

export const dashkeys = {
  all: ['dashboard'] as const,
  kpis: ['dashboard', 'kpis'] as const,
  widgets: ['dashboard', 'widgets'] as const,
  widget: (key: string) => ['dashboard', 'widget', key] as const,
  tiles: ['dashboard', 'tiles'] as const,
  monitor: ['monitor'] as const,
};
