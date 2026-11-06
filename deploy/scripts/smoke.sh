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

# 1.9.0: учебные письма (ADR-0039, ADR-0040) — реестр «Рассылки» со всеми системными полями, категория задач
# «Осведомлённость», «Подпись ИБ», лимиты писем, семь таблиц и четыре триггера. Каждая строка — ровно 1.
release_objects_190() {
  compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -v ON_ERROR_STOP=1' <<'SQL'
SELECT 'реестр «Рассылки» (awareness_mailings)', count(*) FROM registers
  WHERE system_key = 'awareness_mailings' AND archived_at IS NULL AND deleted_at IS NULL
UNION ALL SELECT 'системные поля реестра «Рассылки» (9)', ((SELECT count(*) FROM register_fields f JOIN registers r ON r.id = f.register_id
  WHERE r.system_key = 'awareness_mailings' AND f.deleted_at IS NULL AND f.archived_at IS NULL
    AND f.system_key IN ('sentOn', 'letter', 'subject', 'kind', 'reason', 'audience', 'preparedBy', 'task', 'approval')) = 9)::int
UNION ALL SELECT 'категория задач «Осведомлённость» (awareness)', count(*) FROM catalog_items
  WHERE catalog_code = 'task_categories' AND system_key = 'awareness' AND deleted_at IS NULL AND archived_at IS NULL
UNION ALL SELECT '«Подпись ИБ» (awareness_fragments signature)', count(*) FROM awareness_fragments WHERE code = 'signature'
UNION ALL SELECT 'лимиты писем (app_settings awareness.letters)', count(*) FROM app_settings WHERE key = 'awareness.letters'
UNION ALL SELECT 'таблицы учебных писем (7)', ((SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (
  'awareness_templates', 'awareness_fragments', 'awareness_letters', 'awareness_letter_versions', 'awareness_letter_events',
  'awareness_schedule_rules', 'awareness_schedule_runs')) = 7)::int
UNION ALL SELECT 'триггеры учебных писем (4)', ((SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
  'awareness_letter_versions_append_only', 'awareness_letter_events_append_only', 'awareness_letter_versions_guard', 'awareness_letters_guard')) = 4)::int;
SQL
}

# 1.10.0: сессии (ADR-0023, «Изменено в 1.10.0») — колонки remember и public_id в sessions (миграция
# sessions_remember). Без них backend 1.10.0 не открывает сессии. Каждая строка — ровно 1.
release_objects_1100() {
  compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -v ON_ERROR_STOP=1' <<'SQL'
SELECT 'сессии: колонки remember и public_id (sessions_remember)', ((SELECT count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name IN ('remember', 'public_id')) = 2)::int;
SQL
}

