import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPrisma } from './lib/db.js';
import { argon2Hasher } from './lib/passwords.js';
import { prismaAuditWriter } from './modules/audit/audit.js';
import { prismaAuthRepository } from './modules/auth/repository.prisma.js';

const config = loadConfig();
const prisma = createPrisma(config.DATABASE_URL);

const app = await buildApp({
  repo: prismaAuthRepository(prisma),
  audit: prismaAuditWriter(prisma),
  hasher: argon2Hasher,
  sessionSecret: config.SESSION_SECRET,
  trustProxy: config.TRUST_PROXY,
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
