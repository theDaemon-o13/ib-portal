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
  is_import_key values are carried over to it as the default comparison key.
  [Исправлено 29.10.2026, см. раздел 5: is_import_key остаётся навсегда — ключ
  импорта уникален, ключ сравнения («CVE + пакет») — нет; это разные понятия.]
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

## 5. План этапа Б — задача 4 «Сравнение с реестром» (упрощён 29.10.2026, на согласовании)

История: подробный план с группами «новые / изменились / без изменений», таблицей `register_compares` и выгрузкой в Excel утверждён 29.10.2026 (коммит `dea84ce`), затем владелец упростил этап до минимума. Ниже — действующая версия; прежняя — в истории git.

### Что изменилось относительно утверждённого плана

| Было | Стало |
|---|---|
| Группы «новые», «изменились», «без изменений», «ошибки» | Только **«Нет в файле»**: открытые записи области, которых нет в файле. Новые и изменённые строки показывает обычный предпросмотр импорта |
| Подгруппа «хост не сканировался» по записи | **Предупреждение «неполный скан»** на весь результат (связи «уязвимость → хост» в данных нет) |
| Действия: сменить любое поле-список, заполнить дату, архивировать | Только **статус**: свой у каждой записи или один у выбранных |
| Таблица `register_compares`, срок жизни результата | Таблицы нет: результат не хранится, применение заново сверяет файл с реестром |
| `file_id` в `register_compares` | Файл — в `files`; ссылка на него — в предпросмотре импорта (`register_imports.file_id`) и в diff журнала аудита |
| Выгрузка результата в Excel | В «Запланировано» |
| Миграция 2 `register_compares` | Миграция 2 `register_imports_file` — одна колонка и функция |

Без изменений: ключ и область задаются в настройках реестра (`registers.manage`) и только показываются при сравнении; область обязательна, «Весь реестр» — явный выбор с предупреждением; `is_import_key` остаётся; права — `records.edit`; refactor разбора файла уже сделан отдельным коммитом (`40ee03d`).

### Миграции (по одной, совместимы с backend 1.0.1)

**1. `register_compare_settings`** — ключ и поля области в реестре (расширить + перенести):

```sql
-- Влияние на данные: две новые колонки registers со значением '{}' (PostgreSQL 16 — без перезаписи таблицы);
-- UPDATE заполняет ключ сравнения у реестров с ключом импорта — по одной строке registers на такой реестр
-- (на dev — 1: «Устройства DLP»). Значения записей не меняются. Откат: backend 1.0.1 колонки не читает.
ALTER TABLE "registers"
  ADD COLUMN "compare_key_field_ids"   uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN "compare_scope_field_ids" uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE "registers" ADD CONSTRAINT "registers_compare_check"
  CHECK (cardinality("compare_key_field_ids") <= 3 AND cardinality("compare_scope_field_ids") <= 5);
UPDATE "registers" r SET "compare_key_field_ids" = ARRAY[f."id"]
FROM "register_fields" f
WHERE f."register_id" = r."id" AND f."is_import_key" AND f."deleted_at" IS NULL;
```

Пустой ключ — сравнение по колонке ID. Реестр уязвимостей получает ключ «CVE / БДУ + Пакет» и области «Система», «Отчёт сканирования» однократным шагом seed (`seed_markers`, поля по системному ключу, запись в журнале аудита).

**2. `register_imports_file`** — файл, по которому сравнивали:

```sql
-- Влияние на данные: новая колонка register_imports.file_id = NULL у всех строк (без перезаписи таблицы);
-- функция file_active_refs() начинает учитывать её (сейчас ссылок нет — ни один счётчик не меняется).
-- Откат: backend 1.0.1 колонку не читает; лишнее слагаемое функции только не даёт пометить такой файл удалённым.
ALTER TABLE "register_imports" ADD COLUMN "file_id" uuid REFERENCES "files"("id") ON DELETE RESTRICT;
CREATE OR REPLACE FUNCTION file_active_refs(f uuid) ... + (SELECT count(*) FROM "register_imports" WHERE "file_id" = f);
```

Зачем колонка, а не только diff аудита: файл, на который нигде нет ссылки, через 24 часа помечается удалённым (`sweepOrphanFiles`) и перестаёт открываться. Ссылка из предпросмотра импорта, с которого запущено сравнение, держит файл как доказательство. Если без колонки — файл можно хранить только как sha256 и имя в журнале, без возможности открыть.

