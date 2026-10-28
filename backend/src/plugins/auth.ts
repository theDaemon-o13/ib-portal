import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, forbidden } from '../lib/errors.js';
import { sameOrigin } from '../lib/portal-url.js';
import { SESSION_COOKIE } from '../lib/session-token.js';
import type { AuthService, ClientInfo } from '../modules/auth/service.js';

export function clientInfo(request: FastifyRequest): ClientInfo {
  const ua = request.headers['user-agent'];
  return { ip: request.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null };
}

/** Cookie сессии: HttpOnly, Secure, SameSite=Strict (CLAUDE.md, раздел 5). */
export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    signed: true,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Дополнительно к SameSite=Strict: изменяющий запрос из браузера должен прийти со страницы портала.
 * Origin сверяется с PORTAL_URL, а не с заголовком Host: Host присылает клиент, и совпадение с ним ничего не доказывает.
 */
function checkOrigin(request: FastifyRequest, portalOrigin: string): void {
  if (!UNSAFE_METHODS.has(request.method)) return;
  const origin = request.headers.origin;
  if (!origin) return; // не браузер (скрипты, smoke.sh); cookie с SameSite=Strict чужой сайт не отправит
  if (!sameOrigin(origin, portalOrigin)) {
    throw new AppError(403, 'BAD_ORIGIN', 'Запрос отклонён: неизвестный источник');
  }
}

/** Определяет текущего пользователя по cookie для каждого запроса. Права проверяют guard'ы из rbac.ts. */
export function installAuth(app: FastifyInstance, auth: AuthService, portalOrigin: string): void {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  app.addHook('onRequest', async (request, reply) => {
    checkOrigin(request, portalOrigin);

    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) {
      clearSessionCookie(reply);
      return;
    }
    const resolved = await auth.resolveSession(unsigned.value, clientInfo(request));
    if (!resolved) {
      clearSessionCookie(reply);
      return;
    }
    request.user = resolved.user;
    request.sessionId = resolved.sessionId;
    // Настенный монитор: закрытые для него маршруты отвечают 403 до разбора запроса (guard в rbac.ts — второй слой).
    const config = request.routeOptions.config as { kiosk?: boolean; public?: boolean } | undefined;
    if (resolved.user.kiosk && request.url.startsWith('/api/v1/') && config?.kiosk !== true && config?.public !== true) {
      throw forbidden();
    }
  });
}
