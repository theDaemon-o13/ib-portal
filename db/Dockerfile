# Образ БД = официальный postgres с init-скриптом ролей внутри.
# На сервер не передаются отдельные файлы: скрипт приезжает в образе.
FROM postgres:16.4-alpine
COPY --chown=postgres:postgres --chmod=0755 init/ /docker-entrypoint-initdb.d/
