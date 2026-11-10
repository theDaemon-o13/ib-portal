import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPrisma } from './lib/db.js';
import { diskFileStore } from './lib/file-store.js';
import { parseIpList } from './lib/ip-list.js';
import { LOG_REDACT } from './lib/log-redact.js';
import { reportAddressLists } from './lib/startup-report.js';
import { argon2Hasher } from './lib/passwords.js';
import { prismaAuditWriter } from './modules/audit/audit.js';
import { prismaAuthRepository } from './modules/auth/repository.prisma.js';

const config = loadConfig();
// lib/today.ts читает часовой пояс из окружения; значение по умолчанию — из проверенной конфигурации.
process.env.APP_TZ = config.APP_TZ;
const prisma = createPrisma(config.DATABASE_URL);

const trustedProxies = parseIpList(config.TRUSTED_PROXY_IPS);
const kioskAllowedIps = parseIpList(config.MONITOR_ALLOWED_IPS);
const adminAllowedIps = parseIpList(config.ADMIN_ALLOWED_IPS);

const app = await buildApp({
  db: prisma,
  repo: prismaAuthRepository(prisma),
  audit: prismaAuditWriter(prisma),
  hasher: argon2Hasher,
  sessionSecret: config.SESSION_SECRET,
  portalUrl: config.PORTAL_URL,
  files: diskFileStore(config.FILES_DIR),
  // Список, а не «доверять всем частным сетям»: иначе любой ПК в 10.x подставит свой X-Forwarded-For.
  trustProxy: trustedProxies.entries.join(',') || false,
  kioskAllowedIps,
  adminAllowedIps,
  docUrlPrefix: config.ONLYOFFICE_URL_PREFIX,
  automationIntervalMin: config.AUTOMATION_INTERVAL_MIN,
  logger: {
    level: config.LOG_LEVEL,
    redact: LOG_REDACT,
    ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  },
});

reportAddressLists(app.log, { trustedProxies, kiosk: kioskAllowedIps, admin: adminAllowedIps });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'остановка');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
