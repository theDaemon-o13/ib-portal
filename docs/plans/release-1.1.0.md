# Релиз 1.1.0 — задание, утверждённый план этапа А, ответы

Этот файл — источник плана релиза 1.1.0. План составлен 28.10.2026 в сессии Claude Code на другом компьютере (Windows/WSL) и утверждён владельцем проекта с ответами из раздела 3. Работай по нему и по CLAUDE.md. Если план расходится с кодом — остановись и спроси.

Состояние на момент переноса:
- Последний коммит в origin/main — d34500c (RELEASE.md 1.0.1). Ни одна задача этапа А не начата.
- На Windows-ноутбуке готовился .gitattributes (`*.sh text eol=lf`, `Dockerfile text eol=lf`); все 12 подходящих файлов уже в LF. Если после git pull файла нет — добавь отдельным коммитом `chore: .gitattributes — eol=lf для *.sh и Dockerfile`.
- Какой e2e-тест нестабилен, в плане не записано. Найди сам: прогони e2e 3–5 раз, назови тест и причину, исправь отдельным коммитом до задачи 3.
- Файл с планом закоммить в docs/plans/release-1.1.0.md первым коммитом, чтобы он был доступен с любого компьютера. Планы этапов Б и В дописывай в этот же файл после моего «ок».

---

## 1. Задание (промпт владельца)

Нужно доработать портал: 7 задач ниже. Всё выходит одним релизом 1.1.0 (сейчас 1.0.1). Работай по CLAUDE.md. Сначала план, код только после моего «ок».

### Порядок
- Этап А: задачи 1, 2, 3, 7. Этап Б: задача 4. Этап В: задачи 5, 6.
- Перед этапами Б и В присылай подробный план и жди «ок».
- Релиз 1.1.0 собирается один раз, после всех трёх этапов.

### Общие правила
- В плане: что меняется, в какой зоне, нужна ли миграция. Для каждой миграции — SQL и строка «Влияние на данные». Миграции только «расширить → перенести → сузить», совместимые с backend 1.0.1.
- Спроси меня, прежде чем: менять коды прав RBAC, добавлять зависимости, трогать compose, тома, сети и формат хранения файлов.
- Массовые удаления и архивирование: право проверяется на backend; сначала предпросмотр («будет затронуто N»), потом подтверждение; обработка пакетами в транзакциях; запись в audit_log (кто, что, сколько, id в diff). Записи с зависимостями — только архив (раздел 3.4). Ничего из раздела 3.1 не делай.
- Backend с обратной совместимостью, потом перегенерация типов OpenAPI, потом frontend. Один коммит на задачу.
- Тесты vitest на каждое новое правило. После каждой задачи: typecheck, lint, test, test:db, check:integrity, e2e по затронутому.
- Обнови docs/concept.md и CHANGELOG.md («Не выпущено»), архитектурные решения оформи как ADR. Деплой не делай.

### Git и передача
- Перед началом git pull. Ветка main; после каждой задачи коммит и git push в origin.
- В конце: VERSION = 1.1.0, раздел 1.1.0 в CHANGELOG (у каждой миграции «Влияние на данные»), тег v1.1.0 с push, сборка make-release.sh (архив образов, .sha256, RELEASE.md в dist/). Проверь установку с нуля и обновление 1.0.1 → 1.1.0 на чистых стендах, как для 1.0.1. В docs/runbook/deploy.md вместо жёсткого 1.0.0 в примерах — <версия>.
- Дополнительно dist/changes-1.1.0/: CHANGED-FILES.txt (git diff --name-status v1.0.1..v1.1.0), копии изменённых файлов с сохранением путей и zip. В README папки: «Для просмотра. На сервер ставится только архив релиза».
- .env, сертификаты и секреты не попадают ни в git, ни в эти папки.

### Задача 1. Массовое удаление записей реестра
- В таблице реестра чекбоксы, «выбрать все на странице», «выбрать все N по фильтру». Действия «Архивировать выбранные», «Удалить выбранные».
- В настройках реестра «Удалить все записи»: показать число записей, подтвердить вводом названия реестра.
- Право records.delete. Записи с зависимостями архивируются; в итоге показать, сколько удалено и сколько архивировано.
- В реестре кнопка «Архив» с возвратом записей (если её ещё нет).

