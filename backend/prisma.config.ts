// Конфигурация Prisma CLI (Prisma 7, ADR-0014): адрес БД больше не в schema.prisma, а здесь.
// .env не читается: переменные приходят из compose (сервис migrate, dev-контейнеры) или от скриптов
// check:schema и test:db. Без DATABASE_URL работает prisma generate (сборка образа), командам с БД адрес нужен.
import { defineConfig } from 'prisma/config';

const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL || undefined;
// Prisma очищает теневую базу целиком (CLAUDE.md, раздел 3.1): только одноразовая база с именем на _shadow,
// её создаёт и удаляет npm run check:schema.
if (shadowDatabaseUrl && !/\/[^/?]+_shadow(\?|$)/.test(shadowDatabaseUrl)) {
  throw new Error('SHADOW_DATABASE_URL: теневая база должна называться *_shadow (её очищает Prisma)');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL || undefined,
    shadowDatabaseUrl,
  },
});
