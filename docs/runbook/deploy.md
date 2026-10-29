# Портал ИБ: установка и эксплуатация

Для администратора сервера (DevOps). Установка с нуля — разделы 1–9, по порядку. Обновление на новую версию и откат — по `RELEASE.md` из архива релиза (там же команды для конкретной версии).

Портал работает в закрытом контуре без интернета: на сервере нужны только Docker и Docker Compose. Исходного кода, git и Node на сервере нет — код приезжает внутри образов в архиве релиза.

## 1. Требования к серверу

| | |
|---|---|
| ОС | Linux x86_64 (amd64), например RHEL/Astra/Ubuntu с поддержкой Docker |
| Процессор, память | 4 vCPU, 8 ГБ RAM |
| Диск | SSD 100 ГБ: образы ~1,3 ГБ на версию (хранить две), база и файлы, резервные копии (до 20 копий: 14 последних и 6 месячных) |
| Docker | Docker Engine 24 или новее, Docker Compose v2.24 или новее (`docker compose version`) |
| Сеть | Входящий TCP 443 от рабочих мест пользователей; интернет не нужен |
| Время | Синхронизация времени (NTP банка): сроки, блокировки входа и сессии считаются по часам сервера |
| Имя | DNS-имя портала в сети банка, например `ib-portal.bank.local`, и сертификат на него (раздел 4) |

Перед установкой согласовать с сетевым отделом две подсети для внутренних сетей Docker (раздел 3, `FRONT_SUBNET`, `BACK_SUBNET`): они не должны пересекаться с сетями банка, иначе сервер перестанет достучаться до машин из пересекающейся сети.

## 2. Каталоги, тома, загрузка релиза

Передаются два файла: `ibportal-<версия>.tar.gz` и `ibportal-<версия>.tar.gz.sha256`.

```bash
sudo mkdir -p /srv/ibportal/releases /srv/ibportal/deploy/scripts /srv/ibportal/deploy/certs
# архив и .sha256 положить в /srv/ibportal/releases
cd /srv/ibportal/releases
sha256sum -c ibportal-<версия>.tar.gz.sha256          # ожидается: OK
tar -xzf ibportal-<версия>.tar.gz
cd ibportal-<версия> && sha256sum -c SHA256SUMS        # все файлы: OK
docker load -i ibportal-images-<версия>.tar.gz         # ibportal-db, ibportal-backend, ibportal-frontend:<версия>

cp docker-compose.yml docker-compose.restoretest.yml .env.example /srv/ibportal/deploy/
cp scripts/*.sh /srv/ibportal/deploy/scripts/

# Тома — один раз. Compose их не создаёт и не удаляет (external), даже docker compose down -v
docker volume create ibportal_pgdata
docker volume create ibportal_files
docker volume create ibportal_backups
```

Итог:

```
/srv/ibportal/
├─ deploy/                      # рабочий каталог: все команды — отсюда
│  ├─ docker-compose.yml
│  ├─ docker-compose.restoretest.yml
│  ├─ .env                      # раздел 3, chmod 600
│  ├─ .env.example
│  ├─ certs/portal.crt, portal.key
│  └─ scripts/                  # backup.sh, restore.sh, restore-test.sh, smoke.sh, _common.sh
├─ releases/ibportal-<версия>/  # распакованные релизы; два последних не удалять (откат)
└─ restoretest/                 # проверка восстановления, раздел 8
```

## 3. Файл .env

```bash
cd /srv/ibportal/deploy
cp .env.example .env && chmod 600 .env
```

Заполнить (все значения — без кавычек):

