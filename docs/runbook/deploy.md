# Выкладка Портала ИБ

Подробная версия разделов 10–11 CLAUDE.md. Сервер — в закрытом контуре банка, на нём есть только Docker и Docker Compose v2. Claude Code, git и Node на сервере нет.

## Кто что делает

| Шаг | Где | Кто |
|---|---|---|
| Сборка релиза `make-release.sh` | Машина разработчика (Mac, Docker Desktop с buildx) | Разработчик |
| Передача архива на сервер | По регламенту банка | Разработчик → администратор |
| Выкладка по `RELEASE.md` | Сервер | Администратор |
| Запись в `deploy-log.md` | Репозиторий | Разработчик со слов администратора |

На сервер передаются только `ibportal-<VERSION>.tar.gz` и `ibportal-<VERSION>.tar.gz.sha256`. Исходники и отдельные файлы кода на сервер не передаются никогда: код приезжает внутри образов.

## Каталоги на сервере

```
/srv/ibportal/
├─ deploy/
│  ├─ docker-compose.yml       # из релиза
│  ├─ .env                     # chmod 600, только на сервере
│  ├─ .env.example             # из релиза
│  ├─ certs/portal.crt, portal.key
│  └─ scripts/                 # backup.sh, restore.sh, smoke.sh, _common.sh — из релиза
└─ releases/
   └─ ibportal-<VERSION>/      # распакованные релизы; два последних не удалять
```

Тома Docker (создаются вручную один раз, `external: true` в compose): `ibportal_pgdata`, `ibportal_files`, `ibportal_backups`.

## Сборка релиза (разработчик)

Требования: Docker Desktop с `buildx`, доступ к npm-реестру и Docker Hub (базовые образы закреплены по тегу и digest в Dockerfile: `node:24.22.1-alpine3.24`, `nginxinc/nginx-unprivileged:1.28.2-alpine3.23`, `postgres:16.15-alpine3.24`).

```bash
# 1. CHANGELOG.md: раздел «Не выпущено» переименовать в [X.Y.Z] — дата; VERSION = X.Y.Z
git commit -am "release: X.Y.Z"
git tag vX.Y.Z
# 2. Сборка
./deploy/scripts/make-release.sh
# 3. Прочитать dist/ibportal-X.Y.Z/RELEASE.md: миграции, «Влияние на данные», новые переменные .env
```

Пробная сборка с незакоммиченными изменениями: `--allow-dirty` (не для передачи на сервер). Пересобрать ту же версию: `--force`.

Образы собираются строго под `linux/amd64` (`docker buildx build --platform linux/amd64 --load`); скрипт проверяет архитектуру каждого образа. На Mac с Apple Silicon сборка идёт через эмуляцию и занимает заметно дольше.

## Первичная настройка сервера

Команды — в разделе «Первая установка» файла `RELEASE.md`. Важное:

- **До первой выкладки — согласовать подсети с сетевым отделом банка.** Подсети Docker-сетей портала не должны пересекаться с сетями банка: иначе сервер перестанет достучаться до машин из пересекающейся сети (в том числе до рабочих мест и настенных мониторов).
  - Сеть `front` (nginx ↔ backend): `FRONT_SUBNET`, по умолчанию `172.31.250.0/29`; адрес nginx `FRONTEND_IP` (`172.31.250.6`) и `TRUSTED_PROXY_IPS` меняются вместе с ней (ADR-0012).
  - Сеть `back` (backend ↔ db, `internal`): `BACK_SUBNET`, по умолчанию `172.31.249.0/24`.
  - Согласованные значения записать в `.env` и в `deploy-log.md`. Смена подсети после первого запуска — `docker compose down` (без `-v`, тома external) и `up -d`.
- Пароли в `.env` — случайные: `openssl rand -hex 24`; `SESSION_SECRET` — `openssl rand -hex 32`.
- `DB_APP_USER` не должен совпадать с `DB_OWNER_USER` и с `ibportal_app` (имя групповой роли).
- Init-скрипт ролей БД выполняется только на пустом томе `ibportal_pgdata`. Если том уже инициализирован, смена паролей в `.env` сама по себе роли не меняет.
- Первый администратор: `docker compose run --rm backend node dist/scripts/create-admin.js`. Скрипт спрашивает логин, ФИО и пароль (не отображается при вводе) и проверяет парольную политику.
- **Рабочие места администраторов — `ADMIN_ALLOWED_IPS`** (ADR-0015, компенсирующая мера вместо MFA). Пользователь с правами «Настройки» или «Пользователи, роли и права» входит только с перечисленных адресов (IP и подсети через запятую); с другого адреса портал отвечает «Неверный логин или пароль», в журнале аудита причина `admin_ip_denied`, открытая сессия с чужого адреса закрывается (`auth.admin_ip_denied`). Рабочим местам администраторов нужны постоянные адреса. Пусто — без ограничения (тогда в форме «Парольная защита» компенсирующей меры нет).
- **Восстановление доступа администратора** (только из консоли сервера):
  - ошибка в списке и никто из администраторов не может войти — исправить или очистить `ADMIN_ALLOWED_IPS` в `.env`, затем `docker compose up -d backend`;
  - потерян пароль или не осталось администратора — `docker compose run --rm backend node dist/scripts/create-admin.js` (адреса не проверяет; новый администратор входит с адресов из списка).