### Задача 2. Автоматизации и их результаты
- Автоматизация DLP создала около 430 задач; её архивация их не убрала.
- Связь задач с автоматизацией; способ привязать уже созданные — только после предпросмотра и подтверждения.
- Удаление автоматизации — диалог «Задачи, созданные ею (N): оставить / архивировать / удалить», по умолчанию «оставить». Разбивка по статусам. Опция «только нетронутые».
- Журнал запусков автоматизации: просмотр и очистка.
- На доске задач выбор нескольких задач: «Архивировать выбранные», «Удалить выбранные» (tasks.delete). Фильтр «создано автоматизацией X».

### Задача 3. Пароль при входе
- Кнопка «показать/скрыть пароль» на входе, при смене пароля и при создании пользователя.
- Сохранение пароля — только средствами браузера (autocomplete). Пароль не хранить в localStorage, cookie, БД и логах. Можно запоминать только логин по галочке «Запомнить логин».
- Пароль не попадает в логи, аудит и тексты ошибок.

### Задача 4. Сравнение выгрузки с реестром (этап Б)
- При импорте после предпросмотра кнопка «Сравнить с реестром». Группы: новые, изменившиеся, без изменений, отсутствуют в файле.
- Ключ сопоставления для каждого реестра (одно или несколько полей); по умолчанию ID; для уязвимостей «CVE + пакет».
- Обязательная область сравнения (поле «Система» или отчёт сканера).
- Действия над отсутствующими: сменить значение поля-списка, архивировать, оставить; ко всем или к выбранным; предпросмотр, подтверждение, аудит. Автоматически ничего не применяется.
- Вычисляемые поля и решения ОУР не перезаписываются. Результат сравнения выгружается в Excel. Без кода под конкретный реестр.

### Задача 5. Дашборд: управление плитками (этап В)
- Режим «Настроить»: показать/скрыть, перетащить, размер, «Сбросить». Раскладка у каждого пользователя в БД; localStorage только кэш. Недоступные по правам плитки не показываются. Раскладка по умолчанию для роли — предложить в плане, новые права без согласования не заводить.

### Задача 6. Мониторинг: настройка данных (этап В)
- Настройка слайдов: какие, порядок, время показа (12 с), фильтры. Источники: уязвимости, задачи, документы (сроки актуальности и пересмотра), по возможности DLP. Настройки в БД, правка по settings.manage, киоск только читает. MONITOR_ALLOWED_IPS не ослаблять.

### Задача 7. Большие текстовые поля
- Признак «Многострочный текст» в конструкторе; в карточке от 6 строк, растягивается. Лимиты zod/БД/Excel/таблица. Включить у «Комментарий» и «Компенсирующие меры» без потери данных.

---

## 2. Утверждённый план (краткий по всем задачам и подробный по этапу А)