### Backend

1. **Настройки:** `PATCH /registers/:id` — `compareKeyFieldIds` (до 3: текст, число, дата, список, справочник, сотрудник), `compareScopeFieldIds` (до 5: список, справочник). `registers.manage`, `version`, журнал. Поле из настроек нельзя отправить в архив, удалить или сменить тип — «сначала уберите его из сравнения».
2. **Сравнение:** `POST /register-imports/:id/compare` — multipart: тот же файл и область `{ all: true }` или `{ fieldId, values[] }`. Для выгрузки реестра и для отчёта сканера (`kind = 'scan'`). Сервер:
   - сверяет sha256 с предпросмотром импорта, кладёт файл в `files` (ограничения раздела 3.7), пишет `register_imports.file_id`;
   - строит ключи строк файла: текст — функцией БД `register_import_key()`, список, справочник и сотрудник — по id значения, число и дата — в каноническом виде; для отчёта сканера колонки «CVE» и «Пакет» сопоставляются с полями по системным ключам;
   - отвечает: ключ и область (названия), **«Нет в файле»** — открытые записи области (статус не закрывающий, не в архиве) с заполненным ключом, которых нет в файле: номер, заголовок, значение ключа, текущий статус; сколько записей области без ключа («не сопоставлены», без действий); строки файла вне области (числом);
   - **«неполный скан»** (только отчёт сканера): хосты прошлого отчёта того же отдела (`scan_reports.department`, последний не в архиве), которых нет в листе «Хосты» нового отчёта, — список имён.
   - В журнал — «сравнение: нет в файле N» с `fileId`, sha256, ключом и областью. **Записи не меняются.**
3. **Статус отсутствующим:** `POST /registers/:id/records/compare-status/preview` и `…/apply` — `{ importId, changes: [{ recordId, optionId }] }` (у каждой записи свой статус или один у выбранных — решает интерфейс). Сервер заново сравнивает сохранённый файл с реестром: изменить можно только записи, которые по-прежнему «нет в файле». Предпросмотр: изменится N; пропущено — с причиной (уже этот статус, зафиксировано статусом записи, запись нашлась в файле, изменилась или удалена). Применение — по `expected` (разошлось — 409 `BULK_CHANGED`), пакетами по 200, обычной правкой записи (пересчёт вычисляемых полей, фиксация, история карточки `via: 'compare'`, в diff — `fileId`, sha256, `importId`) и сводная запись журнала. «Неполный скан» в предпросмотре повторяется; применение при нём — только с флагом `acknowledgeIncompleteScan: true` (галочка «Понимаю: не все хосты просканированы»). `records.edit`.

### Frontend

- **Конструктор, вкладка «Поля»:** блок «Сравнение с реестром» — ключ (до трёх полей по порядку; пусто — «по ID») и поля области.
- **Окна импорта (выгрузка реестра и отчёт сканера):** кнопка «Сравнение» после предпросмотра. Показаны ключ и выбор области (поле и значения; отдельный пункт «Весь реестр» — с предупреждением). Результат — таблица «Нет в файле» с галочками и списком статуса в каждой строке; панель «Статус выбранным: …»; плашка «неполный скан» со списком хостов. Дальше — окно предпросмотра → подтверждение → итог, как в массовых действиях этапа А. Применение самого импорта — отдельной кнопкой, как сейчас.

### Тесты

- vitest: построение ключей строки и записи (составной ключ, нормализация, пустой ключ); «неполный скан» (разница списков хостов); тексты предпросмотра.
- test:db: нормализация ключа функцией БД; перенос ключа импорта в настройки (миграция 1) и seed реестра уязвимостей; сравнение выгрузки DLP по ключу импорта и отчёта сканера по «CVE + пакет» в области отчёта; закрытые, архивные, вне области и без ключа в «Нет в файле» не попадают; файл в `files`, `register_imports.file_id`, файл не помечается удалённым уборкой; статус: свой и общий, пропуск зафиксированных и уже нашедшихся в файле, 409 по `expected`, без `acknowledgeIncompleteScan` при неполном скане — отказ; журнал по записи и сводный с `fileId` и sha256; права по HTTP (`records.edit`, `registers.manage`).
- e2e: реестр уязвимостей — загрузить отчёт без одной уязвимости и без одного хоста → «Сравнение» с областью отчёта → в «Нет в файле» эта запись, плашка «неполный скан» → статус «Устранена» → подтверждение с галочкой → в истории записи файл отчёта.
- Проверки: typecheck, lint, test, test:db, `prisma migrate dev` + `check:schema`, `check:integrity`, e2e.

