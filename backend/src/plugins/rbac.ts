import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { AppError, forbidden, passwordChangeRequired, unauthorized } from '../lib/errors.js';
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
  // Настенный монитор — только маршруты, явно открытые для него (config.kiosk): /monitor, вход и выход.
  // Правило общее, поэтому новый маршрут не откроется киоску незаметно, даже с requireAuth.
  if (user.kiosk && request.routeOptions.config?.kiosk !== true) throw forbidden();
  // Служебная учётная запись (ADR-0036) — только маршруты с config.service: настройки, пользователи и роли, справочники.
  // Белый список, а не запрет: новый маршрут с данными банка не откроется ей незаметно.
  if (user.service && request.routeOptions.config?.service !== true) {
    throw new AppError(403, 'SERVICE_ACCOUNT', 'Служебная учётная запись: этот раздел недоступен. Для работы в портале войдите под своей учётной записью');
  }
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

/** Системная роль «Супер-администратор», а не право: «Параметры портала» другим ролям не выдаются (1.6.0). */
export function requireSuperAdmin(isSuperAdmin: (userId: string) => Promise<boolean>): Guard {
  return markGuard(async (request) => {
    const user = authenticated(request, false);
    if (!(await isSuperAdmin(user.id))) throw forbidden();
  });
}

/** Пользователь со всеми правами (настройка, которая показывает данные банка: settings.manage и ib.work, ADR-0036). */
export function requireAllPerms(codes: readonly PermissionCode[]): Guard {
  return markGuard(async (request) => {
    const user = authenticated(request, false);
    if (!codes.every((c) => user.permissions.has(c))) throw forbidden();
  });
}

/** Пользователь хотя бы с одним из прав (загрузка файлов: ib.work или любое право документов). */
export function requireAnyPerm(codes: readonly PermissionCode[]): Guard {
  return markGuard(async (request) => {
    const user = authenticated(request, false);
    if (!codes.some((c) => user.permissions.has(c))) throw forbidden();
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
