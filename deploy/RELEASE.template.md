# Портал ИБ {{VERSION}}

| | |
|---|---|
| Версия | **{{VERSION}}** |
| Дата сборки | {{DATE}} |
| Коммит | `{{COMMIT}}` |
| Предыдущая версия | {{PREV_VERSION}} |
| Платформа образов | linux/amd64 |

## Что нового

{{CHANGES}}

Полный список изменений — `CHANGELOG.md` в этом архиве.

## Миграции базы данных

{{MIGRATIONS}}

## Переменные .env

{{ENV_CHANGES}}

## Перед выкладкой: числа на проде

Запросы только читают базу. Выполнить на работающей прежней версии до `backup.sh`, результат — в журнал выкладок.

{{PRECHECKS}}

## Состав релиза

| Файл | Что это |
|---|---|
| `ibportal-images-{{VERSION}}.tar.gz` | Образы `ibportal-db`, `ibportal-backend`, `ibportal-frontend` с тегом `{{VERSION}}` |
| `docker-compose.yml` | Сервисы портала |
| `docker-compose.restoretest.yml` | Проверка восстановления (отдельный проект `ibportal-restoretest`) |
| `scripts/` | `backup.sh`, `restore.sh`, `restore-test.sh`, `smoke.sh`, `_common.sh` |
| `.env.example` | Образец `.env` с описанием переменных (без секретов) |
| `docs/deploy.md` | Установка с нуля, резервные копии, проверка восстановления, ошибки |
| `docs/user-guide.md` | Краткое руководство пользователя |
| `CHANGELOG.md`, `SHA256SUMS` | История изменений; контрольные суммы всех файлов |

Исходный код в релиз не входит. Интернет для установки и работы не нужен: образы — из архива (`pull_policy: never`), шрифты и pdf.js — в сборке, проверки обновлений и телеметрия в образах выключены, писем портал не отправляет.

## Первая установка

Если портала на сервере ещё нет — по `docs/deploy.md`, разделы 1–9 (требования к серверу, тома, `.env`, сертификат, первый администратор, монитор, резервные копии, проверка). Разделы «Выкладка» и «Откат» ниже — для обновления.

## Выкладка (обновление)

Все команды — на сервере. Для журнала выкладок запишите дату, версию, своё имя, имя резервной копии (шаг 3) и результат и передайте разработчику.

```bash
# 1. Проверить архив, распаковать, проверить файлы
cd /srv/ibportal/releases
sha256sum -c ibportal-{{VERSION}}.tar.gz.sha256
tar -xzf ibportal-{{VERSION}}.tar.gz && cd ibportal-{{VERSION}} && sha256sum -c SHA256SUMS

# 2. Загрузить образы
docker load -i ibportal-images-{{VERSION}}.tar.gz

# 3. Резервная копия (ОБЯЗАТЕЛЬНО). Если копия не создалась — стоп
cd /srv/ibportal/deploy
./scripts/smoke.sh --before
./scripts/backup.sh               # имя копии — в журнал выкладок

# 4. Обновить compose и скрипты (.env и certs не трогаются); новые переменные из раздела выше — в .env
cp /srv/ibportal/releases/ibportal-{{VERSION}}/docker-compose*.yml .
cp /srv/ibportal/releases/ibportal-{{VERSION}}/scripts/*.sh scripts/

# 5. Новая версия, миграции, перезапуск backend и frontend. db на шаге migrate перезапускается с образом
#    новой версии (несколько секунд, данные — в томе)
sed -i 's/^VERSION=.*/VERSION={{VERSION}}/' .env
docker compose --profile tools run --rm migrate
docker compose up -d backend frontend

# 6. Проверка
./scripts/smoke.sh --after
```

## Откат

Миграции совместимы с прошлой версией — вернуть её:

```bash
cd /srv/ibportal/deploy
sed -i 's/^VERSION=.*/VERSION={{ROLLBACK_VERSION}}/' .env
docker compose up -d backend frontend
./scripts/smoke.sh
```

Если релиз испортил данные — `./scripts/restore.sh <копия из шага 3>`: проверит контрольные суммы, спросит подтверждение, сделает копию текущего состояния, восстановит и проверит целостность. Не пройдена — сервисы не поднимать, связаться с разработчиком. Затем прежний `VERSION`, `docker compose up -d backend frontend`, `./scripts/smoke.sh`. Образы прошлой версии не удалять хотя бы неделю.

## Что проверить после выкладки

- [ ] `smoke.sh` — «Smoke-проверка пройдена», число записей не уменьшилось.
- [ ] `docker compose ps`: `db` и `backend` — `healthy`, `frontend` — `running`.
- [ ] Портал открывается по `PORTAL_URL`, вход работает, меню соответствует правам.
- [ ] `docker compose logs --since 10m backend migrate` — без ошибок и попыток обратиться в интернет.
- [ ] Данные для журнала выкладок переданы разработчику.