```
What the code showed (this affects the plan)

- Task 2: the link between tasks and their automation already exists. It's the
  column tasks.automation_id (since migration 20261027043258_tasks, before 1.0.0),
  filled in by from-events.ts. There is also the table automation_event_tasks. So
  no new column is needed, only an index.
  - Archiving an automation doesn't touch its tasks; that's by design.
  - Deleting an automation is currently forbidden if it has events.
  - Runs are not recorded anywhere: there is no run log.
- Task 1: there is already single-record archive, restore and delete, plus an
  «включая архив» checkbox.
  - Archive requires records.edit; delete requires records.delete.
  - Today these block deletion: locked fields, decisions of another department,
    evidence.
- Task 3: login and password change already have the correct autocomplete. When a
  user is created, the admin doesn't type a password: the portal generates a
  temporary one and shows it openly in TemporaryPasswordDialog.
- Task 4: there is already a single-field import key
  (register_fields.is_import_key) with a «нет в файле» mark. Task 4 extends this
  mechanism rather than writing a new one.
- Task 7: fields already store settings in register_fields.settings (jsonb). The
  multiline flag fits there without a migration. The text limit is TEXT_MAX = 4000
  for every text field.

Short plan for all tasks

┌─────┬───────┬───────────────────────┬───────────────────────────────────────┐
│  #  │ Stage │         Zones         │               Migration               │
├─────┼───────┼───────────────────────┼───────────────────────────────────────┤
│ 1   │ А     │ backend + frontend    │ none                                  │
├─────┼───────┼───────────────────────┼───────────────────────────────────────┤
│ 2   │ А     │ backend + frontend    │ index on tasks(automation_id) + table │
│     │       │                       │  automation_runs                      │
├─────┼───────┼───────────────────────┼───────────────────────────────────────┤
│     │       │ frontend; backend:    │                                       │
│ 3   │ А     │ tests and log         │ none                                  │
│     │       │ redaction             │                                       │
├─────┼───────┼───────────────────────┼───────────────────────────────────────┤
│ 7   │ А     │ backend + frontend +  │ none (jsonb + idempotent seed)        │
│     │       │ seed                  │                                       │
├─────┼───────┼───────────────────────┼───────────────────────────────────────┤
│ 4   │ Б     │ backend + frontend    │ composite key and comparison scope:   │
│     │       │                       │ new columns/table (expand)            │
├─────┼───────┼───────────────────────┼───────────────────────────────────────┤
│ 5   │ В     │ backend + frontend    │ table dashboard_layouts               │
├─────┼───────┼───────────────────────┼───────────────────────────────────────┤
│ 6   │ В     │ backend + frontend    │ table monitor_slides or a key in      │
│     │       │                       │ app_settings (I'll choose in plan В)  │
└─────┴───────┴───────────────────────┴───────────────────────────────────────┘

- Task 4: the comparison key becomes a list of fields in the constructor. Existing
  is_import_key values are carried over to it, and the old column stays until a
  later release.
  - The comparison scope (a list field / scanner report) is required.
  - Actions on missing records run through preview, confirmation and audit.
  - The comparison result can be exported to Excel.
- Task 5: layout per user in the DB, with only a cache in localStorage. Tiles are
  filtered by the user's permissions on the backend.
- Task 6: slide settings in the DB, editing under settings.manage; the kiosk only
  reads them. Sources: vulnerabilities, tasks, documents, DLP devices. I'll list
  the slides in plan В.

Detailed plan for stage A

Commit order: flaky e2e fix → 3 → 7 → 1 → 2. Each task is one commit with a push,
after typecheck, lint, test, test:db, check:integrity and e2e for what it touches.

Task 3. Password at login (no migration)

- Frontend:
  - A PasswordInput component with a show/hide button (an aria-pressed toggle). It
    is used at login and in all three fields of the password change form.
  - In the temporary password dialog, the password is hidden by default, with
    «показать» and «скопировать».
  - A «Запомнить логин» checkbox: only the login goes into localStorage, in a
    try/catch.
  - I'll check that the password isn't put into query strings or React state
    outside the form.
- Backend:
  - Pino redaction also covers req.body.password, currentPassword, newPassword and
    temporaryPassword.
  - vitest: a failed login and a password change don't write the password to
    audit_log, error text or logs; zod errors don't echo the value.
- e2e: the toggle switches type, and «Запомнить логин» saves only the login.

Task 7. Long text fields (no schema migration)

- lib/field-settings.ts: a new text: { multiline: true } setting for text fields,
  plus a checkbox in the field constructor.
- In the record card, a textarea of at least 6 lines that grows with the text and
  can be resized by hand.
- Limits:
  - zod and register-values.ts stay at 4000 for all fields, or the limit goes up
    for multiline fields (question 6).
  - The DB has no limit (jsonb).
  - Excel: the cell limit is 32 767; on import, length is checked with the same
    function as in the form.
  - In the table, text is cut to a single line with ellipsis, and the full text
    shows in a title tooltip.
- Enabling the flag on existing fields: an idempotent seed step with a mark in
  seed_markers.
  - It sets settings.text.multiline = true on the vulnerability register fields
    with keys comment («Комментарий ДИКТ») and measures («Компенсирующие меры»),
    found by system key, not by label.
  - It writes one audit entry per field.
  - Data impact: settings changes in 2 rows of register_fields; record values
    aren't touched. Reversible by unticking the flag.

Task 1. Bulk deletion of register records (no migration)

- Backend (records.service.ts, routes.ts):
  - POST /registers/:id/records/bulk/preview. Body: { action:
    archive|restore|delete, selection: { ids } | { filter: <the same query as the
    list>, excludeIds? } }.
  - Preview response: { total, willDelete, willArchive, byReason: { locked,
    decisions, evidence }, alreadyInState }.
  - POST …/bulk/apply: the same body plus expected: { total, willDelete,
    willArchive }. The server recomputes the selection; if the numbers don't
    match, it returns 409 and applies nothing.
  - Processing runs in batches of 200 records, one transaction per batch. Each
    record gets its own audit entry, so the card history works.
  - Plus one summary entry register_records.bulk_* with diff: { count, deletedIds,
    archivedIds, reasons, filter }.
  - Response: { deleted, archived, skipped }.
  - The dependency check is moved out of deleteRecord into one function, so single
    and bulk deletion follow the same rule.
  - POST /registers/:id/records/delete-all/preview|apply: apply takes confirmName,
    which the server compares with the register name, plus expected. Right:
    records.delete.
  - GET /registers/:id/records gets an optional archived=only parameter; the old
    includeArchived keeps working.
- Frontend:
  - Checkboxes in the table, «выбрать все на странице», and «выбрать все N по
    фильтру» as a selection by filter, not a list of ids.
  - A panel with «Архивировать выбранные», «Удалить выбранные», and «Вернуть
    выбранные» in the archive view.
  - An «Архив» button in the register bar.
  - In the register settings, «Удалить все записи»: shows the count, and you
    confirm by typing the register name.
  - A result summary: «Удалено N, в архив M (есть решения: …)».
- Tests: vitest for selection by ids and by filter, the dependency split, 409 when
  data changes, name confirmation, permissions, audit. e2e for selection and
  deletion.

Task 2. Automations and their results

- Migration 1 tasks_automation_index:
-- Влияние на данные: строки не меняются; создаётся индекс по
tasks(automation_id). Откат: DROP INDEX.
CREATE INDEX "tasks_automation_id_idx" ON "tasks"("automation_id");
  On a large table I'd normally use CONCURRENTLY, but Prisma runs each migration
  in a transaction. With hundreds or thousands of tasks, a plain index takes
  fractions of a second.
- Migration 2 automation_runs (separately, after migration 1 is checked):
-- Влияние на данные: новая пустая таблица, существующие строки не меняются.
Откат: backend 1.0.1 её не читает.
CREATE TABLE "automation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "register_id" uuid REFERENCES "registers"("id") ON DELETE RESTRICT,   -- NULL:
hourly run over all registers
  "trigger" text NOT NULL,                                              --
schedule | manual | import
  "actor_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
  "started_at" timestamptz(3) NOT NULL DEFAULT now(),
  "finished_at" timestamptz(3),
  "rules" int NOT NULL DEFAULT 0, "checked" int NOT NULL DEFAULT 0,
  "events_created" int NOT NULL DEFAULT 0, "tasks_created" int NOT NULL DEFAULT 0,
"tasks_commented" int NOT NULL DEFAULT 0,
  "error" text
);
CREATE INDEX "automation_runs_register_id_started_at_idx" ON
"automation_runs"("register_id", "started_at" DESC);
- Linking existing tasks:
  - In the code, every automation task gets automation_id filled in, so there
    should be nothing to link.
  - Please check this on prod with the read-only query below and send me the
    result.
SELECT count(*) AS total, count(*) FILTER (WHERE automation_id IS NULL) AS
unlinked FROM tasks WHERE source = 'automation';
SELECT a.id, r.name, count(*) FROM tasks t JOIN register_automations a ON a.id =
t.automation_id JOIN registers r ON r.id = a.register_id WHERE t.deleted_at IS
NULL GROUP BY 1, 2 ORDER BY 3 DESC;
  - If unlinked > 0, I'll add «Задачи без привязки (N)»: a list preview showing
    the source through automation_event_tasks → automation_events.automation_id,
    applied only after confirmation, with audit.
- Deleting or archiving an automation:
  - POST /register-automations/:id/tasks/preview returns N, a breakdown by status,
    and how many are untouched.
  - «Untouched» means: no comments from people (automation comments don't count),
    and no audit entries for the task other than creation.
  - Dialog «Задачи, созданные ею (N): оставить / архивировать / удалить», with
    «оставить» as the default and a «только нетронутые» checkbox.
  - Deleting tasks requires tasks.delete and is soft. Batches, audit and the 409
    check work as in task 1.
  - Deleting a rule that has events becomes soft (deleted_at) instead of being
    forbidden. Events and tasks keep their links, and the system rules still can't
    be deleted.
- Run log:
  - runAutomations writes a row to automation_runs.
  - An «Журнал запусков» tab in the register automations, with pagination.
  - «Очистить» removes the run log rows (records older than a date / all) and
    writes an audit entry with the count.
  - Automation events are not cleared: the unique key (automation_id, record_id,
    trigger_key) protects against repeated tasks.
- Task board:
  - Multi-select with «Архивировать выбранные» (ib.work) and «Удалить выбранные»
    (tasks.delete), through preview, batches and audit.
  - An «Создано автоматизацией» filter: an optional automationId parameter on GET
    /tasks.

Documentation: concept.md (registers, tasks, automations, login), CHANGELOG.md «Не
выпущено», and an ADR on bulk operations (preview, expected, 409, batches,
audit).

Questions

1. Bulk archiving: which permission? A single record is archived with
   records.edit. I suggest the same right for bulk archiving, and records.delete
   for «Удалить выбранные» and «Удалить все». Or should everything bulk require
   records.delete?
2. «Удалить все записи»: include archived records? I suggest yes: all records that
   aren't deleted.
3. What counts as a record dependency? Today: locked fields, decisions, evidence.
   Should open tasks for the record and links from other records also count? I
   suggest adding open tasks too, in both single and bulk deletion.
4. Clearing the run log: is physical deletion of the log rows acceptable? It's a
   technical log, not a business entity, and an audit entry is kept. Which right
   should it need: registers.manage?
5. Deleting an automation that has events: can it become soft (deleted_at) instead
   of being forbidden?
6. Multiline text limit: raise it to 20 000 characters, or keep 4000 like
   everything else? Should I also turn on the flag for other text fields with
   these names in user-created registers, or only the two vulnerability fields?
7. Prod check: please run the two read-only queries from task 2 on prod and send
   me the numbers.
8. Flaky e2e: OK to fix it with a separate commit before task 3?

One more note: the plan says docs/deploy.md, but the file is
docs/runbook/deploy.md. I'll fix the version examples there.```

