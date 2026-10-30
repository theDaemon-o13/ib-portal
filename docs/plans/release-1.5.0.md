# Релиз 1.5.0 — раздел «Уязвимости»: группы, сканы, сроки (план)

**Принят владельцем 30.10.2026.** Решения по п. 8:
1. Seed пишет «Срок из прежнего реестра» только в новое поле, идемпотентно; число — в выводе и в предпроверке; откат на 1.1.0 с новыми полями проверяется запуском.
2. Перенос окончания срока с выходного на рабочий день остаётся; спецификация поправлена.
3. «Риск принят» при новом скане не открывается; решение п. 7.3 при повторном обнаружении снимается с записью в истории.
4. Срок — от первого переданного ИКТ скана (по времени передачи), в котором запись встречалась после последнего открытия; тест.
5. На странице «Реестры» у реестра уязвимостей отключены создание записей, импорт отчёта сканера и сравнение; выгрузка и обратный импорт по ID остаются. Ручное создание записи — этап 2.
6. «Система» в окне импорта необязательна, предзаполняется системой предыдущего импорта узла (без новых полей схемы: из `register_imports.payload`).
7. «Перенести выбранные» и переименование группы (уникальность, журнал) — делаем.
8. Образец переименован в `vuln-windows-2026-10-15.xlsx`.
9. Предпроверки — `deploy/prechecks/1.5.0.md`; остальное в `deploy/` не трогается.
Дополнительно: «Срок из прежнего реестра» и «Продлено, дн.» вручную не правятся (карточка, обратный импорт); `check-integrity` сверяет «Продлено, дн.» с суммой действующих продлений и перечисляет расхождения; предпроверочный запрос запускается на схеме тега `v1.1.0` до коммита шага переноса.

Спецификация — `docs/specs/vulnerabilities.md`, эталон экранов — `docs/prototype/vulnerabilities-demo.html`, образец — `backend/test/fixtures/vuln-windows-2026-10-15.xlsx`.

## 0. Что есть сейчас (прочитано в коде)

| Что | Где | Как работает |
|---|---|---|
| Реестр | системный реестр конструктора `registers.system_key = 'vulns'`, поля по `system_key` (`modules/vulns/definition.ts`, seed `prisma/seed/vulns.ts` v1–v5) | Одна структура полей, записи — `register_records.values` |
| Срок | вычисляемое поле `due`, правило `DueDateRule` в `lib/register-values.ts → calcValue()`: `notified` + дни по `crit` (14/30/90/180), перенос на рабочий день (`shiftToWorkday: true`), п. 7.3 — `newDue` при заполненных `measures` | Не хранится, считается при чтении **одной функцией** |
| Кто читает срок | `registers/definition.ts` (`dateOf`, `deadlineState`, DTO), `registers/records.service.ts` (сортировка), `registers/filter.ts` (фильтр `deadline`), `registers/excel.service.ts` («Дней до срока»), `automations/conditions.ts` (`before`, `overdue`, `overdue + workdays + unlessFilled` — правила seed `vuln.remind_before_due`, `vuln.overdue_notify`, `vuln.overdue_escalate`), `tasks/from-events.ts` (события → задачи, ключ — дата срока), `dashboard/service.ts` (KPI `vulns_open/overdue/soon`, виджет «Контроль сроков»), `monitor/service.ts` (`vulnsBlock`: корзины по дням), frontend `pages/registers/logic.ts`, слайды монитора | Всё через `calcValue`/`dateOf` по `values` записи |
| Импорт отчёта | `vulns/scan-parser.ts` (лист «Хосты» **по имени**, отдел — A1, заголовки в 10 строках, CVSS не число — строка отбрасывается), `vulns/scan-import.service.ts` (предпросмотр → применение одной транзакцией; дубли «CVE + пакет + отдел» среди открытых; `notified` = дата передачи **при импорте**) | Выбора по строкам нет |
| Сравнение и выбор | `registers/compare.service.ts` (ADR-0017): «Нет в файле» + статус выбранным, `expected` и 409 `BULK_CHANGED`, «неполный скан» по хостам прошлого отчёта отдела | Отдельное окно `CompareDialog` |
| Сканы | `scan_reports` (+ `scan_hosts`), файл **не хранится** — только имя и sha256; файл сравнения — `register_imports.file_id` | Архив отчёта — `records.edit` |

Главный вывод: срок везде считается из `values` одной функцией. Если итоговый срок тоже выражается через `values` записи, дашборд, монитор, фильтры, Excel и уведомления п. 7.4 переходят на него без правок, и сразу по всем узлам — записи остаются в одном реестре.

## 1. Модель данных

**Беру вашу рекомендацию.** Одна структура полей (существующий реестр `vulns`), узел — отдельная таблица, принадлежность записи узлу — в таблице `vuln_records`. Реестры конструктора на каждый узел не подходят: правила п. 7.4, ключ сравнения, дашборд и монитор пришлось бы размножать и синхронизировать, а отчёт «по всем узлам» собирать из N реестров.

### 1.1. Итоговый срок — в `values`, одной функцией

