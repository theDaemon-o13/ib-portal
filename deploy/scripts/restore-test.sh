#!/usr/bin/env bash
# Проверка восстановления (раз в месяц, CLAUDE.md, раздел 11): копия из рабочего тома ibportal_backups
# восстанавливается в отдельный проект ibportal-restoretest. Рабочие тома только читаются.
#
#   cd /srv/ibportal/restoretest && ./scripts/restore-test.sh <имя копии>
#
# Каталог restoretest — как deploy: docker-compose.yml, docker-compose.restoretest.yml, scripts/, certs/, .env с
#   COMPOSE_PROJECT_NAME=ibportal-restoretest
#   COMPOSE_FILE=docker-compose.yml:docker-compose.restoretest.yml
# и своими паролями, PORTAL_URL=https://localhost:8444, подсетями (не как у рабочего проекта).
set -euo pipefail
cd "$(dirname "$0")/.."
grep -qx 'COMPOSE_PROJECT_NAME=ibportal-restoretest' .env 2>/dev/null \
  || { echo "ОШИБКА: запускать только из каталога проверки (в .env нет COMPOSE_PROJECT_NAME=ibportal-restoretest)" >&2; exit 1; }
SOURCE_VOLUME="${IBPORTAL_SOURCE_BACKUP_VOLUME:-ibportal_backups}"
export IBPORTAL_BACKUP_VOLUME=ibportal_restoretest_backups IBPORTAL_FILES_VOLUME=ibportal_restoretest_files
source "$(dirname "$0")/_common.sh"

NAME="${1:-}"
[[ "$NAME" =~ ^[0-9A-Za-z._-]+$ ]] || die "укажите имя копии: ./scripts/restore-test.sh <имя> (список: docker run --rm -v $SOURCE_VOLUME:/b:ro --entrypoint ls ibportal-backend:$VERSION /b)"
for v in "$SOURCE_VOLUME" ibportal_restoretest_pgdata ibportal_restoretest_files ibportal_restoretest_backups; do require_volume "$v"; done

info "копия $NAME из $SOURCE_VOLUME (только чтение) в $BACKUP_VOLUME"
docker run --rm --network none --user 0:0 -v "$SOURCE_VOLUME":/src:ro -v "$BACKUP_VOLUME":/backups \
  --entrypoint sh "ibportal-backend:$VERSION" -c "test -d '/src/$NAME' && rm -rf '/backups/$NAME' && cp -a '/src/$NAME' /backups/" \
  || die "копии $NAME нет в $SOURCE_VOLUME"

compose up -d --wait db
# Подтверждение restore.sh — тем же именем копии.
printf '%s\n' "$NAME" | "$(dirname "$0")/restore.sh" "$NAME"
compose up -d --wait backend frontend

echo
echo "Восстановлено в ibportal-restoretest. Проверьте вход и данные:"
echo "  SMOKE_URL=https://localhost:8444 ./scripts/smoke.sh"
echo "  (логин и пароль — как в рабочем портале на дату копии)"
echo "Отметьте проверку в журнале выкладок (дата, копия, результат), затем остановите проверку:"
echo "  docker compose down"
