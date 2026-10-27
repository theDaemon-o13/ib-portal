// Проверка схемы (CLAUDE.md, раздел 9, п. 4), только на машине разработчика против dev-контейнера:
//   npm run check:schema
// 1) миграции в prisma/migrations дают ровно schema.prisma — сверка на теневой базе;
// 2) живая dev-база совпадает со schema.prisma — только чтение (--from-config-datasource).
// Теневая база — всегда отдельная одноразовая ibportal_dev_shadow (имя на _shadow, иначе отказ):
// скрипт сам её создаёт и удаляет. Prisma очищает теневую базу целиком, поэтому она никогда не указывает
// на существующую базу (CLAUDE.md, раздел 3.1). В Prisma 7 адреса передаются через prisma.config.ts
// (DATABASE_URL, SHADOW_DATABASE_URL — только для дочернего процесса; конфиг тоже проверяет имя *_shadow). Код выхода: 0 — расхождений нет, 2 — есть, 1 — ошибка.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPrisma } from '../src/lib/db.js';
import { assertShadowDb, dbNameOf } from '../src/lib/shadow-db.js';
import { devEnv } from './test-db.js';

const backendDir = fileURLToPath(new URL('..', import.meta.url));

async function main(): Promise<number> {
  if (process.env.NODE_ENV === 'production') throw new Error('check:schema запрещён при NODE_ENV=production');
  const env = devEnv();
  const host = process.env.DEV_DB_HOST ?? '127.0.0.1:5433';
  const enc = encodeURIComponent;
  const url = (db: string) => `postgresql://${enc(env.DB_OWNER_USER ?? '')}:${enc(env.DB_OWNER_PASSWORD ?? '')}@${host}/${db}`;
  const devUrl = url(process.env.DEV_DB_NAME ?? 'ibportal_dev');
  const shadowName = process.env.SHADOW_DB_NAME ?? 'ibportal_dev_shadow';
  const shadowUrl = url(shadowName);
  // Защита — до любого обращения к базе.
  assertShadowDb(dbNameOf(shadowUrl), dbNameOf(devUrl));
  if (!dbNameOf(devUrl).endsWith('_dev')) throw new Error(`проверяется только dev-база (*_dev), а не «${dbNameOf(devUrl)}»`);

  const admin = createPrisma(devUrl);
  const diff = (args: string[], urls: { DATABASE_URL: string; SHADOW_DATABASE_URL?: string }): boolean => {
    try {
      execFileSync('npx', ['prisma', 'migrate', 'diff', ...args, '--to-schema', 'prisma/schema.prisma', '--exit-code', '--script'], {
        cwd: backendDir, stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, SHADOW_DATABASE_URL: '', ...urls },
      });
      return true;
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer };
      if (err.status === 2) {
        process.stdout.write(err.stdout?.toString() ?? '');
        return false;
      }
      throw e;
    }
  };
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${shadowName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${shadowName}"`);
    const migrationsOk = diff(['--from-migrations', 'prisma/migrations'], { DATABASE_URL: devUrl, SHADOW_DATABASE_URL: shadowUrl });
    console.log(`${migrationsOk ? '✓' : '✗'} миграции = schema.prisma (теневая база ${shadowName})`);
    const liveOk = diff(['--from-config-datasource'], { DATABASE_URL: devUrl });
    console.log(`${liveOk ? '✓' : '✗'} dev-база ${dbNameOf(devUrl)} = schema.prisma`);
    return migrationsOk && liveOk ? 0 : 2;
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${shadowName}" WITH (FORCE)`).catch(() => undefined);
    await admin.$disconnect();
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