| Переменная | Что указать |
|---|---|
| `VERSION` | Версия релиза, например `1.1.0`. Меняется при каждом обновлении |
| `DB_OWNER_USER` | Владелец схемы БД (только миграции). Оставить `ibportal_owner` |
| `DB_OWNER_PASSWORD` | Случайный: `openssl rand -hex 24` |
| `DB_APP_USER` | Логин backend в БД. Оставить `ibportal_app_login`; не совпадает с `DB_OWNER_USER` и с `ibportal_app` |
| `DB_APP_PASSWORD` | Случайный: `openssl rand -hex 24` |
| `SESSION_SECRET` | Подпись cookie сессии: `openssl rand -hex 32`. Смена — все пользователи выйдут |
| `PORTAL_URL` | **Обязательно.** Адрес, по которому пользователи открывают портал: `https://ib-portal.bank.local` (с портом, если не 443: `https://ib-portal.bank.local:8443`). Без пути. Без него backend не стартует. Портал, открытый по другому адресу (по IP, другому имени), перенаправляется на `PORTAL_URL`; изменения принимаются только со страниц этого адреса (защита от подделки запросов) |
| `APP_TZ` | Часовой пояс для сроков и «сегодня»: `Asia/Dushanbe` |
| `AUTOMATION_INTERVAL_MIN` | Как часто проверять правила автоматизаций, минут: `60`. `0` — не проверять по расписанию |
| `ADMIN_ALLOWED_IPS` | Рабочие места администраторов: IP и подсети через запятую, например `10.0.1.15, 10.0.2.0/28`. Пользователь с правами «Настройки» или «Пользователи, роли и права» входит только с них; с другого адреса — «Неверный логин или пароль», причина в журнале аудита. Пусто — без ограничения. Рекомендуется заполнить (компенсирующая мера вместо MFA, ADR-0015) |
| `MONITOR_ALLOWED_IPS` | Компьютеры у настенных мониторов: IP и подсети через запятую. Учётная запись «Настенный монитор» входит только с них. Пусто — монитор войти не может |
| `ONLYOFFICE_URL_PREFIX` | Адрес сервера OnlyOffice банка, например `https://onlyoffice.bank.local/`. Ссылки на файлы документов принимаются только с него. Пусто — любая ссылка http(s) |
| `FRONT_SUBNET` | Подсеть nginx ↔ backend, согласованная с сетевым отделом, маска /29. По умолчанию `172.31.250.0/29` |
| `FRONTEND_IP` | Постоянный адрес nginx в `FRONT_SUBNET` — последний адрес подсети, например `172.31.250.6` |
| `TRUSTED_PROXY_IPS` | Кому backend верит в адресе клиента: равен `FRONTEND_IP`. Меняется вместе с `FRONT_SUBNET` |
| `BACK_SUBNET` | Подсеть backend ↔ db (без выхода наружу), согласованная с сетевым отделом. По умолчанию `172.31.249.0/24` |

Адреса в `ADMIN_ALLOWED_IPS` и `MONITOR_ALLOWED_IPS` — так, как их видит сервер портала (без NAT между пользователями и сервером это адреса рабочих мест). Ошибка в формате списка — backend не стартует и пишет, что не так (`docker compose logs backend`).

## 4. Сертификат

nginx читает `certs/portal.crt` и `certs/portal.key`:

- `portal.crt` — сертификат на имя из `PORTAL_URL` (в SAN), выпущенный ЦС банка; если есть промежуточные — в том же файле после сертификата сервера;
- `portal.key` — закрытый ключ без пароля.

Права: nginx в контейнере работает от пользователя с uid 101 и должен прочитать ключ.

```bash
cd /srv/ibportal/deploy/certs
sudo chown root:101 portal.key portal.crt
sudo chmod 640 portal.key
sudo chmod 644 portal.crt
```

Проверка соответствия ключа и сертификата: `openssl x509 -noout -modulus -in portal.crt | sha256sum` и `openssl rsa -noout -modulus -in portal.key | sha256sum` — одинаковые. Замена сертификата: положить новые файлы, затем `docker compose restart frontend`.

## 5. Первый запуск

```bash
cd /srv/ibportal/deploy
docker compose up -d db
docker compose ps db                                   # healthy
docker compose --profile tools run --rm migrate        # миграции, права и системные роли; «Seed выполнен»
docker compose run --rm backend node dist/scripts/create-admin.js
#   Логин (латиница), ФИО, пароль дважды (не отображается): не короче 12 символов, 3 класса символов
docker compose up -d
docker compose ps                                       # db, backend — healthy; frontend — running
./scripts/smoke.sh                                      # спросит логин и пароль администратора
```

