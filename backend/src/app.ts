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
import type { FileStore } from './lib/file-store.js';
import type { IpList } from './lib/ip-list.js';
import type { PasswordHasher } from './lib/passwords.js';
import type { AuditWriter } from './modules/audit/audit.js';
import type { AuthRepository } from './modules/auth/repository.js';
import { authRoutes, sessionRoutes } from './modules/auth/routes.js';
import { automationRoutes } from './modules/automations/routes.js';
import { assetRoutes } from './modules/assets/routes.js';
import { portalParamRoutes } from './modules/settings/portal-params.routes.js';
import { awarenessRoutes } from './modules/awareness/routes.js';
import { letterRoutes } from './modules/awareness-letters/routes.js';
import { partyDirectoryRoutes } from './modules/party-directory/routes.js';
import { attentionRoutes } from './modules/attention/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { taskRoutes } from './modules/tasks/routes.js';
import { chainRoutes } from './modules/tasks/chain-routes.js';
import { CACHE_TTL_MS, createCache } from './modules/dashboard/cache.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { assessmentRoutes, presentationRoutes } from './modules/assessments/routes.js';
import { documentRoutes } from './modules/documents/routes.js';
import { monitorRoutes } from './modules/monitor/routes.js';
import { evidenceRoutes } from './modules/evidence/routes.js';
import { fileRoutes } from './modules/files/routes.js';
import { createAuthService } from './modules/auth/service.js';
import { calendarRoutes } from './modules/calendar/routes.js';
import { catalogRoutes } from './modules/catalogs/routes.js';
import { formTemplateRoutes } from './modules/form-templates/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { IMPORT_BODY_LIMIT, registerRoutes, XLSX_TYPE } from './modules/registers/routes.js';
import { roleRoutes } from './modules/roles/routes.js';
import { searchRoutes } from './modules/search/routes.js';
import { trashRoutes } from './modules/trash/routes.js';
import { journalRoutes } from './modules/settings/journal.js';
import { auditRoutes } from './modules/audit/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { vulnRoutes } from './modules/vulns/routes.js';
import { installAuth } from './plugins/auth.js';
import { installErrorHandler } from './plugins/errors.js';
import { installJobs } from './plugins/jobs.js';
import { installRouteAccessCheck } from './plugins/rbac.js';
import './types.js';

export interface AppDeps {
  /** PrismaClient в продукте; открытая транзакция в тестах с настоящей БД. */
  db: Db;
  repo: AuthRepository;
  audit: AuditWriter;
  hasher: PasswordHasher;
  sessionSecret: string;
  /** Адрес портала (origin из PORTAL_URL): с ним сверяется Origin изменяющих запросов. */
  portalUrl: string;
  now?: () => Date;
  logger?: FastifyServerOptions['logger'];
  trustProxy?: FastifyServerOptions['trustProxy'];
  /** Хранилище содержимого файлов (FILES_DIR); без него загрузка и выдача файлов отвечают 500. */
  files?: FileStore;
  /** Адреса настенных мониторов (MONITOR_ALLOWED_IPS); не задано — вход киоска запрещён. */
  kioskAllowedIps?: IpList;
  /** Адреса рабочих мест администраторов (ADMIN_ALLOWED_IPS); не задано или пусто — без ограничения. */
  adminAllowedIps?: IpList;
  /** Префикс ссылок на файлы OnlyOffice (ONLYOFFICE_URL_PREFIX); пусто — любая ссылка http(s). */
  docUrlPrefix?: string;
  /** Фоновая проверка автоматизаций, интервал в минутах; не задано или 0 — выключена (тесты). */
  automationIntervalMin?: number;
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
  // Файл импорта Excel приходит телом запроса как есть (без multipart).
  base.addContentTypeParser([XLSX_TYPE, 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: IMPORT_BODY_LIMIT }, (_req, body, done) => {
    done(null, body);
  });
  const app = base.withTypeProvider<ZodTypeProvider>();

