-- Этап 2 «Настройки»: справочники, производственный календарь, шаблоны форм,
-- поля пользователей, версии для защиты от одновременной правки, срок действия пароля.
--
-- Влияние на данные:
--   * Новые таблицы catalogs, catalog_items, work_calendar_days, app_settings, seed_markers,
--     form_templates, form_template_fields — создаются пустыми (заполняет seed).
--   * users: новые колонки position, department (''), version (1); значения по умолчанию
--     константные, PostgreSQL 16 не перезаписывает таблицу. roles: новая колонка version (1).
--   * users.password_changed_at становится NOT NULL DEFAULT now(). Строки с NULL заполняются
--     датой создания учётной записи (UPDATE ... WHERE password_changed_at IS NULL): если запись
--     старше 90 дней, пароль придётся сменить при следующем входе (срок действия пароля).
--     В dev затронуто 0 строк из 2; на сервере — столько, сколько записей с NULL (0.1.0 заполняет
--     колонку при create-admin и смене пароля, поэтому ожидается 0).
--   * Удалений и переименований нет. Совместима с backend 0.1.0: он новые колонки и таблицы
--     не читает, а при создании пользователя всегда задаёт password_changed_at.
--   * Откат приложения на 0.1.0 не требует отката базы.

-- Срок действия пароля: заполнить пустые значения до NOT NULL.
UPDATE "public"."users" SET "password_changed_at" = "created_at" WHERE "password_changed_at" IS NULL;

-- AlterTable
ALTER TABLE "public"."roles" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "department" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "position" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "password_changed_at" SET NOT NULL,
ALTER COLUMN "password_changed_at" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "public"."catalogs" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "has_color" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "catalogs_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "public"."catalog_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "catalog_code" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "color" TEXT,
    "system_key" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "owner_user_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."work_calendar_days" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "work_calendar_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "public"."seed_markers" (
    "key" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seed_markers_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "public"."form_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT '',
    "valid_months" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "form_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."form_template_fields" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "check_kind" TEXT NOT NULL,
    "threshold" DECIMAL(14,2),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "form_template_fields_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_items_catalog_code_sort_order_idx" ON "public"."catalog_items"("catalog_code", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_catalog_code_system_key_key" ON "public"."catalog_items"("catalog_code", "system_key");

-- CreateIndex
CREATE INDEX "work_calendar_days_day_idx" ON "public"."work_calendar_days"("day");

-- CreateIndex
CREATE INDEX "form_template_fields_template_id_sort_order_idx" ON "public"."form_template_fields"("template_id", "sort_order");

-- AddForeignKey
ALTER TABLE "public"."catalog_items" ADD CONSTRAINT "catalog_items_catalog_code_fkey" FOREIGN KEY ("catalog_code") REFERENCES "public"."catalogs"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."catalog_items" ADD CONSTRAINT "catalog_items_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."form_template_fields" ADD CONSTRAINT "form_template_fields_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."form_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Дополнения вручную (Prisma 6 их не описывает: CHECK, частичные индексы и индексы по выражению).
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."catalogs" ADD CONSTRAINT "catalogs_kind_check"
  CHECK ("kind" IN ('values', 'statuses', 'mail_rules'));

ALTER TABLE "public"."catalog_items"
  ADD CONSTRAINT "catalog_items_value_check" CHECK (length(btrim("value")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "catalog_items_color_check"
    CHECK ("color" IS NULL OR "color" IN ('accent', 'info', 'low', 'high', 'med', 'crit', 'muted')),
  -- Системное значение не архивируется и не удаляется.
  ADD CONSTRAINT "catalog_items_system_check"
    CHECK (NOT "is_system" OR ("archived_at" IS NULL AND "deleted_at" IS NULL));

-- Значение уникально в справочнике без учёта регистра среди неудалённых.
CREATE UNIQUE INDEX "catalog_items_value_uq"
  ON "public"."catalog_items" ("catalog_code", lower("value")) WHERE "deleted_at" IS NULL;

ALTER TABLE "public"."work_calendar_days"
  ADD CONSTRAINT "work_calendar_days_kind_check" CHECK ("kind" IN ('holiday', 'workday')),
  ADD CONSTRAINT "work_calendar_days_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200);

-- Одна запись на дату среди неудалённых.
CREATE UNIQUE INDEX "work_calendar_days_day_uq"
  ON "public"."work_calendar_days" ("day") WHERE "deleted_at" IS NULL;

ALTER TABLE "public"."form_templates"
  ADD CONSTRAINT "form_templates_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 300),
  ADD CONSTRAINT "form_templates_valid_months_check" CHECK ("valid_months" BETWEEN 1 AND 120);

CREATE UNIQUE INDEX "form_templates_name_uq"
  ON "public"."form_templates" (lower("name")) WHERE "deleted_at" IS NULL;

ALTER TABLE "public"."form_template_fields"
  ADD CONSTRAINT "form_template_fields_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 300),
  ADD CONSTRAINT "form_template_fields_kind_check" CHECK ("check_kind" IN ('min', 'max', 'yes', 'text')),
  -- Порог обязателен для «не менее» и «не более» и отсутствует у остальных.
  ADD CONSTRAINT "form_template_fields_threshold_check"
    CHECK (("check_kind" IN ('min', 'max')) = ("threshold" IS NOT NULL));