## Выкладка новой версии

Команды — в разделе «Выкладка» файла `RELEASE.md`. Порядок нельзя менять:

1. Проверка `sha256sum -c` архива и `SHA256SUMS` внутри.
2. `docker load` образов.
3. `smoke.sh --before`, затем `backup.sh`. **Если копия не создалась — стоп.**
4. Обновление `docker-compose.yml` и `scripts/` из релиза; новые переменные — в `.env`.
5. `VERSION` в `.env`, `migrate` (миграции + seed прав и ролей), `up -d backend frontend`.
6. `smoke.sh --after`: health, вход, `/me`, выход, число записей не уменьшилось.

## Откат и восстановление

- Совместимые миграции (норма): вернуть прежний `VERSION`, `docker compose up -d backend frontend`.
- Данные испорчены: `./scripts/restore.sh <копия>`. Скрипт проверяет контрольные суммы, просит ввести имя копии, делает копию текущего состояния, останавливает backend и frontend и заменяет базу одной транзакцией и файлы. В конце запускается `check-integrity`. Сервисы после этого поднимает администратор, и только если проверка пройдена.
- Почему восстановление не обычный `pg_restore --clean`: таблицы при пересоздании получили бы полный набор прав из `ALTER DEFAULT PRIVILEGES`, и запрет `UPDATE`/`DELETE` на `audit_log` потерялся бы (в дампе есть только `GRANT`). `restore.sh` снимает default privileges в той же транзакции, а точные права и default privileges возвращаются из дампа.

## Резервные копии

- Ежедневно по cron: `0 2 * * * cd /srv/ibportal/deploy && ./scripts/backup.sh --rotate >> /var/log/ibportal-backup.log 2>&1`.
- Ротация: 14 последних копий и по одной за каждый из 6 последних месяцев. Без `--rotate` ничего не удаляется.
- Состав копии `<дата>_<время>_<версия>/`: `db.dump` (`pg_dump -Fc`), `files.tar.gz`, `manifest.txt`, `SHA256SUMS`.
- Вынос копий за пределы сервера — по регламенту банка: том `ibportal_backups` (`docker run --rm -v ibportal_backups:/b ...` или путь тома из `docker volume inspect`).
- Ежемесячная проверка восстановления — в отдельном проекте `ibportal-restoretest` (порядок будет описан отдельно), отметка в `deploy-log.md`. Скрипты работают с другими томами через переменные `IBPORTAL_BACKUP_VOLUME` и `IBPORTAL_FILES_VOLUME` и с другим compose-проектом через стандартные `COMPOSE_PROJECT_NAME` и `COMPOSE_FILE`. На рабочем сервере эти переменные не задаются.

## Dev-окружение (машина разработчика)

```bash
cd deploy
cp .env.dev.example .env.dev
docker volume create ibportal_dev_pgdata
docker volume create ibportal_dev_files
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d db
docker compose -f docker-compose.dev.yml --env-file .env.dev --profile tools run --rm migrate
docker compose -f docker-compose.dev.yml --env-file .env.dev run --rm backend npm run create-admin
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d backend frontend
# http://localhost:5173 — в Chrome или Firefox (Safari не принимает Secure-cookie на http://localhost)
```

Тесты с настоящим PostgreSQL (нужна запущенная dev-база на `127.0.0.1:5433`): `cd backend && npm run test:db`. Скрипт пересоздаёт одноразовую базу `ibportal_test`, применяет миграции и seed; пароли берёт из `deploy/.env.dev`.

Сквозной тест интерфейса: `cd frontend && E2E_LOGIN=admin.dev E2E_PASSWORD=... npm run test:e2e`. Он запускает установленный Chrome без окна (путь можно задать в `CHROME_PATH`), работает только с `localhost` и проходит все операции изменения раздела «Настройки» настоящими событиями мыши и клавиатуры, проверяя тело запросов и результат на экране. Создаёт значения с пометкой «E2E» и удаляет их; созданный тестом пользователь `e2e.*` остаётся отключённым, записи журнала аудита остаются. Выпадающие списки и поля даты заполняются программно (в headless Chrome их нельзя открыть мышью).

Сервисы `backend` и `migrate` в dev сами выполняют `prisma generate` при запуске, поэтому после изменения схемы достаточно перезапустить их.

После добавления или обновления npm-зависимостей dev-образы нужно пересобрать, а анонимный том `node_modules` — обновить: `docker compose -f docker-compose.dev.yml --env-file .env.dev up -d --build -V backend` (и `frontend`, если менялся он). Флаг `-V` пересоздаёт только анонимные тома с зависимостями, тома данных `ibportal_dev_*` не затрагиваются.

Новая миграция: `... --profile tools run --rm migrate npx prisma migrate dev --create-only --name <что_меняем>`, затем прочитать SQL, добавить строку «Влияние на данные» в начало файла и применить `... run --rm migrate`. Проверка: `... run --rm migrate npm run check:integrity`.
