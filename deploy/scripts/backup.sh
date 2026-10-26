#!/usr/bin/env bash
# Резервная копия: pg_dump -Fc базы, архив тома файлов, версия и контрольные суммы.
# Пишет в том ibportal_backups каталог <дата>_<время>_<версия>.
#
#   ./scripts/backup.sh            — сделать копию (обязательно перед каждой выкладкой)
#   ./scripts/backup.sh --rotate   — сделать копию и удалить старые: хранятся 14 последних
#                                    и по одной (последней) за каждый из 6 последних месяцев. Для cron.
#
# Код выхода не 0, если копия не создалась или не прошла проверку. Тогда выкладку не продолжать.
set -euo pipefail
source "$(dirname "$0")/_common.sh"

ROTATE=0
case "${1:-}" in
  --rotate) ROTATE=1 ;;
  "") ;;
  *) die "неизвестный параметр: $1" ;;
esac

require_volume "$BACKUP_VOLUME"
require_volume "$FILES_VOLUME"
compose ps --status running db | grep -q db || die "сервис db не запущен"

NAME="$(date +%Y-%m-%d_%H%M%S)_${VERSION}"
DIR="/backups/$NAME"
info "копия $NAME"

helper "mkdir '$DIR'"

info "дамп базы"
compose exec -T db sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | helper_in "cat > '$DIR/db.dump'"
helper "test -s '$DIR/db.dump'" || die "дамп пустой"
helper "cat '$DIR/db.dump'" | compose exec -T db pg_restore --list >/dev/null \
  || die "дамп не читается pg_restore"

info "архив файлов"
helper "tar -C /data/files -czf '$DIR/files.tar.gz' ."

info "версия и контрольные суммы"
helper "cd '$DIR' && printf 'name=%s\nversion=%s\ncreated=%s\n' '$NAME' '$VERSION' \"\$(date -Iseconds)\" > manifest.txt \
  && sha256sum db.dump files.tar.gz manifest.txt > SHA256SUMS && sha256sum -c SHA256SUMS >/dev/null"

helper "du -sh '$DIR' | cut -f1" | sed "s/^/  размер: /"
echo "Копия создана: $NAME"

if [ "$ROTATE" = 1 ]; then
  info "ротация: 14 последних + по одной (последней) за каждый из 6 последних месяцев"
  # Только каталоги с именем копии <дата>_<время>_<версия>; прочее в томе не трогается.
  ALL="$(helper "ls -1 /backups" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_' | sort || true)"
  [ -n "$ALL" ] || die "после создания копии список копий пуст — ротация остановлена"
  KEEP="$(
    {
      printf '%s\n' "$ALL" | tail -n 14
      printf '%s\n' "$ALL" \
        | awk '{ last[substr($0, 1, 7)] = $0 } END { for (m in last) print m, last[m] }' \
        | sort | tail -n 6 | cut -d' ' -f2
    } | sort -u
  )"
  printf '%s\n' "$ALL" | while read -r n; do
    if ! printf '%s\n' "$KEEP" | grep -qxF "$n"; then
      echo "  удаляю старую копию $n"
      helper "rm -rf '/backups/$n'"
    fi
  done
  echo "  осталось копий: $(printf '%s\n' "$KEEP" | wc -l | tr -d ' ')"
fi