`DueDateRule` получает два необязательных ключа (у других реестров их нет, поведение не меняется):
- `baseFieldId` — дата «Срок из прежнего реестра»: если заполнена, база = она, а не `notified + дни`;
- `addDaysFieldId` — число «Продлено, дн.»: прибавляется к базе.

```
итог = п. 7.3 (measures и newDue заполнены) ? newDue
     : shift( (legacyDue ?? notified + дни[crit]) + extDays )
```
`notified` («Уведомлено ДИКТ») теперь ставит передача ИКТ скана, а не импорт: до передачи срока нет, статус «Не передано ИКТ». Два новых системных поля реестра: `legacyDue` («Срок из прежнего реестра», дата) и `extDays` («Продлено, дн.», число). Эти три поля становятся служебными: форма, импорт Excel и массовые действия их не меняют (как вычисляемые: в выгрузке серые, при импорте пропускаются, в API — 409 `VULN_SERVICE_FIELD`). `extDays` — кэш суммы действующих продлений текущего цикла. Его сверяет `check-integrity`.

### 1.2. Таблицы

Миграция 1 — `vuln_groups_scans` (коммит 1):

```sql
CREATE TABLE vuln_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('service', 'department', 'temporary')),
  system_key text UNIQUE,                                   -- 'ungrouped' у «Без группы»
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,  -- NULL — создана seed
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CHECK ((kind = 'temporary') = (system_key IS NOT NULL))
);
CREATE UNIQUE INDEX vuln_groups_name_uq ON vuln_groups (lower(btrim(name)));

CREATE TABLE vuln_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES vuln_groups(id) ON DELETE RESTRICT,
  system_type_id uuid REFERENCES catalog_items(id) ON DELETE RESTRICT,  -- справочник system_types
  system_key text UNIQUE,                                   -- 'legacy' — «Из прежнего реестра»
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK ((system_type_id IS NULL) = (system_key IS NOT NULL))
);
CREATE UNIQUE INDEX vuln_nodes_group_type_uq ON vuln_nodes (group_id, system_type_id) WHERE system_type_id IS NOT NULL;

CREATE TABLE vuln_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id uuid NOT NULL REFERENCES vuln_nodes(id) ON DELETE RESTRICT,
  import_id uuid UNIQUE REFERENCES register_imports(id) ON DELETE RESTRICT,   -- новый скан
  legacy_report_id uuid UNIQUE REFERENCES scan_reports(id) ON DELETE RESTRICT, -- отчёт прежнего реестра
  file_id uuid REFERENCES files(id) ON DELETE RESTRICT,                        -- у прежних нет
  file_name text NOT NULL, file_sha256 text NOT NULL,
  scan_date date NOT NULL,
  coverage_title text NOT NULL DEFAULT '',
  hosts jsonb NOT NULL DEFAULT '[]',        -- [{name, ip, os}]; у прежних — из scan_hosts при чтении
  hosts_count int NOT NULL DEFAULT 0,
  findings jsonb NOT NULL DEFAULT '[]',     -- снимок строк файла с посчитанной Оценкой (до 20 000 строк)
  findings_count int NOT NULL DEFAULT 0,
  comparison jsonb,                          -- ключи по пяти группам, отмеченные «пропавшие», охват
  previous_scan_id uuid REFERENCES vuln_scans(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  handed_over_on date, handed_over_to text, handover_file_id uuid REFERENCES files(id) ON DELETE RESTRICT,
  handed_over_by uuid REFERENCES users(id) ON DELETE RESTRICT, handed_over_at timestamptz(3),
  CHECK ((import_id IS NULL) <> (legacy_report_id IS NULL)),
  CHECK (handed_over_on IS NULL OR handed_over_on >= scan_date),
  CHECK ((handed_over_on IS NULL) = (handed_over_by IS NULL) AND (handed_over_on IS NULL) = (handed_over_at IS NULL))
);
CREATE INDEX vuln_scans_node_date_idx ON vuln_scans (node_id, scan_date DESC, created_at DESC);
-- триггер: строка не меняется, кроме однократной передачи ИКТ (handed_over_* из NULL в значение)

CREATE TABLE vuln_records (
  record_id uuid PRIMARY KEY REFERENCES register_records(id) ON DELETE RESTRICT,
  node_id uuid NOT NULL REFERENCES vuln_nodes(id) ON DELETE RESTRICT,
  key_norm text,          -- «пакет␀идентификатор» без регистра и лишних пробелов; NULL — в «Без группы» и у удалённых
  deadline_scan_id uuid REFERENCES vuln_scans(id) ON DELETE RESTRICT,  -- от какого скана идёт срок
  first_scan_id uuid REFERENCES vuln_scans(id) ON DELETE RESTRICT,
  last_scan_id uuid REFERENCES vuln_scans(id) ON DELETE RESTRICT,
  cycle int NOT NULL DEFAULT 1,       -- +1 при повторном обнаружении: продления прошлого цикла не действуют
  reopened_at timestamptz(3),
  legacy boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vuln_records_node_key_uq ON vuln_records (node_id, key_norm) WHERE key_norm IS NOT NULL;
CREATE INDEX vuln_records_node_idx ON vuln_records (node_id);

CREATE TABLE vuln_record_scans (       -- только пополняется: «впервые, последний раз, список» в карточке
  record_id uuid NOT NULL REFERENCES register_records(id) ON DELETE RESTRICT,
  scan_id uuid NOT NULL REFERENCES vuln_scans(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('new', 'reopened', 'changed', 'unchanged', 'fixed', 'legacy')),
  cycle int NOT NULL,
  changes jsonb,                      -- «было → стало» по полям
  PRIMARY KEY (record_id, scan_id)
);

REVOKE DELETE, TRUNCATE ON vuln_groups, vuln_nodes, vuln_scans, vuln_records FROM ibportal_app;
REVOKE UPDATE, DELETE, TRUNCATE ON vuln_record_scans FROM ibportal_app;
-- file_active_refs(): + vuln_scans.file_id, vuln_scans.handover_file_id (CREATE OR REPLACE, остальное тело без изменений)
```
**Влияние на данные:** пять новых пустых таблиц, затронуто 0 строк, существующие таблицы не меняются. Функция `file_active_refs()` заменяется: для существующих таблиц результат тот же, добавлены две ссылки. Откат: 1.1.0–1.4.0 новые таблицы не читают. Функция с лишними ссылками для них безопасна: файл просто дольше считается занятым.

