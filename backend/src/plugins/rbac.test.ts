import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { collectPermissions, type PermissionCode } from '../lib/permissions.js';
import type { AuthUser } from '../types.js';
import { installErrorHandler } from './errors.js';
import { installRouteAccessCheck, requireAuth, requirePerm } from './rbac.js';
import '../types.js';

const users: Record<string, AuthUser> = {
  staff: { id: '1', login: 'staff', fullName: 'Staff', mustChangePassword: false, permissions: new Set<PermissionCode>(['ib.work']) },
  legal: { id: '2', login: 'legal', fullName: 'Legal', mustChangePassword: false, permissions: new Set<PermissionCode>(['docs.approve.legal']) },
  fresh: { id: '3', login: 'fresh', fullName: 'Fresh', mustChangePassword: true, permissions: new Set<PermissionCode>(['ib.work']) },
};

async function testApp() {
  const app = Fastify();
  installErrorHandler(app);
  installRouteAccessCheck(app);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const name = req.headers['x-test-user'];
    req.user = typeof name === 'string' ? users[name] ?? null : null;
  });
  app.get('/api/v1/ib', { preHandler: requirePerm('ib.work') }, async () => ({ ok: true }));
  app.get('/api/v1/any', { preHandler: requireAuth() }, async () => ({ ok: true }));
  app.get('/api/v1/me', { preHandler: requireAuth({ allowDuringPasswordChange: true }) }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('requirePerm', () => {
  it('без входа — 401', async () => {
    const app = await testApp();
    const res = await app.inject({ url: '/api/v1/ib' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Войдите в систему' } });
  });

  it('без права — 403', async () => {
    const app = await testApp();
    const res = await app.inject({ url: '/api/v1/ib', headers: { 'x-test-user': 'legal' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('с правом — 200', async () => {
    const app = await testApp();
    const res = await app.inject({ url: '/api/v1/ib', headers: { 'x-test-user': 'staff' } });
    expect(res.statusCode).toBe(200);
  });

  it('до смены пароля закрыто всё, кроме разрешённых маршрутов', async () => {
    const app = await testApp();
    const ib = await app.inject({ url: '/api/v1/ib', headers: { 'x-test-user': 'fresh' } });
    expect(ib.statusCode).toBe(403);
    expect(ib.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const any = await app.inject({ url: '/api/v1/any', headers: { 'x-test-user': 'fresh' } });
    expect(any.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const me = await app.inject({ url: '/api/v1/me', headers: { 'x-test-user': 'fresh' } });
    expect(me.statusCode).toBe(200);
  });

  it('маршрут /api/v1 без явного права не регистрируется', async () => {
    const app = Fastify();
    installRouteAccessCheck(app);
    expect(() => app.get('/api/v1/open', async () => ({}))).toThrow(/без requirePerm/);
  });

  it('обычная функция в preHandler не считается проверкой прав', async () => {
    const app = Fastify();
    installRouteAccessCheck(app);
    expect(() => app.get('/api/v1/x', { preHandler: async () => undefined }, async () => ({}))).toThrow();
  });

  it('публичный маршрут помечается явно', async () => {
    const app = Fastify();
    installRouteAccessCheck(app);
    expect(() => app.get('/api/v1/login', { config: { public: true } }, async () => ({}))).not.toThrow();
  });
});

describe('сумма прав ролей', () => {
  it('пользователь получает объединение прав всех ролей без дублей', () => {
    const perms = collectPermissions([
      { permissions: ['ib.work', 'records.edit'] },
      { permissions: ['records.edit', 'docs.approve.head'] },
      { permissions: ['unknown.code'] },
    ]);
    expect(perms).toEqual(['ib.work', 'records.edit', 'docs.approve.head']);
  });
});
