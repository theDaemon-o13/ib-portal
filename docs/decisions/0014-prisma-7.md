# ADR-0014. Prisma 7 вместо 6.16.2

Дата: 28.10.2026. Статус: принято (подготовка к выкладке 1.0.0, зависимости согласованы владельцем проекта).

## Контекст
Раздел CHANGELOG «Перед первой выкладкой» требовал перейти на Prisma 7 до первой выкладки: ветку 6.x не стоит увозить в рабочий контур, где обновление каждый раз стоит релиза. В Prisma 7 изменилось устройство клиента:
- клиент работает только через драйвер-адаптер (для PostgreSQL — `@prisma/adapter-pg` поверх `pg`), бинарного query engine больше нет;
- генератор `prisma-client` пишет клиент в каталог проекта (`output` обязателен), а не в `node_modules`;
- адрес БД и теневой базы переехали из `schema.prisma` в `prisma.config.ts`; `.env` CLI сам не читает;
- у `prisma migrate diff` заменены флаги: `--from-url`/`--from-schema-datasource` → `--from-config-datasource`, `--to-schema-datamodel` → `--to-schema`, `--shadow-database-url` → `shadowDatabaseUrl` в конфиге;
- `migrate dev` больше не запускает `generate` и seed.

## Решение
- Версии (старше двух недель на 28.10.2026): `prisma` и `@prisma/client` 7.10.0, `@prisma/adapter-pg` 7.10.0, `pg` 8.23.1, `@types/pg` 8.23.1 (dev). В `allowScripts` одобрены install-скрипты `prisma@7.10.0` (проверка окружения) и `@prisma/engines@7.10.0` (скачивает schema-engine для миграций при сборке на машине разработчика); у `@prisma/client` 7 install-скрипта нет.
- Генератор: `provider = "prisma-client"`, `output = "../src/generated/prisma"`, `moduleFormat = "esm"`, `importFileExtension = "js"` (NodeNext). Каталог `src/generated/` не хранится в git и не попадает в контекст сборки Docker — клиент генерируется `prisma generate` (`postinstall`, `npm run build`, запуск dev-контейнеров). Импорты — из `src/generated/prisma/client.js`.
- `lib/db.ts`: `createPrisma(url = DATABASE_URL)` создаёт клиент с `PrismaPg`; таймаут подключения 5 с — как по умолчанию в Prisma 6 (у `pg` ожидание без предела). Все клиенты (backend, seed, скрипты) создаются через `createPrisma`.
- `withTx` отличает клиент от транзакции по `$connect`: в Prisma 7 `$transaction` из типа транзакционного клиента не убран.
- `prisma.config.ts`: `datasource.url` из `DATABASE_URL`, `shadowDatabaseUrl` из `SHADOW_DATABASE_URL`. Конфиг сам отказывается работать, если теневая база называется не `*_shadow` (CLAUDE.md, раздел 3.1). `env()` из `prisma/config` не используется: он падает на пустой переменной, а `prisma generate` при сборке образа работает без адреса.
- `check:schema` передаёт адреса дочернему `prisma migrate diff` через `DATABASE_URL` и `SHADOW_DATABASE_URL`; `test:db` явно очищает `SHADOW_DATABASE_URL`.
- Образ backend: `prisma.config.ts` копируется рядом с `prisma/` — сервис `migrate` берёт адрес из него.
- Размер образа: после `npm prune` удаляются среды выполнения клиента для других СУБД (`@prisma/client/runtime/query_compiler_*` кроме `postgresql`), source map и `@types`. Prisma CLI (`prisma`, Studio, `@prisma/dev`) не урезается: он загружает свои зависимости при старте, и без них `migrate` не запускается (проверено). Если Prisma переименует файлы среды PostgreSQL, сборка образа падает — при обновлении Prisma проверить список.

## Последствия
- Схема БД и миграции не менялись: `check:schema` (миграции и живая dev-база против `schema.prisma`) без расхождений, `check:integrity` в порядке.
- После `npm ci` или смены `schema.prisma` нужен `prisma generate` (в `postinstall` и `build` он уже есть); без него typecheck не найдёт `src/generated/prisma`.
- Пул соединений — у `pg` (по умолчанию до 10 соединений на процесс).
- Следующее обновление Prisma — отдельным ADR или строкой в CHANGELOG с проверкой `check:schema`.

## Принятый риск (28.10.2026, решение владельца проекта)
`npm audit --omit=dev` для 1.0.0 показывает 4 уязвимости high — все во вспомогательных зависимостях Prisma CLI 7.10.0:
- `mysql2` ≤ 3.23.0 (GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3) — драйвер MySQL; портал работает только с PostgreSQL, драйвер не используется;
- `deepmerge-ts` < 8.0.0 (GHSA-ggr8-5vv4-36mx) через `@prisma/config` — разбор собственной конфигурации `prisma.config.ts` внутри образа; данные пользователей туда не попадают.

Не эксплуатируются. Исправлены в 7.10.1 (15.10.2026) — на момент выпуска 1.0.0 версия моложе двух недель. Обновление `prisma`, `@prisma/client`, `@prisma/adapter-pg` до 7.10.1 — в 1.0.1 с `check:schema`, `test:db` и e2e на релизных образах.
