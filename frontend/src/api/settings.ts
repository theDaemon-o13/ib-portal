// Запросы раздела «Настройки». Типы — из сгенерированной схемы OpenAPI.
import type { paths } from './generated/schema';
import { request, type JsonOf } from './client';

type Res<P extends keyof paths, M extends keyof paths[P], S extends number = 200> = paths[P][M] extends {
  responses: infer R;
}
  ? S extends keyof R
    ? JsonOf<R[S]>
    : never
  : never;
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody?: infer B }
  ? JsonOf<NonNullable<B>>
  : never;

export type Catalog = Res<'/api/v1/catalogs', 'get'>['items'][number];
export type CatalogItem = Res<'/api/v1/catalogs/{code}/items', 'get'>['items'][number];
export type Tone = NonNullable<CatalogItem['color']>;
export type WorkWeek = Res<'/api/v1/calendar/week', 'get'>;
export type CalendarDay = Res<'/api/v1/calendar/days', 'get'>['items'][number];
export type FormTemplate = Res<'/api/v1/form-templates', 'get'>['items'][number];
export type TemplateField = FormTemplate['fields'][number];
export type CheckKind = TemplateField['checkKind'];
export type AdminUser = Res<'/api/v1/users', 'get'>['items'][number];
export type UserPage = Res<'/api/v1/users', 'get'>;
export type UserOption = Res<'/api/v1/users/options', 'get'>['items'][number];
export type Role = Res<'/api/v1/roles', 'get'>['items'][number];
export type Permission = Res<'/api/v1/permissions', 'get'>['items'][number];
export type WithTemporaryPassword = Res<'/api/v1/users', 'post', 201>;

const enc = encodeURIComponent;

export type PresentationSignature = Res<'/api/v1/settings/presentation', 'get'>;