---

## 3. Ответы владельца на вопросы плана

1. Массовое архивирование — records.edit; «Удалить выбранные» и «Удалить все» — records.delete.
2. «Удалить все» включает архивные записи (все, кроме уже удалённых).
3. Зависимости записи: открытые задачи по записи и ссылки из других записей (например, разрешения DLP → устройство) — в одиночном и массовом удалении одинаково. В итоговом диалоге показывать, сколько записей ушло в архив из-за задач и из-за ссылок, и подсказку «Сначала закройте или удалите задачи».
4. Журнал запусков — технический: физическое удаление строк допустимо с записью в аудит. Право registers.manage. Варианты «старше N дней» и «всё».
5. Удаление автоматизации с событиями — мягкое (deleted_at); системные правила по-прежнему не удаляются.
6. Лимит 20 000 для многострочных полей, 4000 для остальных текстовых. Флаг автоматически включить только у двух полей реестра уязвимостей; в остальных реестрах владелец включит его сам.
7. Доступа к проду сейчас нет, запросы не выполнены. Блок «Задачи без привязки (N)» делать в любом случае; если таких 0 — блок не показывается.
8. Исправление нестабильного e2e — отдельным коммитом перед задачей 3.

Путь к инструкции выкладки — docs/runbook/deploy.md.