  await app.register(cookie, { secret: deps.sessionSecret });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Портал ИБ API', version: '1.0.1' },
      servers: [{ url: '/' }],
    },
    transform: jsonSchemaTransform,
  });

  const auth = createAuthService({ repo: deps.repo, audit: deps.audit, hasher: deps.hasher, now: deps.now, kioskAllowedIps: deps.kioskAllowedIps,
    adminAllowedIps: deps.adminAllowedIps });
  installAuth(base, auth, deps.portalUrl);

  await app.register(healthRoutes, { prefix: '/api', ping: () => deps.repo.ping() });
  // Модули, открытые служебной учётной записи «Администратор портала» (1.8.0, ADR-0036): их маршруты получают
  // config.service; всё остальное ей закрыто (403 SERVICE_ACCOUNT, plugins/rbac.ts). Права внутри — как у всех.
  await app.register(async (open) => {
    open.addHook('onRoute', (route) => {
      route.config = { ...(route.config ?? {}), service: true } as typeof route.config;
    });
    await open.register(authRoutes, { prefix: '/api/v1/auth', auth });
    await open.register(sessionRoutes, { prefix: '/api/v1', auth });
    await open.register(catalogRoutes, { prefix: '/api/v1', db: deps.db });
    await open.register(notificationRoutes, { prefix: '/api/v1', db: deps.db });
    await open.register(attentionRoutes, { prefix: '/api/v1', db: deps.db });
    await open.register(calendarRoutes, { prefix: '/api/v1', db: deps.db });
    await open.register(formTemplateRoutes, { prefix: '/api/v1', db: deps.db });
    await open.register(userRoutes, { prefix: '/api/v1', db: deps.db, hasher: deps.hasher });
    await open.register(roleRoutes, { prefix: '/api/v1', db: deps.db });
    await open.register(presentationRoutes, { prefix: '/api/v1', db: deps.db });
  });
  await app.register(assetRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(portalParamRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(partyDirectoryRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(journalRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(auditRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(registerRoutes, { prefix: '/api/v1', db: deps.db, store: deps.files ?? missingStore });
  await app.register(vulnRoutes, { prefix: '/api/v1', db: deps.db, store: deps.files ?? missingStore });
  await app.register(automationRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(taskRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(chainRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(documentRoutes, { prefix: '/api/v1', db: deps.db, docUrlPrefix: deps.docUrlPrefix ?? '' });
  await app.register(assessmentRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(fileRoutes, { prefix: '/api/v1', db: deps.db, store: deps.files ?? missingStore });
  await app.register(evidenceRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(searchRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(awarenessRoutes, { prefix: '/api/v1', db: deps.db });
  await app.register(letterRoutes, { prefix: '/api/v1', db: deps.db, portalUrl: deps.portalUrl });
  await app.register(trashRoutes, { prefix: '/api/v1', db: deps.db });
  // Дашборд и мониторинг делят кэш: KPI считаются раз в минуту для обоих.
  const cache = createCache(CACHE_TTL_MS, deps.now);
  await app.register(dashboardRoutes, { prefix: '/api/v1', db: deps.db, cache });
  await app.register(monitorRoutes, { prefix: '/api/v1', db: deps.db, cache });

  if (deps.automationIntervalMin) installJobs(base, { db: deps.db, intervalMs: deps.automationIntervalMin * 60_000, now: deps.now, store: deps.files });

  app.get('/api/v1/openapi.json', { config: { public: true }, schema: { hide: true } }, async () => app.swagger());

  return app;
}

const missingStore: FileStore = {
  root: '',
  put: () => Promise.reject(new Error('хранилище файлов не настроено (FILES_DIR)')),
  open: () => {
    throw new Error('хранилище файлов не настроено (FILES_DIR)');
  },
  size: () => Promise.reject(new Error('хранилище файлов не настроено (FILES_DIR)')),
};

export type App = Awaited<ReturnType<typeof buildApp>>;
