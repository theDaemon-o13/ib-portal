# Образ БД = официальный postgres с init-скриптом ролей внутри.
# На сервер не передаются отдельные файлы: скрипт приезжает в образе.
FROM postgres:16.15-alpine3.24@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36
COPY --chown=postgres:postgres --chmod=0755 init/ /docker-entrypoint-initdb.d/
