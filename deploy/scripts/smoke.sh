#!/usr/bin/env bash
# Проверка после выкладки: health, вход, /me, выход, системные объекты версии и число записей в таблицах.
#
#   ./scripts/smoke.sh --before   — перед выкладкой: запомнить число записей
#   ./scripts/smoke.sh --after    — после выкладки: проверить и сравнить с --before
#   ./scripts/smoke.sh            — только проверка
#
# Логин и пароль спрашиваются (или берутся из SMOKE_LOGIN / SMOKE_PASSWORD).
# Адрес: SMOKE_URL (по умолчанию https://localhost). Сертификат: SMOKE_CACERT, иначе проверка
# сертификата отключается (-k), потому что обращение идёт к localhost.
set -euo pipefail
source "$(dirname "$0")/_common.sh"

MODE="${1:-}"
URL="${SMOKE_URL:-https://localhost}"
STATE_DIR="$DEPLOY_DIR/scripts/.smoke"
mkdir -p "$STATE_DIR"
CURL=(curl -sS --max-time 10)
if [ -n "${SMOKE_CACERT:-}" ]; then CURL+=(--cacert "$SMOKE_CACERT"); else CURL+=(-k); fi

FAILED=0
ok() { echo "✓ $*"; }
bad() { echo "✗ $*"; FAILED=1; }

counts() {
  compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " " -v ON_ERROR_STOP=1' <<'SQL'
SELECT 'users', count(*) FROM users
UNION ALL SELECT 'roles', count(*) FROM roles
UNION ALL SELECT 'permissions', count(*) FROM permissions
UNION ALL SELECT 'user_roles', count(*) FROM user_roles
UNION ALL SELECT 'audit_log', count(*) FROM audit_log;
SQL
}

# Системные объекты, которые создаёт migrate (seed): каждая строка должна дать ровно 1.
# 1.8.0: служебная роль (ADR-0036), реестры «Осведомлённости» и пороги оценки (ADR-0037).
# Ищутся по коду, а не по названию: реестр мог получить имя «… (системный)», если своё такое уже было.
release_objects() {
  compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -v ON_ERROR_STOP=1' <<'SQL'
SELECT 'роль «Администратор портала» (portal_admin) с правами settings.manage и users.manage', count(*) FROM roles r
  WHERE r.code = 'portal_admin'
    AND (SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM role_permissions rp WHERE rp.role_id = r.id) = ARRAY['settings.manage', 'users.manage']
UNION ALL SELECT 'реестр «Сотрудники» (awareness_employees)', count(*) FROM registers
  WHERE system_key = 'awareness_employees' AND archived_at IS NULL AND deleted_at IS NULL
UNION ALL SELECT 'реестр «Результаты INDIGO» (awareness_results)', count(*) FROM registers
  WHERE system_key = 'awareness_results' AND archived_at IS NULL AND deleted_at IS NULL
UNION ALL SELECT 'пороги оценки (app_settings awareness.grades)', count(*) FROM app_settings WHERE key = 'awareness.grades';
SQL
}

if [ "$MODE" = "--before" ]; then
  counts > "$STATE_DIR/counts-before.txt"
  echo "Число записей до выкладки:"
  sed 's/^/  /' "$STATE_DIR/counts-before.txt"
  exit 0
fi

# 1. health
HEALTH="$("${CURL[@]}" -o - -w ' %{http_code}' "$URL/api/health" || true)"
if [[ "$HEALTH" == *'"status":"ok"'*' 200' ]]; then ok "health: $HEALTH"; else bad "health: $HEALTH"; fi

# 2. вход, /me, выход
LOGIN="${SMOKE_LOGIN:-}"
PASSWORD="${SMOKE_PASSWORD:-}"
[ -n "$LOGIN" ] || read -r -p "Логин для проверки входа: " LOGIN
[ -n "$PASSWORD" ] || { read -r -s -p "Пароль: " PASSWORD; echo; }
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
BODY="$(printf '{"login":"%s","password":"%s"}' "$LOGIN" "$(printf '%s' "$PASSWORD" | sed 's/\\/\\\\/g; s/"/\\"/g')")"
CODE="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -c "$JAR" -H 'Content-Type: application/json' \
  --data-binary @- "$URL/api/v1/auth/login" <<<"$BODY" || true)"
unset PASSWORD BODY
if [ "$CODE" = 200 ]; then ok "вход: 200"; else bad "вход: $CODE"; fi
CODE="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -b "$JAR" "$URL/api/v1/auth/me" || true)"
if [ "$CODE" = 200 ]; then ok "/me: 200"; else bad "/me: $CODE"; fi
CODE="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$URL/api/v1/auth/logout" || true)"
if [ "$CODE" = 204 ]; then ok "выход: 204"; else bad "выход: $CODE"; fi

# 3. системные объекты версии (что создаёт migrate)
# После отката на версию до 1.8.0 (VERSION в .env) объектов может не быть — тогда не проверяются.
if [ "$(printf '%s\n' 1.8.0 "$VERSION" | sort -V | head -n1)" = 1.8.0 ]; then
  OBJECTS="$(release_objects)" || { bad "системные объекты: запрос к базе не выполнился"; OBJECTS=""; }
else
  echo "· системные объекты 1.8.0 не проверяются: VERSION=$VERSION"
  OBJECTS=""
fi
while IFS='|' read -r what n; do
  [ -n "$what" ] || continue
  if [ "$n" = 1 ]; then ok "$what"; else bad "$what: найдено $n, нужно 1 — migrate не выполнен или прерван (RELEASE.md, шаг 5)"; fi
done <<< "$OBJECTS"

# 4. число записей
counts > "$STATE_DIR/counts-after.txt"
echo "Число записей:"
if [ "$MODE" = "--after" ] && [ -f "$STATE_DIR/counts-before.txt" ]; then
  while read -r table before; do
    after="$(awk -v t="$table" '$1==t {print $2}' "$STATE_DIR/counts-after.txt")"
    if [ -z "$after" ]; then bad "$table: таблица пропала"
    elif [ "$after" -lt "$before" ]; then bad "$table: было $before, стало $after — записи пропали"
    else ok "$table: было $before, стало $after"; fi
  done < "$STATE_DIR/counts-before.txt"
else
  sed 's/^/  /' "$STATE_DIR/counts-after.txt"
fi

if [ "$FAILED" = 0 ]; then echo "Smoke-проверка пройдена"; else echo "Smoke-проверка НЕ пройдена"; exit 1; fi