### Документация

ADR-0017 (ключ сравнения отдельно от ключа импорта, обязательная область, только «Нет в файле», файл как доказательство, порядок действий по ADR-0016); `docs/concept.md`, `docs/user-guide.md`; CHANGELOG «Не выпущено» — обе миграции и шаг seed с «Влиянием на данные»; в «Запланировано» — выгрузка результата сравнения в Excel и «хост не сканировался» по записи (нужна связь «уязвимость → хост» в отчёте сканера).

### Порядок коммитов

1. ~~`refactor`: разбор строк файла~~ — сделано, `40ee03d`.
2. Задача 4 — один коммит: миграции 1 и 2 (созданы по одной), seed, backend, типы, frontend, тесты, документация.

### Ответы владельца, которые остаются в силе (29.10.2026)

1. «Нет в файле» — открытые записи области с заполненным ключом; без ключа — не сопоставляются, без действий.
2. Ключ — только в настройках реестра, при сравнении не меняется.
3. Область обязательна; «Весь реестр» — явно и с предупреждением.
4. Нельзя менять вычисляемые поля, решения ОУР и зафиксированное статусом; по умолчанию — ничего не менять.
5. Права — `records.edit` (сравнение и статус), `registers.manage` (настройки). Новых прав нет.
6. `is_import_key` остаётся (ключ «CVE + пакет» не уникален).
7. Refactor — отдельным коммитом (сделано).
8. Файл сравнения хранится как доказательство: `files` + sha256, ссылка в журнале.


---

## 6. Этап Б.2 — доработка сравнения после проверки на отчётах 15.10 и 15.11 (на согласовании)

Основа — задача 4 в упрощённом виде (раздел 5), закоммичена отдельно. Ниже — изменения поверх неё.

### Что показал код

- Отдел уже читается из ячейки A1 листа «Хосты» и хранится в `scan_reports.department`, но **в записи уязвимости его нет**. Дубли сейчас ищутся по «CVE + пакет» среди **всех** открытых записей реестра (`openByKey`): отчёт отдела Б сливается с записями отдела А и меняет их «Обнаружений».
- «Обнаружений» при совпадении с открытой записью = максимум из старого и нового (`Math.max`) — поэтому 14 → 3 не обновляется. Внутри одного файла дубли тоже сводятся по максимуму.
- Система выбирается в окне отчёта сканера **при применении** (`systemId`), в записи — поле «Система» (справочник). При слиянии с открытой записью система не меняется.
- Записи отчёта можно найти без повторного чтения файла: предпросмотр уже хранит, с какими открытыми записями совпала каждая строка (`payload.merges`). «Нет в отчёте» для подсказки = открытые записи области минус совпавшие.
- На dev: 113 записей уязвимостей, у 92 есть «Отчёт сканирования», 67 загрузок отчёта, 1 отдел.

### 1. Подсказка в окне импорта

В окне отчёта сканера после предпросмотра: «N записей нет в этом отчёте — нажмите «Сравнение»». N — открытые записи **области по умолчанию** (п. 2), которых нет среди совпавших строк отчёта. Считается сервером: в предпросмотре — по отделу файла; при выборе системы в окне — запросом `GET /register-imports/:id/not-in-file?systemId=` (`records.edit`, только число и подпись области, файл не читается). N = 0 — подсказки нет.

### 2. Область по умолчанию — отдел и система

- Область — набор условий по полям (все должны выполняться): `{ conditions: [{ fieldId, values[] }] }` или `{ all: true }`. Прежний вид `{ fieldId, values }` принимается как одно условие (совместимость API).
- Для отчёта сканера по умолчанию: «Отдел» = отдел из листа «Хосты» (A1) и «Система» = система, выбранная в окне импорта. Дополнительно (не единственный вариант): «Конкретный прошлый отчёт» — список загрузок; «Весь реестр» — как прежде, с предупреждением.
- Подписи: «Сравнить с записями реестра: отдел «Отдел платёжных карт», система «АБС»» (в окне сравнения, в подсказке, в журнале), а не имена файлов.
- «Неполный скан»: прошлый отчёт — последний того же отдела (как сейчас) или выбранный.
- Поля области реестра уязвимостей: «Отдел», «Система», «Отчёт сканирования» (seed).

