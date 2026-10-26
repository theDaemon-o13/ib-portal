import type { PermissionCode } from './lib/permissions.js';

export interface AuthUser {
  id: string;
  login: string;
  fullName: string;
  mustChangePassword: boolean;
  permissions: ReadonlySet<PermissionCode>;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
  }
  interface FastifyContextConfig {
    /** Маршрут доступен без входа. Ставится явно и только для health, login и openapi. */
    public?: boolean;
  }
}