# 1.11.0: документы — маршрут из 4 этапов (миграция documents_route_v3, seed docs.route.v3) и механизмы контроля
# (миграция document_controls, ADR-0042, ADR-0043). Каждая строка — ровно 1.
release_objects_1110() {
  compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -v ON_ERROR_STOP=1' <<'SQL'
SELECT 'документы: маршрут 1.11.0 — колонки route_state, source_docx_file_id, event, onlyoffice_url (documents_route_v3)', ((SELECT count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND ((table_name = 'document_versions' AND column_name IN ('route_state', 'source_docx_file_id'))
    OR (table_name = 'document_approvals' AND column_name = 'event') OR (table_name = 'document_translations' AND column_name = 'onlyoffice_url'))) = 4)::int
UNION ALL SELECT 'документы: маршрут 1.11.0 — триггеры неизменности утверждённой версии (2)', ((SELECT count(*) FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN ('document_translations_frozen', 'document_parties_frozen')) = 2)::int
UNION ALL SELECT 'механизмы контроля: таблицы (4)', ((SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
  AND table_name IN ('document_party_rechecks', 'document_controls', 'document_control_automations', 'document_control_runs')) = 4)::int
UNION ALL SELECT 'механизмы контроля: триггеры (3)', ((SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
  AND tgname IN ('document_controls_no_delete', 'document_control_automations_no_delete', 'document_control_runs_append_only')) = 3)::int
UNION ALL SELECT 'категория задач «Контроль по документу» (document_control)', (SELECT count(*) FROM catalog_items
  WHERE catalog_code = 'task_categories' AND system_key = 'document_control' AND deleted_at IS NULL)::int
UNION ALL SELECT 'рабочих версий на этапах 11–16 нет (seed docs.route.v3)', ((SELECT count(*) FROM documents d JOIN document_versions v ON v.id = d.working_version_id
  WHERE v.stage BETWEEN 11 AND 16 AND v.approved_at IS NULL AND v.cancelled_at IS NULL) = 0)::int;
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
# После отката на более раннюю версию (VERSION в .env) объектов может не быть — тогда не проверяются.
if [ "$(printf '%s\n' 1.8.0 "$VERSION" | sort -V | head -n1)" = 1.8.0 ]; then
  OBJECTS="$(release_objects)" || { bad "системные объекты: запрос к базе не выполнился"; OBJECTS=""; }
else
  echo "· системные объекты 1.8.0 не проверяются: VERSION=$VERSION"
  OBJECTS=""
fi
# 1.12.0: учебные письма — макет, выгрузка, регистрация отправки (миграции awareness_layout, awareness_eml_mime,
# seed awareness.v3; ADR-0044–0046). Каждая строка — ровно 1.
release_objects_1120() {
  compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -v ON_ERROR_STOP=1' <<'SQL'
SELECT 'учебные письма 1.12.0: шапка письма — колонки у шаблонов и версий (10)', ((SELECT count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name IN ('awareness_templates', 'awareness_letter_versions')
    AND column_name IN ('header_ru', 'header_tj', 'label_ru', 'label_tj', 'subject_both')) = 10)::int
UNION ALL SELECT 'учебные письма 1.12.0: таблицы awareness_layout и awareness_letter_exports', ((SELECT count(*) FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('awareness_layout', 'awareness_letter_exports')) = 2)::int
UNION ALL SELECT 'учебные письма 1.12.0: выгрузки только пополняются (триггер)', (SELECT count(*) FROM pg_trigger
  WHERE NOT tgisinternal AND tgname = 'awareness_letter_exports_append_only')::int
UNION ALL SELECT '«Оформление писем» на месте (seed awareness.v3)', (SELECT count(*) FROM awareness_layout WHERE id = 1)::int
UNION ALL SELECT 'тип файла message/rfc822 допустим (awareness_eml_mime)', (SELECT count(*) FROM pg_constraint
  WHERE conname = 'files_mime_check' AND pg_get_constraintdef(oid) LIKE '%message/rfc822%')::int
UNION ALL SELECT 'поля «Рассылок» 1.12.0: «Шаблон», «Языки», «Получатели», «Файл письма» (4)', ((SELECT count(*) FROM register_fields f JOIN registers r ON r.id = f.register_id
  WHERE r.system_key = 'awareness_mailings' AND f.system_key IN ('template', 'langs', 'recipients', 'file') AND f.deleted_at IS NULL) = 4)::int;
SQL
}

if [ "$(printf '%s\n' 1.9.0 "$VERSION" | sort -V | head -n1)" = 1.9.0 ]; then
  OBJECTS="$OBJECTS"$'\n'"$(release_objects_190)" || bad "системные объекты 1.9.0: запрос к базе не выполнился"
else
  echo "· системные объекты 1.9.0 не проверяются: VERSION=$VERSION"
fi
if [ "$(printf '%s\n' 1.10.0 "$VERSION" | sort -V | head -n1)" = 1.10.0 ]; then
  OBJECTS="$OBJECTS"$'\n'"$(release_objects_1100)" || bad "системные объекты 1.10.0: запрос к базе не выполнился"
else
  echo "· системные объекты 1.10.0 не проверяются: VERSION=$VERSION"
fi
if [ "$(printf '%s\n' 1.11.0 "$VERSION" | sort -V | head -n1)" = 1.11.0 ]; then
  OBJECTS="$OBJECTS"$'\n'"$(release_objects_1110)" || bad "системные объекты 1.11.0: запрос к базе не выполнился"
else
  echo "· системные объекты 1.11.0 не проверяются: VERSION=$VERSION"
fi
if [ "$(printf '%s\n' 1.12.0 "$VERSION" | sort -V | head -n1)" = 1.12.0 ]; then
  OBJECTS="$OBJECTS"$'\n'"$(release_objects_1120)" || bad "системные объекты 1.12.0: запрос к базе не выполнился"
else
  echo "· системные объекты 1.12.0 не проверяются: VERSION=$VERSION"
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