### 3. Поле «Отдел» в записи уязвимости

- Новое системное поле реестра уязвимостей **«Отдел»** (список, роль аналитики «измерение» — фильтр в реестре и плитки дашборда). Значения создаются из A1 отчёта при применении, как значения «Пакет» и «Отчёт сканирования».
- Применение отчёта: новой записи — отдел отчёта; **дубли — по «CVE + пакет + отдел»** среди открытых записей того же отдела; «Обнаружений» меняется только у записей того же отдела. Отчёт одного отдела не трогает записи другого ни в дублях, ни в «Обнаружений», ни в сравнении (отдел — условие области по умолчанию).
- **Миграции схемы БД нет**: поле реестра — это данные конструктора (`register_fields`), как поле «Система» на этапе 5. Изменение — однократным шагом seed `system.register.vulns.v5.department` (`seed_markers`, поле по системному ключу):

  ```text
  1. register_fields: + «Отдел» (select, system_key = 'department', analytics_role = 'dimension'),
     в конец списка; если у реестра уже есть своё поле «Отдел» — системное получает пометку «(отчёт)».
  2. register_field_options: + по значению на каждый отдел из scan_reports.department (непустой, без повторов
     после нормализации пробелов и регистра).
  3. register_records: «Отдел» заполняется у записей, у которых есть «Отчёт сканирования»: отдел берётся
     из scan_reports по названию отчёта (scan_reports.label = значение поля). values, search_text, version.
  4. registers: compare_scope_field_ids реестра уязвимостей = [«Отдел», «Система», «Отчёт сканирования»].
  5. audit_log: по записи на каждую изменённую запись (история карточки: «Отдел» — по отчёту «…»)
     и одна сводная.
  ```

  **Влияние на данные:** +1 строка `register_fields`; + по строке `register_field_options` на отдел (dev — 1); у записей с отчётом меняются `values` (добавляется ключ поля «Отдел»), `search_text`, `version` — на dev 92 из 113, на проде — число записей уязвимостей, загруженных из отчётов (запрос для подсчёта — ниже); +1 строка `registers` (поля области); записи в `audit_log`. Удалить данные нельзя: ключ добавляется, ничего не перезаписывается. Записи без отчёта (заведены вручную) остаются без отдела. Откат: backend 1.1.0 до этой доработки поле не читает (покажет как обычное поле-список); поле можно отправить в архив, значения сохранятся.

  ```sql
  -- Подсчёт на проде до выкладки (только чтение):
  SELECT count(*) AS with_report FROM register_records r
  JOIN registers g ON g.id = r.register_id AND g.system_key = 'vulns'
  JOIN register_fields f ON f.register_id = g.id AND f.system_key = 'report'
  WHERE r.deleted_at IS NULL AND r."values" ? f.id::text;
  SELECT department, count(*) FROM scan_reports GROUP BY 1;
  ```

### 4. «Обнаружений» при повторном отчёте

- Повторный отчёт того же отдела: у совпавшей открытой записи «Обнаружений» = значение из нового отчёта (14 → 3 — обновление). Внутри одного файла дубли «CVE + пакет» — по-прежнему максимум.
- Это меняет правило 6 раздела 7 CLAUDE.md. Новая формулировка: «**Импорт отчёта сканера.** Дубли по «CVE + пакет + отдел» среди открытых записей того же отдела объединяются; «Обнаружений» берётся из нового отчёта, дубли внутри одного файла — по максимуму. Отдел — из листа «Хосты» (A1), сохраняется в записи. Лист «Хосты» сохраняется к отчёту.» Обновляются CLAUDE.md, `docs/concept.md` и тесты (`vulns.db.test.ts`: правило «по максимуму» для повторного отчёта меняется на «из нового отчёта»).

### 5. «Запланировано»

Формат отчёта «уязвимость × хост»: если сканер умеет такую выгрузку — привязка уязвимостей к хостам и подгруппа «хост не сканировался» в сравнении.

