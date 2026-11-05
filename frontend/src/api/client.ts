// Тонкий клиент API. Типы берутся из src/api/generated/schema.d.ts (openapi-typescript),
// который вручную не правится: npm run gen:api.
import { isBackground } from '../auth/session';
import type { paths } from './generated/schema';

export type JsonOf<T> = T extends { content: { 'application/json': infer B } } ? B : never;

export type MeResponse = JsonOf<paths['/api/v1/auth/me']['get']['responses'][200]>;
export type Me = MeResponse['user'];
export type LoginBody = JsonOf<NonNullable<paths['/api/v1/auth/login']['post']['requestBody']>>;
export type LoginResponse = JsonOf<paths['/api/v1/auth/login']['post']['responses'][200]>;
export type SessionList = JsonOf<paths['/api/v1/auth/sessions']['get']['responses'][200]>;
export type SessionItem = SessionList['items'][number];
export type ChangePasswordBody = JsonOf<NonNullable<paths['/api/v1/auth/change-password']['post']['requestBody']>>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    // Запрос без недавнего щелчка или клавиши (опрос по таймеру) — фоновый: «последнюю активность» не обновляет (ADR-0023).
    const headers: Record<string, string> = body === undefined ? {} : { 'Content-Type': 'application/json' };
    if (isBackground()) headers['X-Background'] = '1';
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Нет связи с сервером. Проверьте сеть и попробуйте ещё раз');
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? 'Не удалось выполнить запрос', err?.details);
  }
  return data as T;
}

export const authApi = {
  me: () => request<MeResponse>('GET', '/api/v1/auth/me'),
  login: (body: LoginBody) => request<LoginResponse>('POST', '/api/v1/auth/login', body),
  logout: () => request<undefined>('POST', '/api/v1/auth/logout'),
  changePassword: (body: ChangePasswordBody) => request<MeResponse>('POST', '/api/v1/auth/change-password', body),
};

/** «Мои сессии» и сессии пользователя в «Пользователях и ролях» (1.10.0). */
export const sessionsApi = {
  mine: () => request<SessionList>('GET', '/api/v1/auth/sessions'),
  revokeMine: (id: string) => request<undefined>('POST', `/api/v1/auth/sessions/${id}/revoke`),
  revokeOthers: () => request<{ revoked: number }>('POST', '/api/v1/auth/sessions/revoke-others'),
  ofUser: (userId: string) => request<{ items: SessionItem[] }>('GET', `/api/v1/users/${userId}/sessions`),
  revokeOfUser: (userId: string, id: string) => request<{ revoked: number }>('POST', `/api/v1/users/${userId}/sessions/${id}/revoke`),
  revokeAllOfUser: (userId: string) => request<{ revoked: number }>('POST', `/api/v1/users/${userId}/sessions/revoke-all`),
};