Первый администратор входит с адреса из `ADMIN_ALLOWED_IPS` (если список задан). Остальных пользователей и роли он заводит в «Настройки → Пользователи и роли»; временный пароль показывается один раз, при первом входе пользователь его меняет.

**Восстановление доступа администратора** (только из консоли сервера):
- ошибка в `ADMIN_ALLOWED_IPS` и никто из администраторов не может войти — исправить или очистить список в `.env`, затем `docker compose up -d backend`;
- забыт пароль или не осталось администратора — `docker compose run --rm backend node dist/scripts/create-admin.js` с новым логином (адреса не проверяет).

## 6. Настенный монитор

1. Администратор создаёт пользователя с единственной ролью «Настенный монитор» (с другими ролями она не сочетается).
2. Адрес компьютера у монитора — в `MONITOR_ALLOWED_IPS`, затем `docker compose up -d backend`.
3. На компьютере у монитора: браузер (Chrome, Edge, Firefox) → `PORTAL_URL` → вход учётной записью монитора → смена временного пароля → открывается экран мониторинга. Полноэкранный режим — кнопкой на панели или F11. Сессия монитора не завершается по бездействию, абсолютный срок — 7 суток (с релиза 1.2.0), затем вход заново. Смена пароля монитора, снятие его роли или отключение закрывают сессию сразу.

## 7. Резервные копии

`backup.sh` пишет в том `ibportal_backups` каталог `<дата>_<время>_<версия>/`: `db.dump` (дамп базы, проверяется чтением целиком), `files.tar.gz` (файлы), `manifest.txt`, `SHA256SUMS`. Скрипт ничего не удаляет; с `--rotate` оставляет 14 последних копий и по одной за каждый из 6 последних месяцев. Неудавшаяся копия остаётся как `failed_<имя>` — разобрать вручную.

Ежедневно в 02:15, cron пользователя root (или пользователя в группе `docker`):

```bash
sudo crontab -e
15 2 * * * cd /srv/ibportal/deploy && /usr/bin/flock -n /run/ibportal-backup.lock ./scripts/backup.sh --rotate >> /var/log/ibportal-backup.log 2>&1
```

Если `docker` не в `/usr/bin`, добавить в начало crontab строку `PATH=/usr/local/bin:/usr/bin:/bin`. Проверка: `./scripts/backup.sh` вручную — последняя строка «Копия создана: …»; на следующий день — та же строка в `/var/log/ibportal-backup.log`. Копия делается и перед каждым обновлением (`RELEASE.md`). Ротация журнала — logrotate по правилам сервера.

**Вынос копий за пределы сервера** (по регламенту банка; место хранения: ______________ — заполняет DevOps):

```bash
B=$(docker volume inspect -f '{{.Mountpoint}}' ibportal_backups)    # каталог тома на хосте (root)
sudo ls -1 "$B"                                                        # копии
N=2026-10-29_021500_<версия>                                             # выносимая копия
sudo tar -C "$B" -cf /tmp/ibportal-backup-$N.tar "$N"
sha256sum /tmp/ibportal-backup-$N.tar > /tmp/ibportal-backup-$N.tar.sha256
# перенести оба файла в место хранения; там:
sha256sum -c ibportal-backup-$N.tar.sha256                             # OK — копия доехала целой
tar -xf ibportal-backup-$N.tar && (cd $N && sha256sum -c SHA256SUMS)   # OK — содержимое копии целое
rm /tmp/ibportal-backup-$N.tar /tmp/ibportal-backup-$N.tar.sha256      # на сервере — после проверки
```

Копии содержат все данные портала (в том числе журнал аудита и файлы доказательств) — хранить как конфиденциальные.

## 8. Проверка восстановления (раз в месяц)

Копия восстанавливается в отдельный проект `ibportal-restoretest` со своими томами и портом `127.0.0.1:8444`; рабочие тома только читаются.

Один раз:

```bash
docker volume create ibportal_restoretest_pgdata
docker volume create ibportal_restoretest_files
docker volume create ibportal_restoretest_backups
sudo mkdir -p /srv/ibportal/restoretest && cd /srv/ibportal/restoretest
cp -r ../deploy/docker-compose.yml ../deploy/docker-compose.restoretest.yml ../deploy/scripts ../deploy/certs .
cp ../deploy/.env.example .env && chmod 600 .env
```

