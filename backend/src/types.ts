import type { PermissionCode } from './lib/permissions.js';

export interface AuthUser {
  id: string;
  login: string;
  fullName: string;
  /** Смена пароля обязательна: первый вход, сброс администратором или истёк срок действия. */
  mustChangePassword: boolean;
  /** Пароль истёк (90 дней) — причина обязательной смены. */
  passwordExpired: boolean;
  permissions: ReadonlySet<PermissionCode>;
  /** Названия ролей: пишутся в журнал изменений («кто, с какими ролями»). */
  roleNames: readonly string[];
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
