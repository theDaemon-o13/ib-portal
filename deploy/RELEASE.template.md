# Портал ИБ {{VERSION}}

| | |
|---|---|
| Версия | **{{VERSION}}** |
| Дата сборки | {{DATE}} |
| Коммит | `{{COMMIT}}` |
| Предыдущая версия | {{PREV_VERSION}} |
| Платформа образов | linux/amd64 |

## Что изменилось

{{CHANGES}}

## Миграции базы данных

{{MIGRATIONS}}

## Переменные .env

{{ENV_CHANGES}}

## Состав релиза

| Файл | Что это |
|---|---|
| `ibportal-images-{{VERSION}}.tar.gz` | Образы `ibportal-db`, `ibportal-backend`, `ibportal-frontend` с тегом `{{VERSION}}` |
| `docker-compose.yml` | Описание сервисов |
| `scripts/` | `backup.sh`, `restore.sh`, `smoke.sh`, `_common.sh` |
| `.env.example` | Образец `.env` (без секретов) |
| `CHANGELOG.md` | История изменений |
| `SHA256SUMS` | Контрольные суммы всех файлов релиза |

Исходный код в релиз не входит и на сервер не передаётся.

## Первая установка (только если портала на сервере ещё нет)

```bash
# Тома создаются один раз; compose их не создаёт и не удаляет
docker volume create ibportal_pgdata
docker volume create ibportal_files
docker volume create ibportal_backups

mkdir -p /srv/ibportal/deploy/scripts /srv/ibportal/deploy/certs /srv/ibportal/releases
# архив релиза положить в /srv/ibportal/releases, затем:
cd /srv/ibportal/releases
sha256sum -c ibportal-{{VERSION}}.tar.gz.sha256
tar -xzf ibportal-{{VERSION}}.tar.gz
cd ibportal-{{VERSION}} && sha256sum -c SHA256SUMS
docker load -i ibportal-images-{{VERSION}}.tar.gz
cp docker-compose.yml .env.example /srv/ibportal/deploy/
cp scripts/*.sh /srv/ibportal/deploy/scripts/

cd /srv/ibportal/deploy
cp .env.example .env && chmod 600 .env    # заполнить пароли (openssl rand -hex 24) и VERSION={{VERSION}}
# сертификат и ключ: certs/portal.crt и certs/portal.key
docker compose up -d db
docker compose --profile tools run --rm migrate
docker compose run --rm backend node dist/scripts/create-admin.js   # спросит логин, ФИО и пароль
docker compose up -d
./scripts/smoke.sh
```

Дальше — по разделу «Что проверить после выкладки».

## Выкладка

Все команды выполняются на сервере. Каталог установки — `/srv/ibportal/deploy`.
Запишите для журнала выкладок: дату, версию, своё имя, имя резервной копии (шаг 3) и результат. Журнал ведётся в `docs/runbook/deploy-log.md` у разработчика: передайте ему эти данные.

```bash
# 1. Проверить архив, распаковать, проверить файлы
cd /srv/ibportal/releases
sha256sum -c ibportal-{{VERSION}}.tar.gz.sha256
tar -xzf ibportal-{{VERSION}}.tar.gz
cd ibportal-{{VERSION}}
sha256sum -c SHA256SUMS

# 2. Загрузить образы
docker load -i ibportal-images-{{VERSION}}.tar.gz

# 3. Резервная копия (ОБЯЗАТЕЛЬНО). Если копия не создалась — стоп
cd /srv/ibportal/deploy
./scripts/smoke.sh --before
./scripts/backup.sh               # запишите имя копии для журнала выкладок

# 4. Обновить compose и скрипты (.env и certs не трогаются)
cp /srv/ibportal/releases/ibportal-{{VERSION}}/docker-compose.yml .
cp /srv/ibportal/releases/ibportal-{{VERSION}}/scripts/*.sh scripts/
# Если в разделе «Переменные .env» есть новые — добавьте их в .env сейчас

# 5. Новая версия, миграции, перезапуск backend и frontend
sed -i 's/^VERSION=.*/VERSION={{VERSION}}/' .env
docker compose --profile tools run --rm migrate
docker compose up -d backend frontend      # db не перезапускаем

# 6. Проверка
./scripts/smoke.sh --after
```

## Откат

**Если миграции совместимы с прошлой версией** (так должно быть всегда):

```bash
cd /srv/ibportal/deploy
sed -i 's/^VERSION=.*/VERSION={{PREV_VERSION}}/' .env
docker compose up -d backend frontend
./scripts/smoke.sh
```

**Если релиз испортил данные:**

```bash
cd /srv/ibportal/deploy
./scripts/restore.sh                       # список копий
./scripts/restore.sh <имя копии из шага 3> # спросит подтверждение, сделает копию текущего состояния и в конце проверит целостность
# если проверка целостности не пройдена — сервисы не поднимать, связаться с разработчиком
sed -i 's/^VERSION=.*/VERSION={{PREV_VERSION}}/' .env
docker compose up -d backend frontend
./scripts/smoke.sh
```

## Что проверить после выкладки

- [ ] `smoke.sh --after` завершился строкой «Smoke-проверка пройдена», число записей не уменьшилось.
- [ ] `docker compose ps`: `db`, `backend`, `frontend` в состоянии `running (healthy)`.
- [ ] Портал открывается в браузере, вход работает, меню соответствует правам пользователя.
- [ ] `docker compose logs --since 10m backend` без ошибок.
- [ ] Данные для журнала выкладок (дата, версия, кто, имя копии, результат) переданы разработчику.