### Тесты

- vitest: ключ дубля с отделом; условия области (И); подпись области.
- test:db: seed «Отдел» — поле, значения, заполнение у записей с отчётом (и не у ручных), поля области, журнал, повторный запуск ничего не меняет; два отдела: отчёт отдела Б не сливается с записями А, не меняет их «Обнаружений», в сравнении по умолчанию записи А не попадают в «нет в файле»; «Обнаружений» 14 → 3 у повторного отчёта и максимум у дублей внутри файла; подсказка — число и подпись; область `{ conditions }` и прежний `{ fieldId, values }`.
- e2e: отчёт 15.10 → отчёт 15.11 того же отдела без одной уязвимости: подсказка «1 запись нет в этом отчёте», «Сравнение» с областью по умолчанию «отдел …, система …», «Обнаружений» обновилось; фильтр «Отдел» в реестре.

### Документация

CLAUDE.md (правило 6), ADR-0017 (область по умолчанию, отдел), `docs/concept.md`, `docs/user-guide.md`, CHANGELOG («Изменено»: правило «Обнаружений» и дубли по отделу; шаг seed с «Влиянием на данные»; «Запланировано»).

### Порядок коммитов

Один коммит (refactor импорта не нужен: меняется логика дублей, а не её разбор). Если окажется, что нужно вынести поиск открытых записей из `scan-import.service.ts`, — отдельным refactor-коммитом до функционального.

### Вопросы

1. Подсказка «N записей нет в этом отчёте» — только для отчёта сканера? Для выгрузки реестра по ключу импорта в предпросмотре уже есть список «Нет в файле». Предлагаю: только отчёт сканера.
2. Если в окне отчёта система не выбрана, область по умолчанию — только отдел (все системы отдела)? Предлагаю так, с подписью «отдел X, все системы».
3. Записи без отдела (заведены вручную или до появления отчётов) не участвуют в дублях отчётов и в сравнении по отделу — согласны? Иначе ручная запись «CVE + пакет» сольётся с отчётом любого отдела.
4. Если у строки повторного отчёта «Обнаружений» пусто — оставить прежнее значение записи? Предлагаю оставить.
5. Журнал заполнения «Отдела»: по записи на каждую изменённую запись (видно в истории карточки) плюс сводная — согласны? На проде это столько записей журнала, сколько уязвимостей с отчётом.
6. Если в A1 отдел написан по-разному («Отдел платёжных карт» / «отдел платежных карт»), это одно значение после нормализации пробелов и регистра, но «е»/«ё» — разные. Достаточно нормализации пробелов и регистра?


---

## 7. План этапа В — задачи 5 и 6 (на согласовании)

Этап Б (задача 4 и Б.2) закоммичен: `7612db7`, `b009fe5`, `2539f56` (отчёт без отдела в A1 — обязательный выбор отдела).

### Что показал код

- **Дашборд** (`GET /dashboard/kpis`, `/dashboard/widgets`, `/dashboard/tiles`): 9 KPI с фиксированными ключами (`KPI_KEYS`), плитки-счётчики (`dashboard_tiles`, общие для всех, создаёт и удаляет `registers.manage`), виджеты из полей с ролью аналитики и фиксированные (`FIXED`, «Доступ без основания»). Порядок задан кодом, раскладки пользователя нет; localStorage дашборд не использует. Весь дашборд — по праву `ib.work`: внутри него сейчас нет данных, которые одному сотруднику ИБ видны, а другому нет.
- **Мониторинг** (`GET /monitor`, `ib.work` или `monitor.kiosk`): один экран — ряд KPI, список уязвимостей по срокам с корзинами (просрочено, 0–7, 8–14…), сбоку сроки задач, документов (пересмотр) и решений ОУР. «Листание» каждые 12 с (`MONITOR_FLIP_MS`) — это страницы этих списков, а не отдельные слайды. Настроек нет.

### Задача 5. Дашборд: управление плитками

**Модель.** Раскладка — упорядоченный список элементов `{ key, hidden, size }`: `key` — `kpi:<ключ>`, `tile:<id>`, `widget:<ключ>`; `size` — `s` (1 колонка), `m` (2), `l` (вся ширина); KPI — всегда `s`. Неизвестные ключи (плитку удалили, поле убрали из аналитики) пропускаются; новые элементы, которых нет в раскладке, добавляются в конец видимыми. Поэтому раскладка не ломается при изменении реестров.