Миграция 2 — `vuln_deadline_extensions` (коммит 5):

```sql
CREATE TABLE vuln_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id uuid REFERENCES vuln_nodes(id) ON DELETE RESTRICT,
  group_id uuid REFERENCES vuln_groups(id) ON DELETE RESTRICT,
  days_by_level jsonb NOT NULL,         -- {"<id значения «Уровень»" | "none": дни}
  filters jsonb NOT NULL DEFAULT '{}',  -- {onlyOverdue, dueUntil}
  basis_number text NOT NULL CHECK (length(btrim(basis_number)) BETWEEN 1 AND 100),
  basis_date date NOT NULL,
  basis_file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  comment text NOT NULL DEFAULT '' CHECK (length(comment) <= 2000),
  records_count int NOT NULL CHECK (records_count > 0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  cancelled_at timestamptz(3), cancelled_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  CHECK ((node_id IS NULL) <> (group_id IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE TABLE vuln_extension_items (
  extension_id uuid NOT NULL REFERENCES vuln_extensions(id) ON DELETE RESTRICT,
  record_id uuid NOT NULL REFERENCES register_records(id) ON DELETE RESTRICT,
  cycle int NOT NULL,
  days int NOT NULL CHECK (days BETWEEN 1 AND 365),
  due_before date NOT NULL, due_after date NOT NULL CHECK (due_after > due_before),
  PRIMARY KEY (extension_id, record_id)
);
CREATE INDEX vuln_extension_items_record_idx ON vuln_extension_items (record_id);
-- триггер: у vuln_extensions меняются только cancelled_at/cancelled_by и только один раз (из NULL)
REVOKE DELETE, TRUNCATE ON vuln_extensions FROM ibportal_app;
REVOKE UPDATE, DELETE, TRUNCATE ON vuln_extension_items FROM ibportal_app;
-- file_active_refs(): + vuln_extensions.basis_file_id
```
**Влияние на данные:** две новые пустые таблицы, затронуто 0 строк. Откат — как у миграции 1.

Других миграций нет: служебные поля, справочник и узел «Без группы» — данные, их добавляет seed (раздел 2), как поле «Отдел» в 1.1.0.

## 2. Перенос текущих данных в «Без группы / Из прежнего реестра»

**Однократный шаг seed `vulns.groups.v1`** (одна транзакция `migrate`, всё в журнал):
1. Справочник `system_types` «Типы систем» и пять стартовых значений: БД, Серверы, Рабочие станции, Сетевое оборудование, Веб-приложения. Отметка в `seed_markers`: удалённое администратором не восстанавливается.
2. Группа «Без группы» (`temporary`, `system_key = 'ungrouped'`) и узел «Из прежнего реестра» (`system_key = 'legacy'`).
3. Поля реестра `legacyDue` и `extDays` (в конец, при совпадении названия — с пометкой, как поле «Система» в seed v2). У поля `due` в `calc_rule` добавляются `baseFieldId` и `addDaysFieldId`, `version + 1`, в журнал — было и стало.
4. **Записи.** Каждая запись реестра, включая архивные и удалённые, получает строку `vuln_records` (узел legacy, `legacy = true`, `key_norm = NULL`). Неудалённым записям, у которых срок по процедуре вычисляется (заполнены `notified` и `crit`), в `values` пишется `legacyDue` = `notified + дни[crit]` с переносом на рабочий день, то есть текущий срок **без** решения п. 7.3. Решение остаётся в своих полях и по-прежнему главнее. Дальше — `version + 1`, пересчёт `search_text` и запись в журнал по каждой записи: «Срок из прежнего реестра: ДД.ММ.ГГГГ (обновление 1.5.0)». Остальные значения не меняются, id записей и номера тоже, поэтому история карточки (`audit_log` по `entity_id`) остаётся на месте.
5. **Отчёты прежнего реестра.** Каждый `scan_reports` получает строку `vuln_scans` в узле legacy: `legacy_report_id`, дата отчёта, передача ИКТ = `notified_date`, кому — «ДИКТ», кто — загрузивший. Хосты при чтении берутся из `scan_hosts` и не копируются. Снимка находок и сравнения у них нет: файл в 1.1.0 не хранился, в экране скана так и написано. `scan_reports`, `scan_hosts`, `register_imports` и `files` не меняются. Архивные отчёты показываются с пометкой «в архиве».
6. Вывод seed: `Без группы: записей N (открытых X, со сроком Y, без срока Z, удалённых D), отчётов прежнего реестра S (хостов H, в архиве A), повторов ключа в прежнем реестре K`.