В `restoretest/.env`: свои случайные пароли и `SESSION_SECRET`, `VERSION` — как у рабочего, `PORTAL_URL=https://localhost:8444`, другие подсети (не как у рабочего, например `FRONT_SUBNET=172.31.246.0/29`, `FRONTEND_IP=172.31.246.6`, `TRUSTED_PROXY_IPS=172.31.246.6`, `BACK_SUBNET=172.31.245.0/24` — тоже согласовать) и две строки:

```
COMPOSE_PROJECT_NAME=ibportal-restoretest
COMPOSE_FILE=docker-compose.yml:docker-compose.restoretest.yml
```

Каждый месяц (после обновления портала — сначала обновить `docker-compose.yml`, `scripts/` и `VERSION` и здесь):

```bash
cd /srv/ibportal/restoretest
docker run --rm -v ibportal_backups:/b:ro --entrypoint ls ibportal-backend:<версия> /b    # список копий
./scripts/restore-test.sh <имя последней копии>        # «Целостность в порядке»
SMOKE_URL=https://localhost:8444 ./scripts/smoke.sh     # вход — учётной записью рабочего портала
docker compose down                                     # тома проверки остаются до следующего раза
```

Результат (дата, копия, «пройдено») передать разработчику для `deploy-log.md`.

## 9. Проверка после установки

- [ ] `docker compose ps`: `db` и `backend` — `healthy`, `frontend` — `running`.
- [ ] `./scripts/smoke.sh` — «Smoke-проверка пройдена».
- [ ] В браузере на рабочем месте: `PORTAL_URL` открывается без предупреждения о сертификате; вход администратора; меню «Дашборд, Мониторинг, Конструктор реестров, Задачи, Документы, Доказательства, Настройки».
- [ ] Открытие по IP сервера перенаправляет на `PORTAL_URL`.
- [ ] Вход администратора с адреса не из `ADMIN_ALLOWED_IPS` отклоняется (если список задан).
- [ ] Загрузка PDF в «Доказательства» и его просмотр в карточке.
- [ ] `./scripts/backup.sh` создаёт копию; cron настроен (раздел 7).
- [ ] `docker compose logs --since 10m backend migrate` — без ошибок и попыток обратиться в интернет.
- [ ] Данные для журнала выкладок переданы разработчику: дата, версия, кто устанавливал, имя копии, результат.

## 10. Если что-то не так

| Признак | Причина и что делать |
|---|---|
| `docker compose up`: `pull access denied` / `image not found` | Образы этой версии не загружены: `docker load -i ibportal-images-<версия>.tar.gz`; `VERSION` в `.env` = версии архива |
| backend перезапускается, в `docker compose logs backend` — «Неверная конфигурация: …» | Ошибка в `.env`: в сообщении — переменная и что не так (`PORTAL_URL`, список IP, `SESSION_SECRET` короче 32 символов). Исправить, `docker compose up -d backend` |
| frontend не стартует, в логах `cannot load certificate` / `Permission denied` | Нет `certs/portal.crt`/`portal.key` или ключ не читается uid 101 — раздел 4 |
| frontend не стартует, в логах `40-portal-url.sh: PORTAL_URL должен начинаться с https://` | Исправить `PORTAL_URL` |
| Подключение к БД не удаётся, `password authentication failed` | Пароли в `.env` поменяли после первого запуска: роли БД создаются только на пустом томе. Вернуть прежние пароли |
| Вход: «Неверный логин или пароль» при верном пароле | Администратор входит не с адреса из `ADMIN_ALLOWED_IPS` (в журнале аудита — `admin_ip_denied`) или монитор не с `MONITOR_ALLOWED_IPS` (`kiosk_ip_denied`). После 5 ошибок вход блокируется на 15 минут |
| Страницы открываются, но изменения не сохраняются: «Запрос отклонён: неизвестный источник» | Портал открыт не по `PORTAL_URL` (другое имя или порт). Открывать по `PORTAL_URL`; при смене имени — поменять `PORTAL_URL` и `docker compose up -d backend frontend` |
| После включения портала пропал доступ к части сети банка | Подсеть Docker пересекается с сетью банка: согласовать другие `FRONT_SUBNET`/`BACK_SUBNET`/`FRONTEND_IP`/`TRUSTED_PROXY_IPS`, затем `docker compose down` (без `-v`) и `docker compose up -d` |
| `backup.sh`: «дамп не читается» / «сервис db не запущен» / нет места | `docker compose ps db`; `df -h`; копия не создана — обновление не продолжать |
| `restore.sh`: «проверка целостности не пройдена» | Сервисы не поднимать, передать вывод разработчику |
| `migrate` завершился ошибкой | Не поднимать backend новой версии: вернуть прежний `VERSION`, `docker compose up -d backend frontend`, передать вывод разработчику |

