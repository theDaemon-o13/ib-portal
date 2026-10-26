// Тонкий клиент API. Типы берутся из src/api/generated/schema.d.ts (openapi-typescript),
// который вручную не правится: npm run gen:api.
import type { paths } from './generated/schema';

export type JsonOf<T> = T extends { content: { 'application/json': infer B } } ? B : never;

export type MeResponse = JsonOf<paths['/api/v1/auth/me']['get']['responses'][200]>;
export type Me = MeResponse['user'];
export type LoginBody = JsonOf<NonNullable<paths['/api/v1/auth/login']['post']['requestBody']>>;
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
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
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
  login: (body: LoginBody) => request<MeResponse>('POST', '/api/v1/auth/login', body),
  logout: () => request<undefined>('POST', '/api/v1/auth/logout'),
  changePassword: (body: ChangePasswordBody) => request<MeResponse>('POST', '/api/v1/auth/change-password', body),
};