**Где хранится.** Таблица `dashboard_layouts`: раскладка пользователя или раскладка по умолчанию для роли. Пользователь видит свою; если её нет — раскладку первой своей роли, у которой она задана (по порядку ролей в «Пользователи и роли»); если нет и её — системную по умолчанию (нынешний порядок из кода). localStorage — только кэш последней раскладки, чтобы экран не «прыгал» при загрузке; источник — БД.

**Миграция `dashboard_layouts`:**

```sql
-- Влияние на данные: новая пустая таблица, существующие строки не меняются. Откат: backend 1.0.1 её не читает.
CREATE TABLE "dashboard_layouts" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid REFERENCES "users"("id") ON DELETE RESTRICT,   -- раскладка пользователя
  "role_id"    uuid REFERENCES "roles"("id") ON DELETE RESTRICT,   -- или раскладка по умолчанию для роли
  "items"      jsonb NOT NULL,                                     -- [{ key, hidden, size }]
  "version"    int NOT NULL DEFAULT 1,
  "updated_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL,
  CONSTRAINT "dashboard_layouts_owner_check" CHECK (("user_id" IS NULL) <> ("role_id" IS NULL))
);
CREATE UNIQUE INDEX "dashboard_layouts_user_key" ON "dashboard_layouts"("user_id") WHERE "user_id" IS NOT NULL;
CREATE UNIQUE INDEX "dashboard_layouts_role_key" ON "dashboard_layouts"("role_id") WHERE "role_id" IS NOT NULL;
```

**API** (новых прав нет):
- `GET /dashboard/layout` — раскладка для текущего пользователя (своя, роли или системная) и откуда она (`user | role | system`). `ib.work`.
- `PUT /dashboard/layout` — сохранить свою (`version`, 409 при расхождении). `ib.work`.
- `POST /dashboard/layout/reset` — «Сбросить»: своя раскладка удаляется, снова действует раскладка роли или системная. `ib.work`.
- `GET|PUT /dashboard/role-layouts/:roleId` — раскладка по умолчанию для роли. Право `users.manage` (роли настраиваются там же).
- Журнал: сохранение и сброс своей раскладки — `dashboard.layout.saved` / `.reset` (кто, сколько элементов скрыто); раскладка роли — с «было / стало».

**Права на плитки.** Backend отдаёт в раскладке только элементы, данные которых пользователь вправе видеть: у каждого источника — требуемое право (сейчас у всех `ib.work`, поэтому фактически скрывать нечего; механизм нужен, чтобы будущая плитка с ограниченным правом не появилась у того, кому она недоступна). Скрытые по правам элементы не показываются и в режиме «Настроить».

**Предлагаемые раскладки по умолчанию для ролей** (задаются seed один раз; дальше их меняет администратор):
- «Сотрудник ИБ» — системная (все KPI, плитки, виджеты в нынешнем порядке).
- «Начальник ИБ» — сначала просроченное и требующее решения: KPI «Уязвимости с просроченным сроком», «Просроченные задачи», «Риски без решения ОУР», «Документы на пересмотре», затем остальные KPI; виджеты сроков — размер `l`.
- «Супер-администратор» — системная.
- «Юрист», «Правление», «Настенный монитор» — дашборда не видят (нет `ib.work`), раскладка не нужна.

**Frontend.** Кнопка «Настроить» на дашборде: у каждого элемента — «скрыть / показать», размер S/M/L, перетаскивание мышью (pointer-события, как перетаскивание карточек на доске задач — без новых зависимостей); «Сбросить», «Готово». Скрытые — в отдельном списке «Скрытые», откуда их можно вернуть. Администратор с `users.manage`: в «Пользователи и роли» у роли — «Раскладка дашборда по умолчанию» (тот же редактор).

**Тесты.** vitest: слияние раскладки с текущим набором элементов (удалённые пропускаются, новые — в конец), размеры. test:db: своя → роль → системная; сброс; 409; права (чужую раскладку не изменить, раскладка роли — только `users.manage`); журнал; элементы без права не отдаются. e2e: «Настроить» → скрыть KPI, перетащить виджет, размер L, «Готово» → после перезагрузки так же; «Сбросить».

