// Одноразовая база для полного e2e (npm run test:e2e во frontend): ibportal_e2e в dev-контейнере (127.0.0.1:5433).
//   npx tsx scripts/e2e-db.ts create   — пересоздать базу: права ролей, миграции, seed, пользователь e2e
//   npx tsx scripts/e2e-db.ts drop     — удалить базу после прогона
// Работает только с базой, имя которой оканчивается на _e2e, и никогда при NODE_ENV=production (CLAUDE.md, 3.1, 3.8).
// Пользователь e2e: логин и пароль — E2E_LOGIN и E2E_PASSWORD (frontend/.env.e2e), роль «Супер-администратор»,
// без обязательной смены пароля — как после create-admin. ibportal_dev прогон больше не трогает.
import { fileURLToPath } from 'node:url';
import { createPrisma } from '../src/lib/db.js';
import { argon2Hasher } from '../src/lib/passwords.js';
import { normalizeLogin } from '../src/modules/auth/service.js';
import { dropScratchDb, recreateScratchDb, testDbConfig, type TestDb } from './test-db.js';

export const E2E_DB_NAME = process.env.E2E_DB_NAME ?? 'ibportal_e2e';

export function e2eDbConfig(): TestDb {
  return testDbConfig(E2E_DB_NAME);
}

async function createE2eUser(cfg: TestDb): Promise<void> {
  const login = normalizeLogin(process.env.E2E_LOGIN ?? '');
  const password = process.env.E2E_PASSWORD ?? '';
  if (!login || !password) throw new Error('Задайте E2E_LOGIN и E2E_PASSWORD (frontend/.env.e2e)');
  const prisma = createPrisma(cfg.appUrl);
  try {
    const superAdmin = await prisma.role.findUniqueOrThrow({ where: { code: 'super_admin' } });
    await prisma.user.create({
      data: {
        login, fullName: 'E2E Тестовый', passwordHash: await argon2Hasher.hash(password),
        mustChangePassword: false, passwordChangedAt: new Date(), roles: { create: { roleId: superAdmin.id } },
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

export async function createE2eDb(): Promise<TestDb> {
  const cfg = await recreateScratchDb(e2eDbConfig(), '_e2e');
  await createE2eUser(cfg);
  return cfg;
}

export async function dropE2eDb(): Promise<void> {
  await dropScratchDb(e2eDbConfig(), '_e2e');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  const job = cmd === 'create' ? createE2eDb().then((c) => `База ${c.name} готова: миграции, seed, пользователь e2e`)
    : cmd === 'drop' ? dropE2eDb().then(() => `База ${E2E_DB_NAME} удалена`)
    : Promise.reject(new Error('Использование: npx tsx scripts/e2e-db.ts create|drop'));
  job.then((m) => console.log(m)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