**Повторяемый шаг** (при каждом `migrate`, обычно выводит нули). Записи реестра без строки `vuln_records` попадают в legacy, а `scan_reports` без `vuln_scans` — в legacy-сканы, по тем же правилам. Так закрывается окно отката: всё, что 1.1.0 или 1.4.0 успеют создать после отката, при повторном обновлении окажется в «Без группы».

**Перенос в узел** («Перенести», `records.edit`). Запись получает `node_id`, `key_norm`, `legacyDue` сохраняется. Если ключ в узле уже есть — 409 «В узле уже есть «пакет · идентификатор» (#номер)» (уникальный индекс плюс проверка с понятным текстом). Без пакета или идентификатора перенести нельзя. Пишется в журнал и в историю карточки.

**Предпроверка до выкладки, только чтение.** Запрос работает на схеме 1.1.0, проверю его на схеме из миграций тега `v1.1.0`:

```sql
WITH reg AS (SELECT id FROM registers WHERE system_key = 'vulns'),
fld AS (SELECT system_key, id::text AS id FROM register_fields WHERE register_id = (SELECT id FROM reg) AND deleted_at IS NULL),
st AS (SELECT o.id::text AS id, o.is_closed FROM register_field_options o JOIN register_fields f ON f.id = o.field_id
       WHERE f.register_id = (SELECT id FROM reg) AND f.system_key = 'status'),
rec AS (
  SELECT r.*, (r.values ->> (SELECT id FROM fld WHERE system_key = 'status')) AS status_id,
         (r.values ? (SELECT id FROM fld WHERE system_key = 'notified')) AS has_notified,
         (r.values ? (SELECT id FROM fld WHERE system_key = 'measures') AND r.values ? (SELECT id FROM fld WHERE system_key = 'newDue')) AS has_73
  FROM register_records r WHERE r.register_id = (SELECT id FROM reg))
SELECT
  count(*)                                                                     AS records_total,
  count(*) FILTER (WHERE deleted_at IS NOT NULL)                               AS deleted,
  count(*) FILTER (WHERE deleted_at IS NULL AND archived_at IS NOT NULL)       AS archived,
  count(*) FILTER (WHERE deleted_at IS NULL AND archived_at IS NULL
                   AND coalesce((SELECT is_closed FROM st WHERE st.id = status_id), false) = false) AS open,
  count(*) FILTER (WHERE deleted_at IS NULL AND has_notified)                  AS with_deadline_base,
  count(*) FILTER (WHERE deleted_at IS NULL AND NOT has_notified)              AS without_deadline,
  count(*) FILTER (WHERE deleted_at IS NULL AND has_73)                        AS with_decision_7_3,
  (SELECT count(*) FROM scan_reports WHERE register_id = (SELECT id FROM reg))                          AS scan_reports,
  (SELECT count(*) FROM scan_reports WHERE register_id = (SELECT id FROM reg) AND archived_at IS NOT NULL) AS scan_reports_archived,
  (SELECT count(*) FROM scan_hosts h JOIN scan_reports s ON s.id = h.report_id WHERE s.register_id = (SELECT id FROM reg)) AS scan_hosts,
  (SELECT count(*) FROM register_imports WHERE register_id = (SELECT id FROM reg) AND file_id IS NOT NULL) AS compare_files
FROM rec;
```
Плюс второй запрос — повторы ключа «пакет + идентификатор» среди неудалённых записей (в «Без группы» они остаются, при переносе второй из пары получит отказ). После `migrate` — сверка: число строк `vuln_records` = `records_total`, `vuln_scans` legacy = `scan_reports`, записей с `legacyDue` = `with_deadline_base`.

**Влияние на данные шага seed:** переписывается `values` неудалённых записей реестра уязвимостей со сроком (`with_deadline_base` строк). Добавляется один ключ `legacyDue`, существующие значения не меняются, `version + 1`, по строке журнала на запись. Это переписывание данных: по разделу 9.3 CLAUDE.md — **только после вашего подтверждения**. Откат: на 1.1.0 ключ виден как обычное поле «Срок из прежнего реестра», на срок не влияет, потому что 1.1.0 считает срок по `notified` и `crit`, как раньше. Альтернатива без переписывания — фиксировать дату лениво, при первой ручной смене Критичности или при переносе. Она сложнее и даёт два источника правды, поэтому не рекомендую.

## 3. Импорт: разбор, ключ, пять групп, охват

**Разбор** (`scan-parser.ts`, переписывается под содержимое, без новых зависимостей — exceljs):
- лист хостов — любой лист, где в первых 12 строках есть «Имя хоста»; охват — ближайшая непустая строка над заголовком (не обязательно A1); IP — колонка, начинающаяся с «IP»; ОС — «ОС»;
- листы находок — все листы с «Пакет» и «CVE» или «Идентификатор…» в первых 12 строках, объединяются; колонки по названию: «Краткое описание» или «Описание», «Обновить до…»; «Оценка» не читается;
- нет пакета или идентификатора — строка пропускается с сообщением; CVSS не число — **строка остаётся**, CVSS пустой, сообщение (сейчас строка отбрасывается);
- дата скана — `ГГГГ[_-.]ММ[_-.]ДД` в имени, правится в предпросмотре;
- `detectFormat` (одна кнопка импорта) — тоже по содержимому, а не по имени листа «Хосты».

**Ключ** — `norm(пакет) ␀ norm(идентификатор)` (как `dupKey`), одна запись на ключ в узле, хранится в `vuln_records.key_norm`. Повтор ключа в файле объединяется по максимуму «Обнаружений», счётчик повторов показывается в предпросмотре.

**Сравнение с узлом — расширение существующего механизма, а не второй.** `previewScan` и `applyScan` в `scan-import.service.ts` получают узел (`register_imports.payload.nodeId`) и вместо «новые / дубли» раскладывают строки по пяти группам. Из `compare.service.ts` берутся сохранение файла в `files` как доказательства и проверка охвата (`scanCoverage` обобщается: прошлый скан узла вместо отдела). Выбор по строкам — как в `CompareDialog`. Применение — одна транзакция с проверкой версий: если запись или поля изменились после предпросмотра, не применяется ничего (`IMPORT_STALE`).

| Группа | Условие | По умолчанию | При применении |
|---|---|---|---|
| Новые | ключа нет в узле | выбраны | создаётся запись + `vuln_records` (`deadline_scan` = этот скан), `notified` пусто |
| Повторно обнаружены | запись узла «Устранена» (`fixed`) | выбраны | статус «Открыта», `cycle + 1`, `deadline_scan` = этот скан, `notified`, `legacyDue`, `extDays` очищаются (в истории — было), `reopened_at` |
| Изменились | отличаются Уровень, CVSS, Эксплойт, Сетевой вектор, Обновить до версии, Обнаружений | выбраны | поля обновляются, «Исправление» и Критичность пересчитываются (ручная не трогается), история «было → стало»; если меняется срок — колонка «срок: было → станет» в предпросмотре |
| Без изменений | всё совпадает | — | `vuln_record_scans` «unchanged», `last_scan_id` |
| Пропали | открытая запись узла, которой нет в файле | не выбраны | выбранные — «Устранена» со ссылкой на скан; невыбранные остаются открытыми |

Невыбранные «Новые», «Повторно» и «Изменились» не применяются. В снимке скана они остаются, в `comparison` — с отметкой «не выбрано». Охват: «новые в охвате» и «выбыли из охвата» по имени хоста относительно прошлого скана узла. Если хосты выбыли — предупреждение у группы «Пропали», как сейчас «неполный скан». Импорт в «Без группы» — 409.

**Тест на образце** (`scan-parser.test.ts` + `vulns.db.test.ts`): 12 хостов, охват «Отдел платёжных карт», 90 находок с одного листа, 0 повторов, 1 идентификатор не CVE (`BDU:2025-01793`), 1 строка без CVSS (Оценка пустая, Критичность «Высокая»), Adobe Acrobat DC CVE-2026-34621 = 8,2, 7-Zip CVE-2025-0411 = 6,7, CVE-2023-44487 — две записи (два пакета), максимум «Обнаружений» 22. Первый импорт в пустой узел — 90 новых. Повторный импорт того же файла — 90 без изменений. Копию с правками тест собирает exceljs: удалена строка (пропала), изменён CVSS (изменилась), одна запись отмечена устранённой (повторно), повтор ключа (объединён по максимуму), второй лист находок (объединение), переименованные листы, CVSS «н/д» (строка осталась), даты `2026_10_15`, `2026.10.15`.

## 4. Сроки, передача ИКТ, продления

**Передача ИКТ** — `POST /vulns/scans/:id/handover` (`records.edit`): дата (не раньше даты скана, не позже сегодня), кому (по умолчанию «ОИКТ»), файл (необязательно). Один раз (409 при повторе, триггер). В одной транзакции: `notified` = дата у записей с `deadline_scan_id` = этот скан, `version + 1`, история «Отчёт передан ИКТ ДД.ММ, срок по процедуре: ДД.ММ», журнал. После неё запускаются автоматизации: если дата передачи давняя, просрочка видна сразу.

**Итоговый срок** — формула из п. 1.1. Ручная Критичность пересчитывает базу автоматически (`crit` в `values`). Повторные сканы срок не сдвигают: `deadline_scan_id` меняется только при повторном обнаружении. В карточке: база по процедуре (скан, дата передачи, дни) или «срок из прежнего реестра», каждое продление (зачёркнуто, если отменено), решение п. 7.3, итог.

**Продления** — право `vulns.deadlines`:
- `POST /vulns/extensions/preview` → кандидаты: открытые записи области с идущим сроком. Отдельно считаются не участвующие: с решением п. 7.3 и «не передано ИКТ». Ещё — уровни области (включая «Без уровня») и «было → станет» по строкам;
- `POST /vulns/extensions` — то же тело + обоснование (номер, дата ≤ сегодня, `basis_file_id` обязателен, комментарий) + `expected` (число строк). Сервер пересчитывает заново; разошлось — 409 `BULK_CHANGED` (ADR-0016). Одна транзакция: `vuln_extensions`, `vuln_extension_items` (`cycle` записи, было/стало), `extDays += дни`, `version + 1`, история «Срок продлён на N дн. (было → стало) по обоснованию ОИКТ № … от …», журнал;
- `POST /vulns/extensions/:id/cancel` — целиком, с подтверждением на странице: `extDays −= дни` только у строк текущего цикла записи, строки старых циклов не трогаются. В истории — «Продление … отменено, срок −N дн.», событие остаётся с «Отменено ДД.ММ.ГГГГ»;
- дни 0–365, только продление; «Только просроченные», «Только со сроком до <дата>»; область — узел или все узлы группы, в том числе «Без группы».

**Где сейчас считаются просрочка, уведомления и эскалации п. 7.4** (всё переходит на итоговый срок через `calcValue`, по всем узлам, потому что реестр один):
1. `lib/register-values.ts → calcValue` — единственная формула срока (меняется);
2. `registers/definition.ts → dateOf, deadlineState`, DTO записи;
3. `registers/filter.ts` — фильтр `deadline=overdue,soon`;
4. `registers/records.service.ts` — сортировка по сроку;
5. `registers/excel.service.ts` — колонка «Срок устранения» и «Дней до срока»;
6. `automations/conditions.ts` — `before` (за 3 дня ответственному и ДИКТ), `overdue` (ДИКТ и владельцу системы), `overdue + workdays 10 + unlessFilled measures` (эскалация руководству и начальнику ИБ); ключ события — дата срока, поэтому после продления новый срок даёт новое напоминание, а после отмены дубля нет;
7. `tasks/from-events.ts` — события в задачи;
8. `dashboard/service.ts` — KPI «Открытые», «Просроченные», «Ближайшие 7 дней», виджет «Контроль сроков»;
9. `monitor/service.ts → vulnsBlock` — корзины по дням, ближайшие даты; запись без срока попадает в «нет срока» — переименую корзину для уязвимостей в «Не передано ИКТ»;
10. frontend `pages/registers/logic.ts`, `RecordsTab` и слайды монитора — показывают то, что вернул backend.

Отдельно проверю тестами: продление снимает просрочку в KPI, мониторе и фильтре, а отмена возвращает; запись «Не передано ИКТ» не даёт событий п. 7.4.

## 5. Права

| Действие | Право |
|---|---|
| Просмотр раздела, групп, узлов, сканов, продлений | `ib.work` |
| Импорт скана, передача ИКТ, ручная Критичность, решение п. 7.3, «Перенести» из «Без группы» | `records.edit` |
| **Создать группу, «Добавить тип»** — предлагаю `registers.manage` | это настройка структуры, как создание реестра в конструкторе; у «Сотрудника ИБ» и «SOC» его нет. Альтернатива — `records.edit` |
| **Продление и отмена** — новое право `vulns.deadlines` «Уязвимости: изменение сроков» | никому не выдаётся, в том числе «Супер-администратору» (в `SYSTEM_ROLES` не добавляется, `PERMISSION_GRANTS` нет); назначается в матрице |

Код `vulns.deadlines`, а не `vuln.deadlines`: так совпадает с модулем `vulns` и с множественным числом остальных кодов (`records.*`, `tasks.*`, `docs.*`). Справочник «Типы систем» правится по `settings.manage`, как остальные.

## 6. Справочник «Типы систем»

`system_types` в `lib/catalogs.ts` (kind `values`, без цвета), стартовые значения — однократно в seed, как «Системы». Узел ссылается на значение по id, переименование ничего не ломает. «Используется ли значение» — через `modules/settings/usage.ts` (узлы): используемое значение только архивируется. Архивное значение не предлагается в «Создать группу» и «Добавить тип», существующие узлы остаются.

## 7. Выкладка

- **Номер — 1.5.0** (новая функция, новая модель данных). Порядок: 1.4.0 → 1.4.1 (цепочки задач) → 1.5.0. Ветка `feature/vulns-groups` от `v1.4.0`. Перед релизом её перебазирую на `v1.4.1`, и миграции 1.5.0 должны идти после миграций 1.4.1 по времени. Если 1.4.1 создаст миграции позже моих, сообщу до сборки: дату в имени неприменённой на проде миграции придётся сдвинуть, а это затрагивает dev-базу (п. 3.1 — с вашего подтверждения). Если 1.4.1 не будет готов, 1.5.0 выходит после 1.4.0, а цепочки задач становятся 1.5.1.
- **RELEASE.md** — `make-release.sh --from 1.1.0`: накопительно 1.2.0 → 1.5.0 одним `migrate`, миграции с колонкой «Релиз», сводки всех версий. Предпроверки 1.5.0 (запросы раздела 2) — по образцу `deploy/prechecks/1.4.0-from-1.1.0.md`. Вы запретили трогать `deploy/`, поэтому черновик положу в `docs/plans/` и спрошу, переносить ли его в `deploy/prechecks/` при сборке.
- **Откат на 1.1.0 (и на 1.4.0)** без отката базы. Новые таблицы не читаются. Правило срока читается без проверки схемы (`as CalcRule`), лишние ключи игнорируются. Незнакомое право не учитывается. Записи, созданные после отката, при повторном обновлении попадут в «Без группы» (повторяемый шаг). **Чем откат ухудшает работу** — это пойдёт в RELEASE.md:
  - продления не учитываются, срок уже, чем в 1.5.0, и правила п. 7.4 могут прислать «просрочено» по продлённым записям;
  - у записей из ещё не переданных сканов `notified` пуст, поэтому в 1.1.0 у них нет срока;
  - служебные поля в 1.1.0 редактируемы.
- **Проверка запуском**, как в 1.4.0: dev-база проходит путь 1.1.0 → 1.5.0 (миграции и seed), затем тесты `test:db` тега `v1.1.0` из отдельного worktree на этой схеме, и тесты 1.4.0 тоже. Ручной прогон 1.1.0: открыть реестр, импортировать образец, переобновиться и увидеть записи в «Без группы».

## 8. Противоречия, предложения, «Не делаем сейчас»

Нужны ваши решения (рекомендация — первой):
1. **Образец** называется `vuln-windows-2026-10-15.xlsx.xlsx`, в спецификации — `.xlsx`. Переименую при первом коммите.
2. **Календарные дни и перенос на рабочий день.** Спецификация и CLAUDE.md говорят «календарные дни», а код с этапа 4 переносит срок, попавший на выходной, на ближайший рабочий день (`shiftToWorkday`). Предлагаю оставить перенос, итог = перенос(база + продления). Прототип переноса не делает.
3. **«Риск принят»** (закрытый статус) в спецификации не упомянут. Предлагаю: такая запись в «Повторно» не попадает и остаётся закрытой, поля обновляются как в «Изменились» / «Без изменений», в «Пропали» не входит. В разделе — статус «Риск принят».
4. **Решение п. 7.3 при повторном обнаружении** — предлагаю снимать (значение остаётся в истории), иначе старое решение задаст срок новому циклу. Прототип его сохраняет.
5. **Первый скан не передан ИКТ, а следующий передан.** Буквально по спецификации срок записи так и не начнётся. Предлагаю: при передаче скана S записи из S, у которых срок ещё не начался, ведут срок от S. Поздняя передача первого скана их уже не сдвигает.
6. **Изменение CVSS или эксплойта при повторном скане** меняет Критичность и укорачивает или удлиняет срок — запись может стать просроченной сразу. Это следует из процедуры. В предпросмотре покажу «срок: было → станет», а строки, которые станут просроченными, — отдельной пометкой.
7. **Правило 6 раздела 7 CLAUDE.md** (дубли «CVE + пакет + отдел», отдел из A1) заменяется ключом узла. Поле «Отдел» новые импорты заполняют охватом скана: так 1.1.0 после отката ищет дубли осмысленно.
8. **Страница «Реестры» для реестра уязвимостей.** Предлагаю: создание записи, импорт отчёта сканера и «Сравнение с реестром» там отключить (409 и подсказка «в разделе «Уязвимости»»). Выгрузка и обратный импорт Excel по ID (правило 7, круг с ДИКТ), массовые действия и аналитика остаются и действуют на все узлы. Служебные поля при этом только для чтения. Иначе записи появятся вне узлов.
9. **«Система» при импорте.** От неё правило п. 7.4 находит владельца системы. В прототипе её нет. Предлагаю оставить необязательный выбор «Система» в окне импорта, как сейчас, иначе «владелец системы» не получит уведомлений по новым записям.
10. **Массовый перенос из «Без группы».** В спецификации кнопка на запись. На реальных данных записей может быть сотни, поэтому предлагаю добавить «Перенести выбранные» с тем же правилом отказа по ключу (по строке). Иначе — только по одной.
11. **Записи вручную в узле** спецификация не предусматривает, а ручная правка «Уведомлено ДИКТ» исчезает: это поле теперь ставит передача ИКТ. Если ручные записи нужны, их срок пойдёт от даты передачи, которую введут в карточке. Предлагаю не делать.
12. **Удаление записи** (`records.delete`, мягкое) освобождает ключ в узле (`key_norm = NULL`). Следующий скан создаст запись заново.
13. **Архив отчётов** (`scan-reports/:id/archive`) у новых сканов не делается: «скан не удаляется и не редактируется». У прежних архив остаётся только как пометка.

Что из раздела 9 спецификации («Не делаем сейчас») задевает план:
- **без привязки к хостам** «Пропали» нельзя отличить от «хост не сканировался». Поэтому группа по умолчанию не выбрана, и при выбывших хостах есть предупреждение;
- **без пометки скана ошибочным** применённый скан не откатить. Ошибку исправляют вручную: повторный импорт, статус, перенос. Это ещё один довод держать «Пропали» невыбранными;
- **без удаления и переименования групп** опечатка в названии останется навсегда. Предлагаю хотя бы переименование группы по `registers.manage` с журналом — или подтвердите, что не нужно. E2e на каждый прогон создаёт группу «E2E-…» в dev-базе, удалить её нельзя;
- **поля и автоматизации на уровне узла** не делаются: правила п. 7.4 общие для всех узлов, как сейчас;
- **«просрочено по процедуре»** отдельным счётчиком не делается: в карточке база видна, в KPI — только итог;
- **критичности системы у группы** нет: ручная Критичность остаётся на записи.

## 9. Коммиты и проверки

Ветка `feature/vulns-groups`. Перед каждым коммитом: `typecheck`, `lint`, `test` в затронутых пакетах, `test:db`; при миграции — `prisma migrate dev`, `check:schema`, `check:integrity`; при интерфейсе — `test:e2e`. Перед сборкой — два подряд чистых прогона e2e. Релиз не собираю до вашего «ок».

0. `docs:` CLAUDE.md (модули — `vulns` с группами, узлами, сканами и продлениями; право `vulns.deadlines`; раздел 7 — правила 3–6 и новое правило «Срок и продления»; этап 12 в разделе 12), `concept.md` (п. «Реестр уязвимостей»), ADR-0029 «Узлы группа × тип систем при одной структуре полей», ADR-0030 «Срок от передачи ИКТ и продления по обоснованию ОИКТ», CHANGELOG «Не выпущено», переименование образца.
1. `feat(vulns): справочник «Типы систем», группы и узлы` — миграция 1, seed справочника и «Без группы», API групп и узлов, права.
2. `feat(vulns): перенос прежнего реестра в «Без группы»` — служебные поля, правило срока (`baseFieldId`, `addDaysFieldId`), seed однократный и повторяемый, «Перенести», запрет записи служебных полей, `check-integrity`, черновик предпроверок.
3. `feat(vulns): разбор отчёта по содержимому и сравнение с узлом` — парсер, пять групп, охват, выбор, применение.
4. `feat(vulns): сканы и передача ИКТ` — экран скана (API), передача, срок от скана, повторное обнаружение.
5. `feat(vulns): продления сроков по обоснованию ОИКТ` — миграция 2, право `vulns.deadlines`, предпросмотр, применение, отмена.
6. `feat(vulns): раздел «Уязвимости» в интерфейсе` — дерево, «Все группы», группа, узел, скан, карточка, окна импорта, передачи, продления и переноса; ограничения на странице «Реестры»; перегенерация типов.
7. `feat(dashboard, monitor): итоговый срок по всем узлам` — корзина «Не передано ИКТ», проверки KPI и монитора.
8. `test(e2e): сценарий раздела` — перед сборкой.

**Тесты.**
- Unit: парсер на образце (числа п. 3) и на собранных копиях; `calcValue` — база, legacy, продления, п. 7.3 главнее, перенос на рабочий день, ручная Критичность; кандидаты продления и «было → станет»; отмена по циклу.
- DB: применение пяти групп с выбором, `IMPORT_STALE`; передача один раз (409, триггер); повторное обнаружение (цикл, очистка, срок от нового скана); продление и отмена (`extDays`, история, журнал, `BULK_CHANGED`); перенос (успех, отказ по ключу); seed на данных «как в 1.1.0» (числа вывода, `legacyDue` = прежний срок, история не тронута, повторяемый шаг); KPI, монитор и `overdue` по итоговому сроку; триггеры «только пополняется».
- API с двумя пользователями: «Сотрудник ИБ» (`ib.work`, `records.edit`) — смотрит, импортирует, передаёт, переносит; продление — 403, создать группу — 403. Второй — с `vulns.deadlines` и `registers.manage`: продлевает, отменяет, создаёт группу. Пользователь без `ib.work` — 403 на всё.
- E2e (новый `vulns.e2e.mjs` вместо прежнего): создать группу «E2E-…» с типом → импорт образца → предпросмотр (90 новых, охват 12) → загрузить → передать ИКТ → «Обновить сроки» (уровень «Важная» +30, обоснование с файлом) → было → станет → отмена → карточка записи (база, продление зачёркнуто, итог, сканы, история) → перенос записи из «Без группы». Записи в «Без группы» берутся из dev-данных: `seed:demo` (только `_dev`) добавит несколько записей «как из 1.1.0» с уникальными ключами. Создать их через API нельзя (п. 8.8), поэтому без них тест падает с понятным сообщением.
