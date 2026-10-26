import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { unauthorized } from '../../lib/errors.js';
import { clearSessionCookie, clientInfo, setSessionCookie } from '../../plugins/auth.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAuth } from '../../plugins/rbac.js';
import type { AuthService } from './service.js';
import { ChangePasswordBody, LoginBody, MeResponse, toMe } from './schema.js';

const tags = ['auth'];
const duringPasswordChange = requireAuth({ allowDuringPasswordChange: true });

export const authRoutes: FastifyPluginAsyncZod<{ auth: AuthService }> = async (app, { auth }) => {
  app.post('/login', {
    config: { public: true },
    schema: {
      tags,
      summary: 'Вход по логину и паролю',
      body: LoginBody,
      response: { 200: MeResponse, 400: ErrorResponse, 401: ErrorResponse, 423: ErrorResponse },
    },
  }, async (request, reply) => {
    const result = await auth.login(request.body, clientInfo(request));
    setSessionCookie(reply, result.token);
    return { user: toMe(result.user) };
  });

  app.post('/logout', {
    preHandler: duringPasswordChange,
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