План этапа А утверждён. Порядок коммитов: docs/plans/release-1.1.0.md → (.gitattributes, если нужно) → нестабильный e2e → 3 → 7 → 1 → 2.


---

## 4. Итоги этапа А (29.10.2026)

Коммиты в origin/main: `f3c6d90` (нестабильный e2e: дата в часовом поясе банка), `ed8c471` (задача 3), `6c9356a` (задача 7), `e75e843` (задача 1), `2dcd4d7` (задача 2), `bd12ed7` (убран блок «Задачи без привязки» — недостижим из-за `tasks_automation_check`), `9d8a2d3` (документация о более строгом удалении). Принятые владельцем отклонения от плана: маршруты массовых действий разделены по праву (`bulk-archive`, `bulk-delete`, `delete-all`, ADR-0016); кнопка «Архив» — над таблицей записей; «Удалить все записи…» — в меню реестра, которое открывается и с `records.delete`; снять «Многострочный текст» нельзя, пока есть значения длиннее 4000.

---

## 5. План этапа Б — задача 4 «Сравнение выгрузки с реестром» (на согласовании)

### Что показал код

- Импорт Excel уже двухшаговый: `previewImport` разбирает файл (`parseCell`, `sameValue`, ключ по колонке ID или по полю-ключу импорта), сохраняет предпросмотр в `register_imports` (summary + payload, срок 30 минут), `applyImport` применяет одной транзакцией.
- Ключ импорта — **одно** поле (`register_fields.is_import_key`), значение нормализуется функцией БД `register_import_key()` (регистр, пробелы), хранится в `register_records.import_key` (триггер) и **уникально** среди неудалённых записей реестра. По ключу уже считается список «Нет в файле» (действующие незакрытые записи, максимум 2000 в предпросмотре), но действий над ними нет.
- В реестре уязвимостей дубли «CVE + пакет» уникальны только среди **открытых** записей (закрытые с той же парой бывают). Поэтому составной ключ сравнения не может быть уникальным, как ключ импорта, и не может жить в `import_key`.
- «Отчёт сканирования» — поле-список реестра уязвимостей (значение на каждый загруженный отчёт), «Система» — поле «Значение справочника». Оба подходят как область сравнения без кода под конкретный реестр.

