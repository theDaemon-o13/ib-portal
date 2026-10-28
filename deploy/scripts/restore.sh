#!/usr/bin/env bash
# Восстановление из резервной копии (CLAUDE.md, раздел 11, «Откат», п. 2).
#
#   ./scripts/restore.sh                 — список копий
#   ./scripts/restore.sh <имя копии>     — восстановить
#
# Порядок: проверка контрольных сумм → подтверждение вводом имени копии →
# копия текущего состояния (backup.sh) → остановка backend и frontend →
# замена базы и файлов. Сервисы после восстановления поднимает администратор.
set -euo pipefail
source "$(dirname "$0")/_common.sh"

require_volume "$BACKUP_VOLUME"

if [ $# -eq 0 ]; then
  echo "Копии в томе $BACKUP_VOLUME:"
  helper "ls -1 /backups" | sort
  exit 0
fi

NAME="$1"
[[ "$NAME" =~ ^[0-9A-Za-z._-]+$ ]] || die "недопустимое имя копии"
DIR="/backups/$NAME"

helper "test -d '$DIR'" || die "копии $NAME нет"
info "проверка контрольных сумм"
helper "cd '$DIR' && sha256sum -c SHA256SUMS" || die "контрольные суммы не совпали, восстановление остановлено"
BACKUP_VERSION="$(helper "grep '^version=' '$DIR/manifest.txt' | cut -d= -f2")"

cat <<MSG

ВНИМАНИЕ. Текущие данные будут ЗАМЕНЕНЫ данными из копии:
  копия:            $NAME (версия $BACKUP_VERSION)
  текущая версия:   $VERSION
  база ibportal:    все таблицы будут пересозданы из дампа
  том $FILES_VOLUME: текущие файлы будут удалены и заменены архивом
Перед заменой будет сделана копия текущего состояния.

MSG
read -r -p "Для подтверждения введите имя копии: " CONFIRM
[ "$CONFIRM" = "$NAME" ] || die "имя не совпало, ничего не изменено"

info "копия текущего состояния"
"$(dirname "$0")/backup.sh" || die "не удалось сделать копию текущего состояния, восстановление остановлено"

info "остановка backend и frontend"
compose stop backend frontend

info "восстановление базы"
# Одна транзакция. Перед пересозданием таблиц снимаются DEFAULT PRIVILEGES роли приложения,
# иначе новые таблицы получат полный набор прав и запрет UPDATE/DELETE на audit_log
# потеряется: в дампе есть только GRANT, а не REVOKE. Точные права таблиц и сами
# DEFAULT PRIVILEGES возвращаются из дампа (записи ACL и DEFAULT ACL).
helper "cat '$DIR/db.dump'" | compose exec -T db sh -c '
  {
    echo "ALTER DEFAULT PRIVILEGES FOR ROLE \"$POSTGRES_USER\" IN SCHEMA public REVOKE ALL ON TABLES FROM ibportal_app;"
    echo "ALTER DEFAULT PRIVILEGES FOR ROLE \"$POSTGRES_USER\" IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ibportal_app;"
    pg_restore --clean --if-exists -f -
  } | psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" --single-transaction -v ON_ERROR_STOP=1 -q -o /dev/null'

info "восстановление файлов"
HELPER_FILES_MODE="" helper "find /data/files -mindepth 1 -delete && tar -C /data/files -xzf '$DIR/files.tar.gz'"

info "проверка целостности: права ролей, триггеры аудита, права и роли портала"
# В одноразовом контейнере backend: у него есть том файлов (проверка «файлы на месте»), у migrate — нет.
compose run --rm -T --no-deps backend node dist/scripts/check-integrity.js \
  || die "проверка целостности не пройдена: сервисы не поднимать, обратиться к разработчику"

cat <<MSG

Восстановлено из $NAME.
Дальше:
  1. Если версия копии ($BACKUP_VERSION) отличается от текущей ($VERSION), верните её в .env:
       sed -i 's/^VERSION=.*/VERSION=$BACKUP_VERSION/' .env
  2. docker compose up -d backend frontend
  3. ./scripts/smoke.sh
  4. Сообщите разработчику для журнала выкладок: дата, копия, причина, результат
MSG
