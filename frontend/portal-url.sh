#!/bin/sh
# Запускается при старте контейнера (/docker-entrypoint.d): по PORTAL_URL строит правило nginx —
# страница портала, открытая по другому адресу (по IP, по другому имени), перенаправляется (301) на PORTAL_URL.
# Иначе пользователь сможет читать, но не сохранить: backend принимает изменения только с Origin = PORTAL_URL.
# Пусто — без перенаправления (backend без PORTAL_URL всё равно не стартует).
set -eu
out=/etc/nginx/conf.d/00-portal-url.conf
url="$(printf '%s' "${PORTAL_URL:-}" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
url="${url%/}"
if [ -z "$url" ]; then
  echo "$0: PORTAL_URL не задан — перенаправления на адрес портала нет" >&2
  printf 'map $http_host $portal_redirect { default ""; }\n' > "$out"
  exit 0
fi
case "$url" in
  https://*) ;;
  *) echo "$0: PORTAL_URL должен начинаться с https:// (сейчас: $url)" >&2; exit 1 ;;
esac
host="${url#https://}"
case "$host" in
  ''|*/*|*'?'*|*'#'*|*@*|*' '*|*'"'*|*"'"*|*';'*|*'{'*|*'}'*|*'$'*)
    echo "$0: PORTAL_URL — только https://имя[:порт], без пути (сейчас: $url)" >&2; exit 1 ;;
esac
host="${host%:443}"   # браузер не присылает порт по умолчанию
url="https://$host"
cat > "$out" <<EOF
# Создан при старте контейнера из PORTAL_URL ($0).
map \$http_host \$portal_redirect {
    "$host" "";
    default "$url";
}
EOF
echo "$0: адрес портала $url — страницы по другому адресу перенаправляются на него"