**Уточнение к краткому плану этапа А:** там было «is_import_key переносится в ключ сравнения, старая колонка уходит в следующем релизе». Это разные понятия: ключ импорта уникален и нужен импорту без колонки ID (выгрузка Device Monitor), ключ сравнения может быть составным и неуникальным. Предлагаю `is_import_key` не сужать и не удалять, а только взять его как ключ сравнения по умолчанию.

### Зоны и миграции

backend + frontend + seed. Две миграции, по одной, совместимые с backend 1.0.1 (он новых колонок и таблицы не читает).

**Миграция 1 `register_compare_settings`** — настройки сравнения в реестре (расширить + перенести):

```sql
-- Влияние на данные: две новые колонки в registers со значением '{}' (PostgreSQL 16 добавляет их без
-- перезаписи таблицы); затем UPDATE заполняет ключ сравнения у реестров, где задан ключ импорта —
-- по одной строке registers на такой реестр (на dev — 1: «Устройства DLP»). Значения записей не меняются.
-- Откат: backend 1.0.1 колонки не читает; откатывать базу не нужно.
ALTER TABLE "registers"
  ADD COLUMN "compare_key_field_ids"   uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN "compare_scope_field_ids" uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE "registers" ADD CONSTRAINT "registers_compare_key_check"
  CHECK (cardinality("compare_key_field_ids") <= 3 AND cardinality("compare_scope_field_ids") <= 5);
UPDATE "registers" r SET "compare_key_field_ids" = ARRAY[f."id"]
FROM "register_fields" f
WHERE f."register_id" = r."id" AND f."is_import_key" AND f."deleted_at" IS NULL;
```

