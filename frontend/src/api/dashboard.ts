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
/** Слайд экрана мониторинга с данными (релиз 1.1.0). */
export type MonitorSlide = MonitorData['slides'][number];
export type SlideData = MonitorSlide['data'];
export type MonitorVuln = NonNullable<Extract<SlideData, { kind: 'vulns' }>['vulns']>['items'][number];
export type MonitorItem = Extract<SlideData, { kind: 'items' }>['items'][number];
export type SlideConfig = Res<'/api/v1/monitor/slides', 'get'>['items'][number];
export type SlideInput = Body<'/api/v1/monitor/slides', 'post'>;
export type SlideOptions = Res<'/api/v1/monitor/slide-options', 'get'>;
/** Раскладка дашборда (релиз 1.1.0). */
export type Layout = Res<'/api/v1/dashboard/layout', 'get'>;
export type LayoutItem = Layout['items'][number];
export type RoleLayout = Res<'/api/v1/dashboard/role-layouts/{roleId}', 'get'>;

export const dashboardApi = {
  kpis: () => request<KpiList>('GET', '/api/v1/dashboard/kpis'),
  widgets: () => request<WidgetList>('GET', '/api/v1/dashboard/widgets'),
  widget: (key: string) => request<WidgetData>('GET', `/api/v1/dashboard/widgets/${encodeURIComponent(key)}`),
  tiles: () => request<Res<'/api/v1/dashboard/tiles', 'get'>>('GET', '/api/v1/dashboard/tiles'),
  createTile: (body: NewTile) => request<Tile>('POST', '/api/v1/dashboard/tiles', body),
  updateTile: (id: string, body: TilePatch) => request<Tile>('PATCH', `/api/v1/dashboard/tiles/${id}`, body),
  deleteTile: (id: string, version: number) => request<undefined>('POST', `/api/v1/dashboard/tiles/${id}/delete`, { version }),
  monitor: () => request<MonitorData>('GET', '/api/v1/monitor'),
  // Слайды мониторинга (settings.manage).
  slides: () => request<{ items: SlideConfig[] }>('GET', '/api/v1/monitor/slides'),
  slideOptions: () => request<SlideOptions>('GET', '/api/v1/monitor/slide-options'),
  previewSlide: (body: SlideInput) => request<MonitorSlide>('POST', '/api/v1/monitor/slides/preview', body),
  createSlide: (body: SlideInput) => request<SlideConfig>('POST', '/api/v1/monitor/slides', body),
  updateSlide: (id: string, version: number, body: SlideInput) => request<SlideConfig>('PATCH', `/api/v1/monitor/slides/${id}`, { ...body, version }),
  moveSlide: (id: string, direction: 'up' | 'down') => request<{ items: SlideConfig[] }>('POST', `/api/v1/monitor/slides/${id}/move`, { direction }),
  deleteSlide: (id: string, version: number) => request<undefined>('POST', `/api/v1/monitor/slides/${id}/delete`, { version }),
  layout: () => request<Layout>('GET', '/api/v1/dashboard/layout'),
  saveLayout: (version: number, items: LayoutItem[]) => request<Layout>('PUT', '/api/v1/dashboard/layout', { version, items }),
  resetLayout: () => request<Layout>('POST', '/api/v1/dashboard/layout/reset'),
  roleLayouts: () => request<Res<'/api/v1/dashboard/role-layouts', 'get'>>('GET', '/api/v1/dashboard/role-layouts'),
  roleLayout: (roleId: string) => request<RoleLayout>('GET', `/api/v1/dashboard/role-layouts/${roleId}`),
  saveRoleLayout: (roleId: string, version: number, items: LayoutItem[]) =>
    request<RoleLayout>('PUT', `/api/v1/dashboard/role-layouts/${roleId}`, { version, items }),
  resetRoleLayout: (roleId: string) => request<RoleLayout>('POST', `/api/v1/dashboard/role-layouts/${roleId}/reset`),
};

export const dashkeys = {
  all: ['dashboard'] as const,
  kpis: ['dashboard', 'kpis'] as const,
  widgets: ['dashboard', 'widgets'] as const,
  widget: (key: string) => ['dashboard', 'widget', key] as const,
  tiles: ['dashboard', 'tiles'] as const,
  layout: ['dashboard', 'layout'] as const,
  roleLayouts: ['dashboard', 'role-layouts'] as const,
  monitor: ['monitor'] as const,
  slides: ['monitor', 'slides'] as const,
  slideOptions: ['monitor', 'slide-options'] as const,
};
