import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { forbidden, passwordChangeRequired, unauthorized } from '../lib/errors.js';
import type { PermissionCode } from '../lib/permissions.js';

const GUARD = Symbol('accessGuard');

type Guard = preHandlerAsyncHookHandler & { [GUARD]: true };

function markGuard(fn: preHandlerAsyncHookHandler): Guard {
  return Object.assign(fn, { [GUARD]: true as const });
}

function isGuard(fn: unknown): boolean {
  return typeof fn === 'function' && GUARD in fn;
}

function authenticated(request: FastifyRequest, allowDuringPasswordChange: boolean) {
  const user = request.user;
  if (!user) throw unauthorized();
  if (user.mustChangePassword && !allowDuringPasswordChange) throw passwordChangeRequired();
  return user;
}

/**
 * Любой вошедший пользователь. allowDuringPasswordChange — для маршрутов,
 * доступных до обязательной смены пароля (me, change-password, logout).
 */
export function requireAuth(opts: { allowDuringPasswordChange?: boolean } = {}): Guard {
  return markGuard(async (request) => {
    authenticated(request, opts.allowDuringPasswordChange ?? false);
  });
}

/** Пользователь с правом code (в сумме прав всех своих ролей). */
export function requirePerm(code: PermissionCode): Guard {
  return markGuard(async (request) => {
    const user = authenticated(request, false);
    if (!user.permissions.has(code)) throw forbidden();
  });
}

/**
 * Маршрут /api/v1 без requirePerm / requireAuth и без явного config.public
 * не регистрируется: приложение не стартует.
 */
export function installRouteAccessCheck(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/v1')) return;
    const config = route.config as { public?: boolean } | undefined;
    if (config?.public === true) return;
    const handlers = [route.preHandler].flat().filter(Boolean);
    if (!handlers.some(isGuard)) {
      throw new Error(`Маршрут ${String(route.method)} ${route.url} без requirePerm/requireAuth или config.public`);
    }
  });
}