Пустой ключ = сравнение по колонке ID (поведение по умолчанию). Реестр уязвимостей получает ключ «CVE / БДУ + Пакет» и области «Система», «Отчёт сканирования» однократным шагом seed (`seed_markers`, поля по системному ключу, запись в журнале аудита) — как многострочные поля в задаче 7.

**Миграция 2 `register_compares`** — результат сравнения (как `register_imports`, отдельной таблицей: у сравнения нет «применить всё», над ним выполняются отдельные действия):

```sql
-- Влияние на данные: новая пустая таблица, существующие строки не меняются. Откат: backend 1.0.1 её не читает.
CREATE TABLE "register_compares" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "register_id"   uuid NOT NULL REFERENCES "registers"("id") ON DELETE RESTRICT,
  "import_id"     uuid REFERENCES "register_imports"("id") ON DELETE RESTRICT,  -- предпросмотр, из которого запущено
  "file_name"     text NOT NULL,
  "file_sha256"   text NOT NULL,
  "key_field_ids" uuid[] NOT NULL,          -- пусто — по ID
  "scope"         jsonb NOT NULL,           -- { fieldId, values[] }
  "summary"       jsonb NOT NULL,           -- числа по группам, изменения по полям
  "payload"       jsonb NOT NULL,           -- строки групп: номера строк файла, id записей, было/стало
  "created_by"    uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at"    timestamptz(3) NOT NULL DEFAULT now(),
  "expires_at"    timestamptz(3) NOT NULL
);
CREATE INDEX "register_compares_register_id_created_at_idx" ON "register_compares"("register_id", "created_at");
```

Строки `register_compares`, как и `register_imports`, не удаляются (данные о том, кто и что сравнивал); действия над результатом доступны до `expires_at` (2 часа), выгрузка в Excel — всегда.

### Backend (`modules/registers/compare.service.ts`, маршруты в `routes.ts`)

1. **Разбор строк файла — общий с импортом.** Из `previewImport` выносится функция чтения строк (колонки, `parseCell`, ошибки по строкам), без изменения поведения импорта — его покрывают существующие тесты `excel.db.test.ts`. Сравнение использует её же: значения в файле читаются так же, как при импорте.
2. **Настройки:** `PATCH /registers/:id` принимает `compareKeyFieldIds` (до 3 полей: текст, число, дата, список, справочник, сотрудник) и `compareScopeFieldIds` (до 5 полей: список или справочник). Право `registers.manage`, `version`, журнал. Поле из настроек нельзя отправить в архив, удалить или сменить его тип — «сначала уберите его из сравнения» (как у ключа импорта).
3. **Сравнение:** `POST /register-imports/:id/compare` (multipart: тот же файл + `key: 'id' | 'fields'`, `scope: { fieldId, values[] }`). Сервер сверяет sha256 файла с предпросмотром импорта, область обязательна (не выбрана — 400). Ключ записи и строки файла — части по полям ключа; текст нормализуется той же функцией БД `register_import_key()`, список, справочник и сотрудник — по id значения, число и дата — в каноническом виде. Группы:
   - **новые** — ключа нет среди записей области (если есть вне области — пометка «есть в реестре вне области»);
   - **изменились** — найдена одна запись, отличается хотя бы одно вводимое поле: поле, было → стало. Вычисляемые поля, решения другого отдела, файлы и связи не сравниваются и не перезаписываются;
   - **без изменений**;
   - **отсутствуют в файле** — записи области, не в архиве и не закрытые (как сейчас «Нет в файле»), которых нет в файле;
   - **ошибки** — пустой ключ, повтор ключа в файле, ключ совпал с несколькими записями (неоднозначно), ошибка разбора ячейки; строки файла с другим значением поля области — «вне области», не сравниваются.
   Результат сохраняется в `register_compares`, в журнал — запись «сравнение: новые N, изменились M, …». **Ничего в записях не меняется.**
