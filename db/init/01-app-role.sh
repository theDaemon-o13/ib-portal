#!/bin/sh
# Роли PostgreSQL для Портала ИБ (CLAUDE.md, раздел 3.6).
#
# Выполняется entrypoint'ом образа postgres только на пустом томе, от имени
# POSTGRES_USER — владельца схемы (ibportal_owner). Скрипт идемпотентен:
# повторный запуск вручную ничего не ломает.
#
#   ibportal_app      — групповая роль (NOLOGIN) с правами на данные.
#                       Имя фиксированное: на него ссылаются миграции.
#   $DB_APP_USER      — логин работающего backend, член ibportal_app.
#
# Запрет UPDATE / DELETE / TRUNCATE на audit_log выдаётся в первой миграции,
# потому что на момент инициализации таблиц ещё нет.
set -eu

: "${POSTGRES_USER:?POSTGRES_USER не задан}"
: "${POSTGRES_DB:?POSTGRES_DB не задан}"
: "${DB_APP_USER:?DB_APP_USER не задан}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD не задан}"

if [ "$DB_APP_USER" = "$POSTGRES_USER" ] || [ "$DB_APP_USER" = "ibportal_app" ]; then
  echo "DB_APP_USER должен отличаться от владельца схемы и от ibportal_app" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner="$POSTGRES_USER" -v db="$POSTGRES_DB" \
  -v app_user="$DB_APP_USER" -v app_password="$DB_APP_PASSWORD" <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ibportal_app') AS need_group \gset
\if :need_group
  CREATE ROLE ibportal_app NOLOGIN;
\endif

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') AS need_login \gset
\if :need_login
  CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' IN ROLE ibportal_app;
\else
  ALTER ROLE :"app_user" LOGIN PASSWORD :'app_password';
  GRANT ibportal_app TO :"app_user";
\endif

-- Роль приложения не создаёт объекты и не управляет ролями.
ALTER ROLE :"app_user" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

-- Подключение к базе — только владельцу и роли приложения.
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO ibportal_app;

-- Схема public: DDL только у владельца.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ibportal_app;

-- Права на таблицы и последовательности, которые владелец создаст миграциями.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ibportal_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ibportal_app;

-- Если таблицы уже есть (повторный запуск), выдать права и на них.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ibportal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ibportal_app;

-- Служебная таблица Prisma приложению не нужна.
SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS has_prisma \gset
\if :has_prisma
  REVOKE ALL ON public._prisma_migrations FROM ibportal_app;
\endif

-- audit_log: только INSERT и SELECT (повторный запуск после миграций).
SELECT to_regclass('public.audit_log') IS NOT NULL AS has_audit \gset
\if :has_audit
  REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM ibportal_app;
\endif
SQL

echo "Роли ibportal_app и $DB_APP_USER готовы"
