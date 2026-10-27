import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPrisma } from './lib/db.js';
import { diskFileStore } from './lib/file-store.js';
import { parseIpList } from './lib/ip-list.js';
import { argon2Hasher } from './lib/passwords.js';
import { prismaAuditWriter } from './modules/audit/audit.js';
import { prismaAuthRepository } from './modules/auth/repository.prisma.js';

const config = loadConfig();
// lib/today.ts читает часовой пояс из окружения; значение по умолчанию — из проверенной конфигурации.
process.env.APP_TZ = config.APP_TZ;
const prisma = createPrisma(config.DATABASE_URL);

const app = await buildApp({
  db: prisma,
  repo: prismaAuthRepository(prisma),
  audit: prismaAuditWriter(prisma),
  hasher: argon2Hasher,
  sessionSecret: config.SESSION_SECRET,
  files: diskFileStore(config.FILES_DIR),
  // Список, а не «доверять всем частным сетям»: иначе любой ПК в 10.x подставит свой X-Forwarded-For.
  trustProxy: parseIpList(config.TRUSTED_PROXY_IPS).entries.join(',') || false,
  kioskAllowedIps: parseIpList(config.MONITOR_ALLOWED_IPS),
  automationIntervalMin: config.AUTOMATION_INTERVAL_MIN,
  logger: {
    level: config.LOG_LEVEL,
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'остановка');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
