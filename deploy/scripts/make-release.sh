#!/usr/bin/env bash
# Сборка релиза на машине разработчика (Mac). На сервере нет Node и git — только Docker,
# поэтому туда передаются только образы и файлы эксплуатации, без исходников.
#
#   ./deploy/scripts/make-release.sh [--allow-dirty] [--force]
#
# Результат:
#   dist/ibportal-<VERSION>/              папка релиза (см. RELEASE.md внутри)
#   dist/ibportal-<VERSION>.tar.gz        она же одним архивом для переноса
#   dist/ibportal-<VERSION>.tar.gz.sha256
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ALLOW_DIRTY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --force) FORCE=1 ;;
    *) echo "неизвестный параметр: $arg" >&2; exit 1 ;;
  esac
done

die() { echo "ОШИБКА: $*" >&2; exit 1; }
info() { echo "→ $*"; }
sha256() { shasum -a 256 "$@"; }   # формат совместим с sha256sum -c на сервере

VERSION="$(tr -d '[:space:]' < VERSION)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION должен быть вида 0.1.0, сейчас: '$VERSION'"
OUT="dist/ibportal-$VERSION"
PLATFORM=linux/amd64
IMAGES=(ibportal-db ibportal-backend ibportal-frontend)

# 1. Проверки исходников
if [ "$ALLOW_DIRTY" = 0 ] && [ -n "$(git status --porcelain)" ]; then
  die "в рабочем дереве есть незакоммиченные изменения (или --allow-dirty для пробной сборки)"
fi
COMMIT="$(git rev-parse --short HEAD)"
TAG="v$VERSION"
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Внимание: тега $TAG нет. Для настоящего релиза: git tag $TAG"
elif [ "$(git rev-list -n1 "$TAG")" != "$(git rev-parse HEAD)" ]; then
  echo "Внимание: тег $TAG указывает не на текущий коммит"
fi
PREV_TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "HEAD^" 2>/dev/null || true)"
[ "$PREV_TAG" = "$TAG" ] && PREV_TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$TAG^" 2>/dev/null || true)"
PREV_VERSION="${PREV_TAG#v}"

if [ -e "$OUT" ]; then
  [ "$FORCE" = 1 ] || die "$OUT уже есть (--force, чтобы пересобрать)"
  rm -rf "$OUT" "$OUT.tar.gz" "$OUT.tar.gz.sha256"
fi
docker buildx version >/dev/null 2>&1 || die "нужен docker buildx"

# 2. Образы строго под linux/amd64
build() {
  local image="$1" context="$2"
  info "сборка $image:$VERSION ($PLATFORM)"
  docker buildx build --platform "$PLATFORM" --load \
    --label "org.opencontainers.image.version=$VERSION" \
    --label "org.opencontainers.image.revision=$COMMIT" \
    -t "$image:$VERSION" "$context"
  local arch
  arch="$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$image:$VERSION")"
  [ "$arch" = "$PLATFORM" ] || die "$image:$VERSION собран под $arch, нужен $PLATFORM"
}
build ibportal-db db
build ibportal-backend backend
build ibportal-frontend frontend
# @napi-rs/canvas (optional-зависимость pdfjs-dist) не нужен для извлечения текста PDF и не должен попасть в образ.
if docker run --rm --network none --entrypoint sh "ibportal-backend:$VERSION" -c 'test -e node_modules/@napi-rs'; then
  die "в образе ibportal-backend:$VERSION есть node_modules/@napi-rs — сборка должна идти с --omit=optional"
fi
# Содержимое образов: без исходников, .env и инструментов разработки; процессы не от root (CLAUDE.md, раздел 10).
info "проверка содержимого образов"
in_image() { docker run --rm --network none --entrypoint sh "$1:$VERSION" -c "$2" 2>/dev/null; }
leaks="$(in_image ibportal-backend '
  find / -xdev \( -name ".env" -o -name ".env.*" \) 2>/dev/null
  find /app -name "*.ts" ! -name "*.d.ts" ! -path "/app/node_modules/*" ! -path /app/prisma.config.ts
  for p in src prisma/seed dist/scripts/test-db.js node_modules/vitest node_modules/tsx node_modules/typescript node_modules/eslint; do
    [ -e "/app/$p" ] && echo "/app/$p"
  done; true')"
[ -z "$leaks" ] || die "в образе ibportal-backend лишнее: $leaks"
leaks="$(in_image ibportal-frontend 'find / -xdev \( -name ".env" -o -name ".env.*" -o -name "*.map" -o -name "*.tsx" \) 2>/dev/null; true')"
[ -z "$leaks" ] || die "в образе ibportal-frontend лишнее: $leaks"
for image in ibportal-backend ibportal-frontend; do
  user="$(docker image inspect -f '{{.Config.User}}' "$image:$VERSION")"
  case "$user" in ''|0|root|0:*|root:*) die "$image:$VERSION запускается от root (USER: '${user:-не задан}')" ;; esac