Логи: `docker compose logs --since 1h backend` (frontend, db — так же). Журнал аудита — в портале не показывается целиком; при разборе инцидента разработчик выгружает его из БД.

## Обновление и откат

По `RELEASE.md` нового релиза: проверка архива → `docker load` → `smoke.sh --before` → `backup.sh` (обязательно; нет копии — стоп) → новые `docker-compose.yml` и `scripts/` → новые переменные в `.env` → `VERSION` → `migrate` → `up -d backend frontend` → `smoke.sh --after`. Откат — вернуть прежний `VERSION` и `docker compose up -d backend frontend` (миграции совместимы с прошлой версией); если данные испорчены — `./scripts/restore.sh <копия>`. Образы прошлой версии не удалять хотя бы неделю.

---

## Для разработчика

**Сборка релиза** (Mac или Linux x86_64, Docker с buildx, доступ к npm и Docker Hub; пошагово для DevOps, с проверкой на тестовом стенде — `docs/runbook/build.md`):

```bash
# CHANGELOG: «Не выпущено» → [X.Y.Z] — дата, вверху раздела — краткая сводка (она попадает в RELEASE.md); VERSION = X.Y.Z
git commit -am "release: X.Y.Z" && git tag vX.Y.Z
./deploy/scripts/make-release.sh        # из чистого дерева; --allow-dirty и --force — только для пробы
# прочитать dist/ibportal-X.Y.Z/RELEASE.md: миграции и «Влияние на данные», новые переменные .env
```

Образы — `linux/amd64`; скрипт проверяет архитектуру, состав образов (без исходников, `.env`, dev-зависимостей; процессы не от root) и печатает размеры. Проверка релиза до передачи — на стенде `ibportal-releasetest` (свои тома и порт 8443): e2e против него — `NODE_EXTRA_CA_CERTS=<сертификат стенда> E2E_BASE_URL=https://localhost:8443 npm run test:e2e` во frontend; нагрузка — `tools/loadtest/README.md`.

**Dev-окружение:**

```bash
cd deploy
cp .env.dev.example .env.dev
docker volume create ibportal_dev_pgdata && docker volume create ibportal_dev_files
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d db
docker compose -f docker-compose.dev.yml --env-file .env.dev --profile tools run --rm migrate
docker compose -f docker-compose.dev.yml --env-file .env.dev run --rm backend npm run create-admin
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d backend frontend
# http://localhost:5173 — в Chrome или Firefox (Safari не принимает Secure-cookie на http://localhost)
```

- Тесты с PostgreSQL: `cd backend && npm run test:db` (одноразовая `ibportal_test`). Сквозные: `cd frontend && npm run test:e2e` (логин в `frontend/.env.e2e`).
- `backend` и `migrate` в dev выполняют `prisma generate` при запуске. После смены npm-зависимостей: `docker compose -f docker-compose.dev.yml --env-file .env.dev up -d --build -V backend` (анонимный том `node_modules`).
- Новая миграция — по одной: `... --profile tools run --rm migrate npx prisma migrate dev --create-only --name <что_меняем>`, SQL и «Влияние на данные» в начале файла, затем `... run --rm migrate`. `--create-only` применяет все неприменённые, в том числе пустые (CLAUDE.md, 3.3).
