-- Этап 3 «Конструктор реестров»: реестры, поля, варианты списков, записи, решения другого отдела, импорт Excel.
--
-- Влияние на данные: создаются 6 новых пустых таблиц (registers, register_fields, register_field_options,
-- register_records, register_decisions, register_imports). Существующие таблицы не меняются, затронуто 0 строк.
-- Право registers.manage и стартовый «Реестр инцидентов» добавляет seed (однократно).
-- Совместима с backend предыдущей версии: он новые таблицы не читает. Откат приложения без отката базы.

-- CreateTable
CREATE TABLE "public"."registers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "owner_user_id" UUID,
    "system_key" TEXT,
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."register_fields" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "register_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "analytics_role" TEXT,
    "is_title" BOOLEAN NOT NULL DEFAULT false,
    "is_status" BOOLEAN NOT NULL DEFAULT false,
    "calc_rule" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "register_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."register_field_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "field_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "register_field_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."register_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "register_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "search_text" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "register_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."register_decisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "record_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "document_title" TEXT NOT NULL,
    "document_number" TEXT NOT NULL,
    "document_date" DATE NOT NULL,
    "file_id" UUID,
    "decided_by" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "register_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."register_imports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "register_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "register_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "registers_system_key_key" ON "public"."registers"("system_key");

-- CreateIndex
CREATE INDEX "register_fields_register_id_sort_order_idx" ON "public"."register_fields"("register_id", "sort_order");

-- CreateIndex
CREATE INDEX "register_field_options_field_id_sort_order_idx" ON "public"."register_field_options"("field_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "register_records_register_id_number_key" ON "public"."register_records"("register_id", "number");

-- CreateIndex
CREATE INDEX "register_decisions_record_id_field_id_decided_at_idx" ON "public"."register_decisions"("record_id", "field_id", "decided_at" DESC);

-- CreateIndex
CREATE INDEX "register_imports_register_id_created_at_idx" ON "public"."register_imports"("register_id", "created_at");

-- AddForeignKey
ALTER TABLE "public"."registers" ADD CONSTRAINT "registers_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_fields" ADD CONSTRAINT "register_fields_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "public"."registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_field_options" ADD CONSTRAINT "register_field_options_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "public"."register_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_records" ADD CONSTRAINT "register_records_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "public"."registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_decisions" ADD CONSTRAINT "register_decisions_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."register_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_decisions" ADD CONSTRAINT "register_decisions_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "public"."register_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_decisions" ADD CONSTRAINT "register_decisions_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "public"."register_field_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_decisions" ADD CONSTRAINT "register_decisions_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_imports" ADD CONSTRAINT "register_imports_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "public"."registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_imports" ADD CONSTRAINT "register_imports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Дополнения вручную (Prisma 6 их не описывает: CHECK, частичные индексы, индексы по выражению, права).
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."registers"
  ADD CONSTRAINT "registers_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "registers_next_number_check" CHECK ("next_number" >= 1);
-- Имя реестра уникально среди неархивных без учёта регистра.
CREATE UNIQUE INDEX "registers_name_uq" ON "public"."registers" (lower("name")) WHERE "archived_at" IS NULL;

ALTER TABLE "public"."register_fields"
  ADD CONSTRAINT "register_fields_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "register_fields_type_check"
    CHECK ("type" IN ('text', 'select', 'number', 'date', 'user', 'calc', 'decision')),
  -- Роль для аналитики совместима с типом поля (как в прототипе).
  ADD CONSTRAINT "register_fields_analytics_check" CHECK (
    "analytics_role" IS NULL
    OR ("type" IN ('select', 'decision', 'user') AND "analytics_role" = 'dimension')
    OR ("type" = 'number' AND "analytics_role" = 'metric')
    OR ("type" IN ('date', 'calc') AND "analytics_role" IN ('date', 'deadline'))
  ),
  ADD CONSTRAINT "register_fields_title_check" CHECK (NOT "is_title" OR "type" = 'text'),
  ADD CONSTRAINT "register_fields_status_check" CHECK (NOT "is_status" OR "type" = 'select'),
  -- Правило вычисления есть только у вычисляемого поля и обязательно у него.
  ADD CONSTRAINT "register_fields_calc_check" CHECK (("type" = 'calc') = ("calc_rule" IS NOT NULL));

CREATE UNIQUE INDEX "register_fields_label_uq"
  ON "public"."register_fields" ("register_id", lower("label")) WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "register_fields_title_uq"
  ON "public"."register_fields" ("register_id") WHERE "is_title" AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "register_fields_status_uq"
  ON "public"."register_fields" ("register_id") WHERE "is_status" AND "deleted_at" IS NULL;

ALTER TABLE "public"."register_field_options"
  ADD CONSTRAINT "register_field_options_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX "register_field_options_label_uq"
  ON "public"."register_field_options" ("field_id", lower("label")) WHERE "deleted_at" IS NULL;

ALTER TABLE "public"."register_records"
  ADD CONSTRAINT "register_records_number_check" CHECK ("number" >= 1),
  ADD CONSTRAINT "register_records_values_check" CHECK (jsonb_typeof("values") = 'object');
CREATE INDEX "register_records_list_idx"
  ON "public"."register_records" ("register_id", "number" DESC) WHERE "deleted_at" IS NULL;

ALTER TABLE "public"."register_decisions"
  ADD CONSTRAINT "register_decisions_document_check"
    CHECK (length(btrim("document_title")) > 0 AND length(btrim("document_number")) > 0);

ALTER TABLE "public"."register_imports"
  ADD CONSTRAINT "register_imports_status_check" CHECK ("status" IN ('preview', 'applied', 'cancelled', 'expired'));

-- Решения другого отдела только пополняются (как audit_log): история решений не переписывается.
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."register_decisions" FROM ibportal_app;

CREATE FUNCTION register_decisions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'register_decisions только пополняется: % запрещён', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER register_decisions_no_update_delete
  BEFORE UPDATE OR DELETE ON "public"."register_decisions"
  FOR EACH ROW EXECUTE FUNCTION register_decisions_append_only();

CREATE TRIGGER register_decisions_no_truncate
  BEFORE TRUNCATE ON "public"."register_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION register_decisions_append_only();
