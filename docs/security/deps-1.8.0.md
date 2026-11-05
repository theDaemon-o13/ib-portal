# Уязвимости зависимостей 1.8.0: разбор и срок

**Составлено 05.11.2026** по `npm audit` lock-файлов `v1.8.0` (`d8613bf`) и ветки `release/1.9.0` после шага 0. Отчёты совпадают: зависимости 1.9.0 (TipTap, `sanitize-html`) новых уязвимостей не добавили. Подробности уязвимостей — из базы GitHub Advisory (`gh api /advisories/<GHSA>`).

**Решение владельца (05.11.2026):** в 1.9.0 не чиним. Обновление — отдельным релизом **1.9.1** сразу после 1.9.0. До тех пор ничего не обновляется.

Оценки CVSS — из базы GitHub. В advisory указан либо CVSS 3.1, либо 4.0, их баллы не сравниваются напрямую. Severity в таблице — как в `npm audit`.

## Сводка

| Группа | Где | В рабочем образе | Применимость у нас | Срок |
|---|---|---|---|---|
| `react-router` — 2 moderate | frontend, production | да: в сборке SPA | не применимо (раздел 1) | 1.9.1 |
| Prisma CLI: `mysql2`, `deepmerge-ts` — 4 high | backend, production | да: образ `ibportal-backend`, сервис `migrate` | не применимо (раздел 2) | 1.9.1 |
| `vitest`, `@vitest/mocker`, `tinypool` — moderate и critical | frontend и backend, dev | нет | только машина разработчика, практически не применимо (раздел 3) | 1.9.1 |
| `minimatch` в `typescript-eslint` — moderate | frontend и backend, dev | нет | не применимо (раздел 3) | исправления от автора пока нет (раздел 4) |

«4 high» в backend — это четыре пакета в отчёте `npm audit` (`prisma`, `@prisma/config`, `deepmerge-ts`, `mysql2`), а не четыре уязвимости. Уязвимостей три: две в `mysql2` и одна в `deepmerge-ts`.

## 1. `react-router` (frontend, production)

Установлено: `react-router-dom` 6.30.6 → `react-router` 6.30.6. Это последняя версия ветки 6: в ней исправления нет, исправлены только версии ветки 7.

| Идентификатор | CVE | CVSS | Суть | Затронуто | Исправлено |
|---|---|---|---|---|---|
| GHSA-wrjc-x8rr-h8h6 | CVE-2026-53669 | 4.0: 5.1, `AV:N/AC:L/AT:N/PR:N/UI:A/VC:N/VI:L/VA:N/SC:L/SI:L/SA:N` | Открытая переадресация: путь с обратной косой чертой, переданный в `<Link>` или `useNavigate`, уводит на внешний адрес. Неполное исправление CVE-2025-68470 | `react-router` ≥ 6.0.0, < 7.18.0 | 7.18.0 |
| GHSA-337j-9hxr-rhxg | CVE-2026-53666 | 3.1: 6.1, `AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N` | Вызов произвольного конструктора через `deserializeErrors()` при гидрации SSR | `react-router` ≥ 6.4.0, < 7.18.0 | 7.18.0 |