### Задача 6. Мониторинг: настройка слайдов

**Модель.** Слайд — `{ kind, title, seconds, filter, enabled, sortOrder }`. Экран показывает включённые слайды по порядку, каждый — `seconds` секунд (по умолчанию 12); если список слайда не помещается на экран, слайд делится на страницы, и каждая страница показывается `seconds`. Виды слайдов и фильтры:

| Вид | Что показывает | Фильтры |
|---|---|---|
| `kpis` | Ряд KPI | какие KPI (из `KPI_KEYS`) |
| `vulns` | Уязвимости по сроку устранения, корзины «просрочено / 0–7 / 8–14 / 15–30 / >30» | критичность, отдел, система; только просроченные / в пределах N дней |
| `tasks` | Задачи по сроку | категории; только просроченные / в пределах N дней |
| `documents` | Документы: срок пересмотра и актуальности | только просроченные / в пределах N дней; типы документов |
| `risks` | Пересмотр решений ОУР | в пределах N дней |
| `dlp` | «Доступ без основания» и разрешения, истекающие в этом месяце (если есть реестр со статусом основания) | реестр, каналы |

**Где хранится.** Таблица `monitor_slides` (одна настройка на все настенные мониторы). Правка — `settings.manage` («Настройки → Экран мониторинга»); киоск (`monitor.kiosk`) и сотрудники ИБ только читают через `GET /monitor`. `MONITOR_ALLOWED_IPS` и правила киоска (ADR-0012) не меняются.

**Миграция `monitor_slides`:**

```sql
-- Влияние на данные: новая таблица; шаг seed (однократно) заводит слайды, повторяющие нынешний экран:
-- «KPI», «Уязвимости по срокам», «Задачи», «Документы», «Решения ОУР» — 5 строк. Другие таблицы не меняются.
-- Откат: backend 1.0.1 таблицу не читает и показывает прежний экран.
CREATE TABLE "monitor_slides" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"       text NOT NULL CHECK ("kind" IN ('kpis', 'vulns', 'tasks', 'documents', 'risks', 'dlp')),
  "title"      text NOT NULL CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
  "seconds"    int  NOT NULL DEFAULT 12 CHECK ("seconds" BETWEEN 5 AND 300),
  "filter"     jsonb NOT NULL DEFAULT '{}',
  "enabled"    boolean NOT NULL DEFAULT true,
  "sort_order" int NOT NULL,
  "version"    int NOT NULL DEFAULT 1,
  "created_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,  -- NULL — слайд seed
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(3) NOT NULL,
  "deleted_at" timestamptz(3)                                       -- удаление мягкое
);
CREATE INDEX "monitor_slides_order" ON "monitor_slides"("sort_order") WHERE "deleted_at" IS NULL;
```

**API.** `GET /monitor` — включённые слайды по порядку с данными каждого (как сейчас — одним запросом, кэш KPI сохраняется). `GET /monitor/slides`, `POST /monitor/slides`, `PATCH /monitor/slides/:id` (`version`, 409), `POST /monitor/slides/:id/move`, `POST /monitor/slides/:id/delete` (мягко) — `settings.manage`, журнал «было / стало». Фильтры проверяются сервером (неизвестный отдел, категория, тип — 400).

**Frontend.** «Настройки → Экран мониторинга»: список слайдов (вид, название, секунды, включён, ↑↓), карточка слайда с фильтрами, «Предпросмотр» — открыть `/monitor` в новой вкладке. Экран `/monitor`: слайды по порядку, время каждого — из настройки; панель «назад / пауза / вперёд / на весь экран / закрыть», клавиши ← → и пробел, Wake Lock, плашка «нет связи» — как сейчас. Номер слайда и страницы — точками внизу.

**Тесты.** vitest: разбиение слайда на страницы и расчёт времени, фильтры. test:db: seed (5 слайдов, повторный запуск ничего не меняет), CRUD и порядок, 409, мягкое удаление, журнал, фильтры (отдел и критичность в `vulns`, категория в `tasks`, N дней в `documents`), киоск читает и не может менять (403), `ib.work` без `settings.manage` — 403 на правку. e2e: добавить слайд «Задачи — просроченные» на 5 с, перенести вверх → `/monitor` показывает его первым и листает через 5 с; выключить слайд → его нет; киоск-сценарий из этапа 8 зелёный.

