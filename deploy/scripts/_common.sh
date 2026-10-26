# Общие функции скриптов эксплуатации. Подключается из backup.sh, restore.sh, smoke.sh.
# Скрипты запускаются на сервере из каталога deploy: ./scripts/<имя>.sh

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"

BACKUP_VOLUME=ibportal_backups
FILES_VOLUME=ibportal_files

die() { echo "ОШИБКА: $*" >&2; exit 1; }
info() { echo "→ $*"; }

env_value() {
  # Значение переменной из .env без выполнения файла.
  [ -f .env ] || die "нет файла $DEPLOY_DIR/.env"
  grep -E "^$1=" .env | tail -n1 | cut -d= -f2-
}

VERSION="$(env_value VERSION)"
[ -n "$VERSION" ] || die "VERSION не задан в .env"

compose() { docker compose "$@"; }

# Одноразовый контейнер для работы с томами. Берётся образ backend текущей версии:
# сторонние образы на сервер не нужны. Сеть отключена; root нужен только для записи в том копий.
_helper() {
  docker run --rm "$@" --network none --user 0:0 \
    -v "$BACKUP_VOLUME":/backups \
    -v "$FILES_VOLUME":/data/files"${HELPER_FILES_MODE-:ro}" \
    --entrypoint sh "ibportal-backend:$VERSION" -c "$HELPER_CMD"
}
helper() { HELPER_CMD="$1" _helper; }
# То же, но читает данные со стандартного ввода (для конвейеров).
helper_in() { HELPER_CMD="$1" _helper -i; }

require_volume() {
  docker volume inspect "$1" >/dev/null 2>&1 || die "нет тома $1 (см. docs/runbook/deploy.md, первичная настройка)"
}