done
# ibportal-db: entrypoint postgres стартует от root и сразу переходит на пользователя postgres (gosu) — так устроен
# официальный образ; процесс СУБД работает от postgres.
echo "Размеры образов:"
docker image ls --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep -E "^ibportal-(db|backend|frontend):$VERSION " | sed 's/^/  /' || true

mkdir -p "$OUT/scripts"
info "сохранение образов"
docker save "${IMAGES[@]/%/:$VERSION}" | gzip -6 > "$OUT/ibportal-images-$VERSION.tar.gz"

# 3. Файлы эксплуатации (без исходников)
cp deploy/docker-compose.yml "$OUT/"
cp deploy/.env.example "$OUT/"
cp CHANGELOG.md "$OUT/"
cp deploy/docker-compose.restoretest.yml "$OUT/"
cp deploy/scripts/_common.sh deploy/scripts/backup.sh deploy/scripts/restore.sh deploy/scripts/restore-test.sh deploy/scripts/smoke.sh "$OUT/scripts/"
chmod +x "$OUT"/scripts/*.sh

# 4. RELEASE.md из шаблона
info "RELEASE.md"
changes() {
  # Раздел CHANGELOG для этой версии, иначе — «Не выпущено».
  local section
  section="$(awk -v v="$VERSION" '
    /^## / { if (found) exit; if (index($0, "[" v "]")) { found=1; next } }
    found { print }' CHANGELOG.md)"
  if [ -z "$(echo "$section" | tr -d '[:space:]')" ]; then
    section="$(awk '/^## / { if (found) exit; if ($0 ~ /Не выпущено/) { found=1; next } } found { print }' CHANGELOG.md)"
  fi
  echo "$section" | sed -e '/./,$!d'
}
migrations() {
  local list
  if [ -n "$PREV_TAG" ]; then
    list="$(git diff --name-only --diff-filter=A "$PREV_TAG" HEAD -- 'backend/prisma/migrations/*/migration.sql')"
  else
    list="$(git ls-files 'backend/prisma/migrations/*/migration.sql')"
  fi
  if [ -z "$list" ]; then echo "Нет. Схема базы не меняется."; return; fi
  echo "Применяются командой \`docker compose --profile tools run --rm migrate\` (шаг 5)."
  echo
  echo "| Миграция | Влияние на данные |"
  echo "|---|---|"
  while read -r f; do
    local name impact
    name="$(basename "$(dirname "$f")")"
    impact="$(grep -m1 -i 'Влияние на данные' "$f" | sed 's/^-- *Влияние на данные: *//' || true)"
    echo "| \`$name\` | ${impact:-**не указано — уточнить у разработчика до выкладки**} |"
  done <<< "$list"
}
env_changes() {
  local keys_now keys_prev added
  keys_now="$(grep -E '^[A-Z_]+=' deploy/.env.example | cut -d= -f1 | sort)"
  if [ -z "$PREV_TAG" ]; then
    echo "Первая установка: заполните все переменные из \`.env.example\`:"
    echo; echo "$keys_now" | sed 's/^/- `/; s/$/`/'; return
  fi
  keys_prev="$(git show "$PREV_TAG:deploy/.env.example" 2>/dev/null | grep -E '^[A-Z_]+=' | cut -d= -f1 | sort || true)"
  added="$(comm -23 <(echo "$keys_now") <(echo "$keys_prev"))"
  if [ -z "$added" ]; then echo "Новых переменных нет."; return; fi
  echo "Добавьте в \`.env\` до шага 5 (описание — в \`.env.example\`):"
  echo; echo "$added" | sed 's/^/- `/; s/$/`/'
}

CHANGES="$(changes)" MIGRATIONS="$(migrations)" ENV_CHANGES="$(env_changes)" \
VERSION="$VERSION" DATE="$(date '+%Y-%m-%d %H:%M')" COMMIT="$COMMIT" \
PREV_VERSION="${PREV_VERSION:-нет (первая установка)}" \
perl -pe 's/\{\{(\w+)\}\}/exists $ENV{$1} ? $ENV{$1} : $&/ge' deploy/RELEASE.template.md > "$OUT/RELEASE.md"

# 5. Контрольные суммы и общий архив
info "контрольные суммы"
( cd "$OUT" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs shasum -a 256 > SHA256SUMS )
tar -C dist -czf "$OUT.tar.gz" "ibportal-$VERSION"
( cd dist && sha256 "ibportal-$VERSION.tar.gz" > "ibportal-$VERSION.tar.gz.sha256" )

echo
echo "Релиз $VERSION готов:"
ls -lh "$OUT" "$OUT.tar.gz" | sed 's/^/  /'
echo "Передайте администратору $OUT.tar.gz и $OUT.tar.gz.sha256. Инструкция — RELEASE.md внутри архива."
