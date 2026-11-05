import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { unauthorized } from '../../lib/errors.js';
import { clearSessionCookie, clientInfo, setSessionCookie } from '../../plugins/auth.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAuth, requirePerm } from '../../plugins/rbac.js';
import type { AuthService } from './service.js';
import { ChangePasswordBody, LoginBody, LoginResponse, MeResponse, SessionItem, toMe } from './schema.js';

const tags = ['auth'];
const duringPasswordChange = requireAuth({ allowDuringPasswordChange: true });

export const authRoutes: FastifyPluginAsyncZod<{ auth: AuthService }> = async (app, { auth }) => {
  app.post('/login', {
    config: { public: true },
    schema: {
      tags,
      summary: 'Вход по логину и паролю. remember — «Запомнить меня» (постоянная cookie); у администраторов не действует',
      body: LoginBody,
      response: { 200: LoginResponse, 400: ErrorResponse, 401: ErrorResponse, 423: ErrorResponse },
    },
  }, async (request, reply) => {
    const result = await auth.login(request.body, clientInfo(request));
    setSessionCookie(reply, result.token, result.remember);
    return {
      user: toMe(result.user),
      session: { remember: result.remember, admin: result.admin, adminMaxHours: result.adminMaxHours, expiresAt: result.expiresAt?.toISOString() ?? null },
    };
  });

  app.post('/logout', {
    preHandler: duringPasswordChange,
    config: { kiosk: true },
    schema: {
      tags,
      summary: 'Выход',
      response: { 204: z.null(), 401: ErrorResponse },
    },
  }, async (request, reply) => {
    if (!request.user || !request.sessionId) throw unauthorized();
    await auth.logout(request.sessionId, request.user.id, clientInfo(request));
    clearSessionCookie(reply);
    return reply.status(204).send(null);
  });

  app.get('/me', {
    preHandler: duringPasswordChange,
    config: { kiosk: true },
    schema: {
      tags,
      summary: 'Текущий пользователь и его права',
      response: { 200: MeResponse, 401: ErrorResponse },
    },
  }, async (request) => {
    if (!request.user) throw unauthorized();
    return { user: toMe(request.user) };
  });

  app.post('/change-password', {
    preHandler: duringPasswordChange,
    config: { kiosk: true },
    schema: {
      tags,
      summary: 'Смена пароля',
      body: ChangePasswordBody,
      response: { 200: MeResponse, 400: ErrorResponse, 401: ErrorResponse },
    },
  }, async (request) => {
    if (!request.user || !request.sessionId) throw unauthorized();
    const user = await auth.changePassword(
      { userId: request.user.id, sessionId: request.sessionId, ...request.body },
      clientInfo(request),
    );
    return { user: toMe(user) };
  });
};

const SessionParams = z.object({ id: z.string().uuid() });
const UserSessionParams = z.object({ id: z.string().uuid(), sessionId: z.string().uuid() });
const Revoked = z.object({ revoked: z.number().int() });
const sessionErrors = { 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };

/**
 * «Мои сессии» и сессии пользователя в «Пользователях и ролях» (1.10.0). Открыты служебной учётной записи
 * (регистрируются в группе config.service, app.ts): она ведёт пользователей. Монитору — нет.
 */
export const sessionRoutes: FastifyPluginAsyncZod<{ auth: AuthService }> = async (app, { auth }) => {
  const me = (request: { user: { id: string } | null; sessionId: string | null }) => {
    if (!request.user || !request.sessionId) throw unauthorized();
    return { userId: request.user.id, sessionId: request.sessionId };
  };

  app.get('/auth/sessions', {
    preHandler: requireAuth(),
    schema: {
      tags, summary: 'Мои сессии: открытые, текущая отмечена; у администратора — срок adminMaxHours',
      response: {
        200: z.object({ items: z.array(SessionItem), admin: z.boolean(), adminMaxHours: z.number().int(), maxDays: z.number().int() }),
        ...sessionErrors,
      },
    },
  }, async (request) => {
    const m = me(request);
    return auth.mySessions(m.userId, m.sessionId);
  });

  app.post('/auth/sessions/:id/revoke', {
    preHandler: requireAuth(),
    schema: { tags, summary: 'Завершить свою сессию (не текущую — для неё «Выйти», 409)', params: SessionParams, response: { 204: z.null(), ...sessionErrors } },
  }, async (request, reply) => {
    const m = me(request);
    await auth.revokeMySession(m.userId, m.sessionId, request.params.id, clientInfo(request));
    return reply.status(204).send(null);
  });

  app.post('/auth/sessions/revoke-others', {
    preHandler: requireAuth(),
    schema: { tags, summary: 'Завершить все свои сессии, кроме текущей', response: { 200: Revoked, ...sessionErrors } },
  }, async (request) => {
    const m = me(request);
    return auth.revokeMyOtherSessions(m.userId, m.sessionId, clientInfo(request));
  });

  app.get('/users/:id/sessions', {
    preHandler: requirePerm('users.manage'),
    schema: { tags: ['users'], summary: 'Открытые сессии пользователя', params: SessionParams, response: { 200: z.object({ items: z.array(SessionItem) }), ...sessionErrors } },
  }, async (request) => auth.userSessions(request.params.id));

  app.post('/users/:id/sessions/:sessionId/revoke', {
    preHandler: requirePerm('users.manage'),
    schema: { tags: ['users'], summary: 'Завершить сессию пользователя', params: UserSessionParams, response: { 200: Revoked, ...sessionErrors } },
  }, async (request) => auth.revokeUserSessions(
    { id: me(request).userId, sessionId: request.sessionId }, request.params.id, request.params.sessionId, clientInfo(request),
  ));

  app.post('/users/:id/sessions/revoke-all', {
    preHandler: requirePerm('users.manage'),
    schema: { tags: ['users'], summary: 'Завершить все сессии пользователя (свою текущую — нет)', params: SessionParams, response: { 200: Revoked, ...sessionErrors } },
  }, async (request) => auth.revokeUserSessions({ id: me(request).userId, sessionId: request.sessionId }, request.params.id, null, clientInfo(request)));
};