### Документация

ADR-0018 (раскладка дашборда: пользователь → роль → система, элементы по ключам, права на источник) и ADR-0019 (слайды мониторинга: одна настройка, `settings.manage`, киоск только читает), `docs/concept.md`, `docs/user-guide.md`, CHANGELOG с «Влиянием на данные» обеих миграций и шага seed.

### Порядок коммитов

Задача 5 → задача 6, по коммиту на задачу; миграции создаются по одной. Если для слайдов понадобится вынести расчёт данных мониторинга из `monitor/service.ts` в общие функции — отдельным refactor-коммитом до задачи 6, без изменения поведения.

### Вопросы

1. Раскладка по умолчанию для роли — правит `users.manage` (там же, где роли)? Предлагаемые раскладки для «Сотрудник ИБ», «Начальник ИБ», «Супер-администратор» — устраивают?
2. «Сбросить» физически удаляет строку своей раскладки (это настройка интерфейса, не бизнес-данные; в журнале — запись о сбросе)? Или мягко (`deleted_at`)?
3. Размеры S/M/L (1 колонка / 2 / вся ширина), KPI — всегда S. Достаточно?
4. Мониторинг: одна настройка слайдов на все настенные мониторы — достаточно? Разные наборы для разных мониторов — в «Запланировано».
5. Виды слайдов — `kpis`, `vulns`, `tasks`, `documents`, `risks`, `dlp`. Нужен ли общий вид «Сроки по любому реестру» (поле-срок любого реестра с фильтром по полю-списку)? Предлагаю не делать в 1.1.0.
6. Документы: «срок актуальности» — это `review_due` (пересмотр). Отдельного срока актуальности в модели нет. Достаточно `review_due`?
7. Время слайда — от 5 до 300 с, по умолчанию 12. Устраивает?

### 7.1. Ответы владельца (29.10.2026) — план этапа В утверждён

1. Раскладку по умолчанию для роли правит `settings.manage` (настройка интерфейса, как слайды), не `users.manage`. Предложенные раскладки ролей подходят.
2. «Сбросить» — физическое удаление своей строки раскладки с записью в журнал.
3. Размеров S/M/L достаточно.
4. Одна настройка слайдов на все мониторы; разные наборы — в «Запланировано».
5. «Сроки по любому реестру» в 1.1.0 не делаем.
6. Срок пересмотра документа = срок актуальности.
7. Время слайда 5–300 с, по умолчанию 12.

Дополнительно:
- `/monitor` подхватывает изменения слайдов без перезагрузки: проверка раз в 1–5 минут, смена набора — на границе слайда, без мигания.
- В настройках слайдов «Предпросмотр» — слайд так, как он будет на мониторе.
- Слайд без данных показывает понятный текст («Нет просроченных задач»), а не пустой экран; у слайда опция «пропускать пустой слайд».

Уточнение к миграции `dashboard_layouts`: `updated_by` допускает NULL — раскладки ролей по умолчанию заводит seed, пользователя у него нет (как `dashboard_tiles.created_by`).

---

## 8. Итоги этапа В (29.10.2026)

Коммиты: `a9ff9c6` (задача 5 — раскладка дашборда), `0a868c2` (исправление: «Архив» доски задач — недавно архивированные первыми; при 528 архивных на dev новая задача не попадала в первые 500), `4fe5654` (refactor данных мониторинга), `1b6690f` (задача 6 — слайды мониторинга). Отличия от плана: у `dashboard_layouts.updated_by` допускается NULL (раскладку роли заводит seed); раскладку по умолчанию можно задать любой роли, кроме настенного монитора («Начальник ИБ» без `ib.work` получает дашборд через «Сотрудника ИБ»); у слайдов добавлены `skip_empty` и вид `evidence`. Проверки перед коммитом задачи 6: test 184, test:db 194, frontend 50, e2e 61 из 61, `check:schema`, `check:integrity`.

Следующий шаг по разделу 1 — сборка релиза 1.1.0 (VERSION, раздел 1.1.0 в CHANGELOG, тег, `make-release.sh`, проверка установки с нуля и обновления 1.0.1 → 1.1.0, `<версия>` в `docs/runbook/deploy.md`, `dist/changes-1.1.0/`).
