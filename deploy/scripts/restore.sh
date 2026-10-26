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
helper "cat '$DIR/db.dump'" | compose exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --single-transaction --exit-on-error'

info "восстановление файлов"
HELPER_FILES_MODE="" helper "find /data/files -mindepth 1 -delete && tar -C /data/files -xzf '$DIR/files.tar.gz'"

cat <<MSG

Восстановлено из $NAME.
Дальше:
  1. Если версия копии ($BACKUP_VERSION) отличается от текущей ($VERSION), верните её в .env:
       sed -i 's/^VERSION=.*/VERSION=$BACKUP_VERSION/' .env
  2. docker compose up -d backend frontend
  3. ./scripts/smoke.sh
  4. Сообщите разработчику для журнала выкладок: дата, копия, причина, результат
MSG