4. **Действия над отсутствующими:** `POST /register-compares/:id/missing/preview` и `…/missing/apply` — `{ action: 'set' | 'archive', fieldId?, optionId?, reason?, ids? }` (без `ids` — ко всем отсутствующим). «Оставить» — это просто не выполнять действие. Предпросмотр: сколько изменится, сколько пропущено и почему (зафиксировано статусом, уже это значение, запись изменилась или удалена после сравнения). Применение — по `expected` (разошлось — 409 `BULK_CHANGED`), пакетами по 200, через обычную правку записи (`updateRecord` / архив): срабатывают пересчёт вычисляемых полей, правила фиксации, история карточки (`via: 'compare'`), плюс сводная запись журнала. Поле «с причиной» — с одной причиной на всех (поле `reason` обязательно, если такие поля затронуты). Право — `records.edit`.
5. **Excel:** `GET /register-compares/:id/export` — листы «Параметры» (файл, sha256, ключ, область, кто и когда), «Новые», «Изменились» (запись, поле, было, стало), «Без изменений», «Нет в файле», «Ошибки». Право `records.edit`.

### Frontend

- **Конструктор, вкладка «Поля»:** блок «Сравнение с выгрузкой» — ключ (до трёх полей по порядку, по умолчанию «ID») и поля, по которым выбирается область. Право `registers.manage`.
- **Окно импорта:** после предпросмотра — кнопка «Сравнить с реестром». Выбор ключа (ID, если колонка есть в файле, или ключ реестра, если есть его колонки) и области (поле и значения, обязательно). Результат — группы с числами; «Изменились» — по полям с «было → стало»; «Отсутствуют в файле» — список с галочками и панелью «Сменить значение поля… / Архивировать», предпросмотр → подтверждение → итог. Кнопка «Выгрузить в Excel». Применение самого импорта остаётся отдельной кнопкой, как сейчас.

### Тесты

- vitest: группировка (чистая функция: ключи, область, неоднозначность, повторы, «вне области»), составной ключ.
- test:db: нормализация ключа функцией БД; перенос ключа импорта в ключ сравнения (миграция) и seed реестра уязвимостей; сравнение «CVE + пакет» в области отчёта; вычисляемые поля и решения не сравниваются; действия: смена значения с пропуском зафиксированных и причиной, архив, 409, журнал; права по HTTP; книга Excel (листы и строки).
- e2e: реестр уязвимостей — выгрузить, в файле изменить строку, удалить строку, добавить строку → «Сравнить с реестром» с областью → числа групп → отсутствующей записи сменить «Статус» → выгрузить результат.
- Проверки после задачи: typecheck, lint, test, test:db, `prisma migrate dev` + `check:schema`, `check:integrity`, e2e.

### Документация

ADR-0017 (сравнение: ключ отдельно от ключа импорта, обязательная область, ничего автоматически, действия по ADR-0016), `docs/concept.md`, `docs/user-guide.md`, CHANGELOG «Не выпущено» с «Влиянием на данные» обеих миграций и шага seed.

### Порядок коммитов

1. `refactor`: общий разбор строк файла для импорта и сравнения — без изменения поведения (все тесты импорта зелёные до и после).
2. Задача 4 — один коммит: миграции 1 и 2 (созданы по одной), seed, backend, перегенерация типов, frontend, тесты, документация.

### Вопросы

1. «Отсутствуют в файле» — только записи не в архиве и не закрытые (как нынешнее «Нет в файле»)? Предлагаю так: закрытые записи обычно и не должны быть в выгрузке.
2. Ключ при сравнении выбирается в окне: «ID» или ключ реестра — согласны? По умолчанию ID, если колонка ID есть в файле.
3. Область: одно поле и одно или несколько значений, обязательно. Строки файла с другим значением этого поля — «вне области» и не сравниваются. Согласны?
4. «Сменить значение поля» для отсутствующих — любое поле-список или справочник реестра (не только статус)? Для поля «с причиной» — одна причина на все записи?
5. Право на сравнение, действия и выгрузку результата — `records.edit`? Новых прав не заводим.
6. `is_import_key` не сужаем и не удаляем (см. «Уточнение» выше) — согласны?
7. Предварительный `refactor`-коммит отдельно от задачи 4 — согласны?
