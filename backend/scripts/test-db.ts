// Одноразовая база для тестов с настоящим PostgreSQL (npm run test:db).
// Пересоздаёт базу ibportal_test в dev-контейнере (127.0.0.1:5433), применяет миграции и seed.
// Работает только с базой, имя которой оканчивается на _test (CLAUDE.md, раздел 3.1: исключение
// для одноразовой тестовой базы), и никогда при NODE_ENV=production.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const backendDir = fileURLToPath(new URL('..', import.meta.url));

export function devEnv(): Record<string, string> {
  // Пароли dev-окружения: deploy/.env.dev, иначе заглушки из .env.dev.example.
  for (const name of ['.env.dev', '.env.dev.example']) {
    const path = fileURLToPath(new URL(`../../deploy/${name}`, import.meta.url));
    if (existsSync(path)) {
      return Object.fromEntries(
        readFileSync(path, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
    }
  }
  throw new Error('нет deploy/.env.dev и deploy/.env.dev.example');
}

export interface TestDb {
  name: string;
  ownerUrl: string;
  appUrl: string;
}

export function testDbConfig(): TestDb {
  const env = devEnv();
  const host = process.env.TEST_DB_HOST ?? '127.0.0.1:5433';
  const name = process.env.TEST_DB_NAME ?? 'ibportal_test';
  const enc = encodeURIComponent;
  return {
    name,
    ownerUrl: `postgresql://${enc(env.DB_OWNER_USER ?? '')}:${enc(env.DB_OWNER_PASSWORD ?? '')}@${host}/${name}`,
    appUrl: `postgresql://${enc(env.DB_APP_USER ?? '')}:${enc(env.DB_APP_PASSWORD ?? '')}@${host}/${name}`,
  };
}

export async function recreateTestDb(): Promise<TestDb> {
  const cfg = testDbConfig();
  if (process.env.NODE_ENV === 'production') throw new Error('test:db запрещён при NODE_ENV=production');
  if (!/^[a-z0-9_]+_test$/.test(cfg.name)) throw new Error(`имя тестовой базы должно оканчиваться на _test: ${cfg.name}`);

  // Служебное подключение — к dev-базе того же сервера (сама тестовая база будет удалена).
  const admin = new PrismaClient({ datasourceUrl: cfg.ownerUrl.replace(/\/[^/]+$/, '/ibportal_dev') });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${cfg.name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${cfg.name}"`);
    await admin.$executeRawUnsafe(`REVOKE ALL ON DATABASE "${cfg.name}" FROM PUBLIC`);
    await admin.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${cfg.name}" TO ibportal_app`);
  } finally {
    await admin.$disconnect();
  }

  // Права внутри базы — как в db/init/01-app-role.sh (роли общие для всего сервера).
  const owner = new PrismaClient({ datasourceUrl: cfg.ownerUrl });
  try {
    const [row] = await owner.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
    const ownerRole = row?.current_user;
    if (!ownerRole) throw new Error('не удалось определить владельца схемы');
    for (const sql of [
      'REVOKE ALL ON SCHEMA public FROM PUBLIC',
      'GRANT USAGE ON SCHEMA public TO ibportal_app',
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${ownerRole}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ibportal_app`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${ownerRole}" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ibportal_app`,
    ]) {
      await owner.$executeRawUnsafe(sql);
    }
  } finally {
    await owner.$disconnect();
  }

  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: cfg.ownerUrl },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  run('npx', ['prisma', 'migrate', 'deploy']);
  run('npx', ['tsx', 'prisma/seed/index.ts']);
  return cfg;
}

// Запуск напрямую: npx tsx scripts/test-db.ts
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  recreateTestDb()
    .then((cfg) => console.log(`Тестовая база ${cfg.name} готова`))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
