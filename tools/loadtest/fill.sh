#!/usr/bin/env bash
# Наполнение проверочного стенда ibportal-releasetest данными «за 3 года» (fill.sql) и файлами PDF разрешений.
# Только на машине разработчика и только для стенда: проверяется COMPOSE_PROJECT_NAME в .env стенда.
#
#   tools/loadtest/fill.sh <каталог deploy стенда>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${1:?укажите каталог deploy стенда ibportal-releasetest}"
die() { echo "ОШИБКА: $*" >&2; exit 1; }

cd "$DIR"
grep -qx 'COMPOSE_PROJECT_NAME=ibportal-releasetest' .env || die "$DIR — не стенд ibportal-releasetest"
VERSION="$(grep -E '^VERSION=' .env | cut -d= -f2)"
FILES_VOLUME="$(docker compose config --format json | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["volumes"]["files"]["name"])')"
[ "$FILES_VOLUME" = ibportal_releasetest_files ] || die "том файлов стенда: $FILES_VOLUME"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
( cd "$ROOT/backend" && npx tsx -e "import { tinyPdf } from './src/test/files-fixture.ts'; process.stdout.write(tinyPdf('Razreshenie na dostup'))" ) > "$TMP/sample.pdf"
SIZE="$(wc -c < "$TMP/sample.pdf" | tr -d ' ')"
SHA="$(shasum -a 256 "$TMP/sample.pdf" | cut -d' ' -f1)"

echo "→ данные (SQL)"
start=$(date +%s)
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d ibportal -q -v ON_ERROR_STOP=1 -v pdf_size='"$SIZE"' -v pdf_sha256='"$SHA"' -c "SET loadtest.target = '"'"'ibportal-releasetest'"'"'" -f -' \
  < "$ROOT/tools/loadtest/fill.sql"
echo "  за $(( $(date +%s) - start )) с"

echo "→ файлы PDF в томе $FILES_VOLUME"
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d ibportal -At' \
  <<<"SELECT storage_key FROM files WHERE sha256 = '$SHA' AND original_name LIKE 'Разрешение %.pdf';" > "$TMP/keys.txt"
docker run --rm -i --network none --user 1000:1000 -v "$FILES_VOLUME":/data/files -v "$TMP":/src:ro \
  --entrypoint sh "ibportal-backend:$VERSION" -c '
    n=0; while read -r k; do [ -n "$k" ] || continue; d=/data/files/${k%/*}; [ -d "$d" ] || mkdir -p "$d" && chmod 750 "$d"
      [ -e "/data/files/$k" ] || { cp /src/sample.pdf "/data/files/$k"; chmod 640 "/data/files/$k"; n=$((n+1)); }; done < /src/keys.txt
    echo "  разложено файлов: $n"'

docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d ibportal -At -F " "' <<'SQL'
SELECT r.name, count(x.*) FROM registers r JOIN register_records x ON x.register_id = r.id WHERE x.deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 4;
SELECT 'Задачи', count(*) FROM tasks;
SELECT 'Файлы', count(*) FROM files;
SQL