export const settingsApi = {
  // Подпись «Спроектировано» в презентации самооценки (этап Д5): право settings.manage.
  presentation: () => request<PresentationSignature>('GET', '/api/v1/settings/presentation'),
  setPresentation: (body: Body<'/api/v1/settings/presentation', 'put'>) => request<PresentationSignature>('PUT', '/api/v1/settings/presentation', body),
  catalogs: () => request<Res<'/api/v1/catalogs', 'get'>>('GET', '/api/v1/catalogs'),
  items: (code: string, includeArchived: boolean) =>
    request<Res<'/api/v1/catalogs/{code}/items', 'get'>>(
      'GET',
      `/api/v1/catalogs/${enc(code)}/items${includeArchived ? '?includeArchived=true' : ''}`,
    ),
  createItem: (code: string, body: Body<'/api/v1/catalogs/{code}/items', 'post'>) =>
    request<CatalogItem>('POST', `/api/v1/catalogs/${enc(code)}/items`, body),
  updateItem: (id: string, body: Body<'/api/v1/catalog-items/{id}', 'patch'>) =>
    request<CatalogItem>('PATCH', `/api/v1/catalog-items/${id}`, body),
  archiveItem: (id: string, version: number) => request<CatalogItem>('POST', `/api/v1/catalog-items/${id}/archive`, { version }),
  restoreItem: (id: string, version: number) => request<CatalogItem>('POST', `/api/v1/catalog-items/${id}/restore`, { version }),
  deleteItem: (id: string, version: number) => request<undefined>('POST', `/api/v1/catalog-items/${id}/delete`, { version }),

  workWeek: () => request<WorkWeek>('GET', '/api/v1/calendar/week'),
  setWorkWeek: (body: Body<'/api/v1/calendar/week', 'put'>) => request<WorkWeek>('PUT', '/api/v1/calendar/week', body),
  days: (year: number) => request<Res<'/api/v1/calendar/days', 'get'>>('GET', `/api/v1/calendar/days?year=${year}`),
  createDay: (body: Body<'/api/v1/calendar/days', 'post'>) => request<CalendarDay>('POST', '/api/v1/calendar/days', body),
  updateDay: (id: string, body: Body<'/api/v1/calendar/days/{id}', 'patch'>) =>
    request<CalendarDay>('PATCH', `/api/v1/calendar/days/${id}`, body),
  deleteDay: (id: string, version: number) => request<undefined>('POST', `/api/v1/calendar/days/${id}/delete`, { version }),

  templates: (includeArchived: boolean) =>
    request<Res<'/api/v1/form-templates', 'get'>>('GET', `/api/v1/form-templates${includeArchived ? '?includeArchived=true' : ''}`),
  createTemplate: (body: Body<'/api/v1/form-templates', 'post'>) => request<FormTemplate>('POST', '/api/v1/form-templates', body),
  updateTemplate: (id: string, body: Body<'/api/v1/form-templates/{id}', 'patch'>) =>
    request<FormTemplate>('PATCH', `/api/v1/form-templates/${id}`, body),
  archiveTemplate: (id: string, version: number) => request<FormTemplate>('POST', `/api/v1/form-templates/${id}/archive`, { version }),
  restoreTemplate: (id: string, version: number) => request<FormTemplate>('POST', `/api/v1/form-templates/${id}/restore`, { version }),
  deleteTemplate: (id: string, version: number) => request<undefined>('POST', `/api/v1/form-templates/${id}/delete`, { version }),
  addField: (templateId: string, body: Body<'/api/v1/form-templates/{id}/fields', 'post'>) =>
    request<FormTemplate>('POST', `/api/v1/form-templates/${templateId}/fields`, body),
  updateField: (id: string, body: Body<'/api/v1/form-template-fields/{id}', 'patch'>) =>
    request<FormTemplate>('PATCH', `/api/v1/form-template-fields/${id}`, body),
  deleteField: (id: string, version: number) => request<FormTemplate>('POST', `/api/v1/form-template-fields/${id}/delete`, { version }),
  moveField: (id: string, direction: 'up' | 'down') =>
    request<FormTemplate>('POST', `/api/v1/form-template-fields/${id}/move`, { direction }),

  users: (cursor?: string) => request<UserPage>('GET', `/api/v1/users?limit=100${cursor ? `&cursor=${enc(cursor)}` : ''}`),
  userOptions: () => request<Res<'/api/v1/users/options', 'get'>>('GET', '/api/v1/users/options'),
  /** Все активные пользователи с отметкой ibWork — владелец системы, проверка участников меток. */
  allUserOptions: () => request<Res<'/api/v1/users/options', 'get'>>('GET', '/api/v1/users/options?scope=all'),
  createUser: (body: Body<'/api/v1/users', 'post'>) => request<WithTemporaryPassword>('POST', '/api/v1/users', body),
  updateUser: (id: string, body: Body<'/api/v1/users/{id}', 'patch'>) => request<AdminUser>('PATCH', `/api/v1/users/${id}`, body),
  disableUser: (id: string, version: number) => request<AdminUser>('POST', `/api/v1/users/${id}/disable`, { version }),
  enableUser: (id: string, version: number) => request<AdminUser>('POST', `/api/v1/users/${id}/enable`, { version }),
  resetPassword: (id: string, version: number) =>
    request<WithTemporaryPassword>('POST', `/api/v1/users/${id}/reset-password`, { version }),
  unlockUser: (id: string, version: number) => request<AdminUser>('POST', `/api/v1/users/${id}/unlock`, { version }),
  /** Отметка «Является начальником ИБ» (1.4.0): у другого — 409 IB_HEAD_TAKEN (details.holder), transfer — передать. */
  setIbHead: (id: string, body: Body<'/api/v1/users/{id}/ib-head', 'put'>) => request<AdminUser>('PUT', `/api/v1/users/${id}/ib-head`, body),

  permissions: () => request<Res<'/api/v1/permissions', 'get'>>('GET', '/api/v1/permissions'),
  roles: () => request<Res<'/api/v1/roles', 'get'>>('GET', '/api/v1/roles'),
  createRole: (body: Body<'/api/v1/roles', 'post'>) => request<Role>('POST', '/api/v1/roles', body),
  updateRole: (id: string, body: Body<'/api/v1/roles/{id}', 'patch'>) => request<Role>('PATCH', `/api/v1/roles/${id}`, body),
  deleteRole: (id: string, version: number) => request<undefined>('POST', `/api/v1/roles/${id}/delete`, { version }),
  setPermission: (roleId: string, code: string, granted: boolean) =>
    request<Role>('PUT', `/api/v1/roles/${roleId}/permissions/${enc(code)}`, { granted }),

};
