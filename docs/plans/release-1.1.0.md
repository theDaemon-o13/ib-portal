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
