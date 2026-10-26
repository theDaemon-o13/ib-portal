import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Db } from './lib/db.js';
import type { PasswordHasher } from './lib/passwords.js';
import type { AuditWriter } from './modules/audit/audit.js';
import type { AuthRepository } from './modules/auth/repository.js';
import { authRoutes } from './modules/auth/routes.js';
import { createAuthService } from './modules/auth/service.js';
import { calendarRoutes } from './modules/calendar/routes.js';
import { catalogRoutes } from './modules/catalogs/routes.js';
import { formTemplateRoutes } from './modules/form-templates/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { roleRoutes } from './modules/roles/routes.js';
import { journalRoutes } from './modules/settings/journal.js';
import { userRoutes } from './modules/users/routes.js';
import { installAuth } from './plugins/auth.js';
import { installErrorHandler } from './plugins/errors.js';
import { installRouteAccessCheck } from './plugins/rbac.js';
import './types.js';

export interface AppDeps {
  /** PrismaClient в продукте; открытая транзакция в тестах с настоящей БД. */
  db: Db;
  repo: AuthRepository;
  audit: AuditWriter;
  hasher: PasswordHasher;
  sessionSecret: string;
  now?: () => Date;
  logger?: FastifyServerOptions['logger'];
  trustProxy?: FastifyServerOptions['trustProxy'];
}

export async function buildApp(deps: AppDeps) {
  const base = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: 1024 * 1024,
  });
  base.setValidatorCompiler(validatorCompiler);
  base.setSerializerCompiler(serializerCompiler);
  installErrorHandler(base);
  installRouteAccessCheck(base);
  const app = base.withTypeProvider<ZodTypeProvider>();

  await app.register(cookie, { secret: deps.sessionSecret });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Портал ИБ API', version: '0.1.0' },
      servers: [{ url: '/' }],
    },
    transform: jsonSchemaTransform,
  });

  const auth = createAuthService({ repo: deps.repo, audit: deps.audit, hasher: deps.hasher, now: deps.now });
  installAuth(base, auth);

  await app.register(healthRoutes, { prefix: '/api', ping: () => deps.repo.ping() });
  await app.register(authRoutes, { prefix: '/api/v1/auth', auth });
  await app.register(catalogRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(calendarRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(formTemplateRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(userRoutes, { prefix: '/api/v1', db: deps.db, hasher: deps.hasher });
  await app.register(roleRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(journalRoutes, { prefix: '/api/v1', db: deps.db });

  app.get('/api/v1/openapi.json', { config: { public: true }, schema: { hide: true } }, async () => app.swagger());

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