**Применимость:**
- **GHSA-337j — не применимо.** У нас декларативный режим: `<BrowserRouter>` в `frontend/src/main.tsx`. Серверного рендеринга и гидрации нет: `createBrowserRouter`, `hydrationData` и `StaticRouter` не используются, `nginx` отдаёт статику. В advisory прямо сказано: «This does not impact your application if you are using Declarative Mode».
- **GHSA-wrjc — не применимо по коду.** Уязвимость срабатывает, только если в навигацию попадает путь, который задал атакующий. У нас таких мест два:
    - **Возврат после входа** (`LoginPage.tsx`, ADR-0023). Путь берётся из `location.state` (состояние истории): ссылкой извне его не задать. Кроме того, он проходит `safeReturnPath` (`frontend/src/nav.ts`), а она отбрасывает пути не с `/`, с `//`, с `\` и с управляющими символами. Эта проверка закрывает именно сценарий advisory.
    - **Переход из уведомления** (`NotificationBell.tsx`, `navigate(n.link)`). Ссылку строит backend из внутренних путей (`/tasks?task=…`, `/documents?doc=…`). Пользовательского ввода в ней нет, а уведомление видит только адресат.
- **Остаточный риск:** низкий. Любой новый `navigate()` с внешними данными до 1.9.1 должен проходить `safeReturnPath`. Это правило ревью.

**Исправление в 1.9.1:** переход на `react-router-dom` 7.18.5 или новее. Это смена основной версии, но API декларативного режима совместим. Требования: React ≥ 18, Node ≥ 20 — у нас React 18.3.1 и Node 24. Нужен полный прогон e2e.

## 2. Prisma CLI: `mysql2` и `deepmerge-ts` (backend, production)

Установлено: `prisma` 7.10.0 → `mysql2` 3.15.3 и `@prisma/config` 7.10.0 → `deepmerge-ts` 7.1.5.

| Идентификатор | CVE | CVSS | Суть | Затронуто | Исправлено |
|---|---|---|---|---|---|
| GHSA-3f6p-5ww8-9rcr | — | 4.0: 8.2, `AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N` | Поддельный **MySQL**-сервер или посредник переключает аутентификацию на `mysql_clear_password` и получает пароль открытым текстом | `mysql2` < 3.22.0 | 3.22.0 |
| GHSA-rgwj-5xj2-c3m3 | — | 3.1: 5.9, `AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H` | Отказ в обслуживании: распаковка без ограничения в сжатом протоколе **MySQL** (`compress: true`) | `mysql2` ≤ 3.23.0 | 3.23.1 |
| GHSA-ggr8-5vv4-36mx | CVE-2026-40345 | 4.0: 8.2, `AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N` | Переполнение стека при слиянии объектов со ссылками на себя | `deepmerge-ts` < 8.0.0 | 8.0.0 |

**Попадает ли в рабочий образ — да.** `prisma` стоит в `dependencies` backend: CLI нужен сервису `migrate` (`npx prisma migrate deploy`). `npm prune --omit=dev` в `backend/Dockerfile` его не удаляет, поэтому `mysql2` и `deepmerge-ts` лежат в `node_modules` образа `ibportal-backend`. Этот же образ запускают сервисы `backend` и `migrate`.

**Доступен ли по сети:**
- `migrate` — разовый запуск (`--profile tools run --rm`) только в сети `back`, а она `internal: true`, без выхода наружу. Портов он не публикует и запросов не принимает: это клиент, который подключается к `db`.
- `backend` CLI Prisma не запускает. Клиент БД — `@prisma/adapter-pg` с драйвером `pg`, а не `mysql2`. Порт наружу публикует только `frontend`.

**Применимость:**
- **`mysql2` (обе) — не применимо.** Код `mysql2` работает, только если Prisma подключается к MySQL. У нас источник данных — `postgresql` (`schema.prisma`, `prisma.config.ts`), поэтому драйвер MySQL не загружается и соединений по протоколу MySQL нет. Обе атаки требуют, чтобы портал подключился к серверу MySQL атакующего.
- **`deepmerge-ts` — не применимо.** `@prisma/config` сливает настройки по умолчанию с `prisma.config.ts`. Этот файл лежит в образе, атакующий его не задаёт, рекурсивных объектов в нём нет. Внешние данные в `deepmerge` не попадают.
- **Остаточный риск:** нет пути эксплуатации. Пакеты остаются в образе, их видит сканер образов банка, поэтому исправление нужно, даже если уязвимость не эксплуатируется.

**Исправление в 1.9.1:** `prisma`, `@prisma/client` и `@prisma/adapter-pg` 7.10.1 (вышли 15.10.2026, тип изменения — patch). В них `mysql2` 3.24.4 и `deepmerge-ts` 8.0.2. Это тот самый пункт «Запланировано» в `CHANGELOG.md`. Нужны `prisma generate`, полный `test:db`, `check:schema` и репетиция `migrate`.

## 3. Инструменты разработки (dev): `vitest`, `@vitest/mocker`, `tinypool`, `minimatch`

Установлено в frontend и backend: `vitest` 3.2.7 → `@vitest/mocker` 3.2.7 и `tinypool` 1.1.1. `typescript-eslint` 8.43.0 → `@typescript-eslint/typescript-estree` → `minimatch` 10.x.

| Идентификатор | CVE | CVSS | Суть | Затронуто | Исправлено |
|---|---|---|---|---|---|
| GHSA-5gmw-xhrv-c9v3 | CVE-2026-104848 | 4.0: 9.5 (critical), `AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H` | Если `Object.prototype` уже загрязнён, `tinypool` передаёт `execArgv` и `env` в `Worker`: исполнение кода | `tinypool` ≤ 2.1.0 | 2.1.1 |
| GHSA-85c8-ppgw-ccpr | CVE-2026-104849 | 4.0: 9.5 (critical), тот же вектор | То же через `filename` в `pool.run(task, options)` | `tinypool` < 2.1.2 | 2.1.2 |
| GHSA-82fw-gwwq-j7x9 | CVE-2026-84373 | 3.1: 5.9, `AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N` | Чтение файлов через подмену модуля на WebSocket dev-сервера Vite (`interceptorPlugin`) | `vitest` и `@vitest/mocker` ≥ 2.1.0, < 4.1.11 | 4.1.11 |
| GHSA-qxg6-89mg-rqv8 | CVE-2026-112949 | 3.1: 4.7, `AV:N/AC:H/PR:N/UI:R/S:C/C:L/I:L/A:N` | Подмена модуля произвольным JS через тот же WebSocket, ветка `manual` | `@vitest/mocker` ≥ 2.1.0-beta.7, < 4.1.12 | 4.1.12 |
| GHSA-g3hv-75wg-m249 | CVE-2026-118764 | 4.0: 6.9 | Отказ в обслуживании: взрывной рост шаблонов glob | `minimatch` ≥ 7.0.0, < 11.0.1 | 11.0.1 |

**Попадает ли в рабочий образ — нет:**
- **frontend:** стадия `runtime` — это `nginx` и только `/app/dist`. `node_modules` стадии `build` в образ не копируются, а `vitest` в сборку SPA не входит.
- **backend:** `npm prune --omit=dev` удаляет `vitest`, `tinypool` и `typescript-eslint` до копирования `node_modules` в `runtime`.

На сервере этих пакетов нет. Они есть только на машине разработчика и в dev-контейнерах.

**Применимость:**
- **`tinypool` (critical) — практически не применимо.** Для эксплуатации нужно, чтобы `Object.prototype` уже был загрязнён внутри процесса тестов. В тестах работает только наш код и наши фикстуры, внешних данных в них нет: файлы для импорта генерирует код тестов. Это «гаджет», а не самостоятельная уязвимость, отсюда `AT:P` в векторе.
- **`@vitest/mocker` (оба) — не применимо.** Путь атаки — WebSocket dev-сервера Vite с `mockerPlugin` или `interceptorPlugin`. Тесты у нас идут в `environment: 'node'` (`frontend/vite.config.ts`), browser mode не используется, а этих плагинов в `vite.config.ts` нет. Dev-сервер Vite и так публикуется только на `127.0.0.1:5173` (`deploy/docker-compose.dev.yml`).
- **`minimatch` — не применимо.** Шаблоны glob для `typescript-eslint` задаёт наш конфиг ESLint, а не внешний ввод.

**Исправление в 1.9.1:** `vitest` 4.1.12 или новее. В 4.1.12 `@vitest/mocker` уже 4.1.12, а `tinypool` больше не зависимость. `vitest` 5.1.0 требует Node ≥ 22.12, у нас Node 24, но это лишняя смена основной версии. Смена 3 → 4 — major: нужно проверить конфиг и полный прогон тестов в обоих пакетах.

## 4. `minimatch` в `typescript-eslint`: исправления от автора нет

Последний `typescript-eslint` на 05.11.2026 — 8.72.1, у его `typescript-estree` зависимость `minimatch ^10.2.2`. Это всё ещё затронутый диапазон. `npm audit` предлагает «исправление» откатом на 8.36.0, но это откат, а не исправление. Варианты для 1.9.1:
- ждать выпуска `typescript-eslint` с `minimatch` ≥ 11.0.1;
- или поставить `overrides` на `minimatch` 11.0.1, если ESLint с ней работает. Это проверяется прогоном `lint`.

Пакет только для разработки, в образ не попадает. Если к 1.9.1 исправления нет — переносим с отметкой в этом документе.

## 5. План 1.9.1 (только зависимости)

1. `prisma`, `@prisma/client`, `@prisma/adapter-pg` → 7.10.1.
2. `react-router-dom` → 7.18.x не моложе двух недель на момент обновления.
3. `vitest` → 4.1.12 или новее в ветке 4.
4. `minimatch` — по разделу 4.

Порядок:
- каждое обновление — отдельный коммит, точные версии, lock-файлы;
- `npm audit` до и после, сведённый в этот документ;
- полный прогон typecheck, lint, test, test:db, e2e, check:schema, check:integrity;
- репетиция выкладки на копии 1.9.0.

Миграций нет. Откат на 1.9.0 — только код.
