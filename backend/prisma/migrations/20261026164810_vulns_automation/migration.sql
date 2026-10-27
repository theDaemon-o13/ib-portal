-- Этап 4 «Реестр уязвимостей»: системные поля и значения, ручные правки полей, импорт отчёта сканера
-- (scan_reports, scan_hosts), автоматизации «условие → действие» и их события.
--
-- Влияние на данные: создаются 4 новые пустые таблицы (scan_reports, scan_hosts, register_automations,
-- automation_events). В существующие таблицы добавляются 4 колонки, значения существующих строк не меняются:
--   register_fields.system_key, register_field_options.system_key — NULL (поля и значения не системные);
--   register_records.manual_field_ids — '{}' (ручных правок нет);
--   register_imports.kind — 'records' (все прежние импорты — обычные).
-- ADD COLUMN с константой по умолчанию в PostgreSQL 16 не переписывает таблицу. Затронуто 0 строк данных.
-- Реестр уязвимостей и его системные правила добавляет seed (однократно).
-- Совместима с backend предыдущей версии: он новые колонки и таблицы не читает, а значения по умолчанию
-- подходят его вставкам. Откат приложения без отката базы.

-- AlterTable
ALTER TABLE "public"."register_field_options" ADD COLUMN     "system_key" TEXT;

-- AlterTable
ALTER TABLE "public"."register_fields" ADD COLUMN     "system_key" TEXT;

-- AlterTable
ALTER TABLE "public"."register_imports" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'records';

-- AlterTable
ALTER TABLE "public"."register_records" ADD COLUMN     "manual_field_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "public"."scan_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "register_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "report_date" DATE NOT NULL,
    "notified_date" DATE NOT NULL,
    "department" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL,
    "rows_total" INTEGER NOT NULL,
    "created_count" INTEGER NOT NULL,
    "merged_count" INTEGER NOT NULL,
    "hosts_count" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "scan_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."scan_hosts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "os" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "scan_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."register_automations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "register_id" UUID NOT NULL,
    "system_key" TEXT,
    "condition" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "register_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."automation_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "register_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "automation_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "recipients" JSONB NOT NULL,
    "trigger_key" TEXT NOT NULL,
    "fire_at" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "processed_at" TIMESTAMPTZ(3),
    "processed_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scan_reports_import_id_key" ON "public"."scan_reports"("import_id");

-- CreateIndex
CREATE INDEX "scan_reports_register_id_report_date_idx" ON "public"."scan_reports"("register_id", "report_date");

-- CreateIndex
CREATE INDEX "scan_hosts_report_id_sort_order_idx" ON "public"."scan_hosts"("report_id", "sort_order");

-- CreateIndex
CREATE INDEX "register_automations_register_id_idx" ON "public"."register_automations"("register_id");

-- CreateIndex
CREATE INDEX "automation_events_register_id_status_created_at_idx" ON "public"."automation_events"("register_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "automation_events_record_id_idx" ON "public"."automation_events"("record_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_events_automation_id_record_id_trigger_key_key" ON "public"."automation_events"("automation_id", "record_id", "trigger_key");

-- AddForeignKey
ALTER TABLE "public"."scan_reports" ADD CONSTRAINT "scan_reports_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "public"."registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."scan_reports" ADD CONSTRAINT "scan_reports_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "public"."register_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."scan_reports" ADD CONSTRAINT "scan_reports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."scan_hosts" ADD CONSTRAINT "scan_hosts_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."scan_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_automations" ADD CONSTRAINT "register_automations_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "public"."registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_automations" ADD CONSTRAINT "register_automations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."automation_events" ADD CONSTRAINT "automation_events_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "public"."registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."automation_events" ADD CONSTRAINT "automation_events_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."register_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."automation_events" ADD CONSTRAINT "automation_events_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "public"."register_automations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."automation_events" ADD CONSTRAINT "automation_events_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Дополнения вручную (Prisma 6 их не описывает: CHECK, частичные индексы).
-- ---------------------------------------------------------------------------

-- Prisma создаёт массив допускающим NULL; пустой список — единственное «нет ручных правок».
ALTER TABLE "public"."register_records"
  ADD CONSTRAINT "register_records_manual_field_ids_check" CHECK ("manual_field_ids" IS NOT NULL);

ALTER TABLE "public"."register_imports"
  ADD CONSTRAINT "register_imports_kind_check" CHECK ("kind" IN ('records', 'scan'));

-- Системный ключ уникален в пределах реестра (поля) и поля (значения); удалённые не учитываются.
CREATE UNIQUE INDEX "register_fields_system_key_uq"
  ON "public"."register_fields" ("register_id", "system_key") WHERE "system_key" IS NOT NULL AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "register_field_options_system_key_uq"
  ON "public"."register_field_options" ("field_id", "system_key") WHERE "system_key" IS NOT NULL AND "deleted_at" IS NULL;

ALTER TABLE "public"."scan_reports"
  ADD CONSTRAINT "scan_reports_counts_check"
    CHECK ("rows_total" >= 0 AND "created_count" >= 0 AND "merged_count" >= 0 AND "hosts_count" >= 0);

ALTER TABLE "public"."register_automations"
  ADD CONSTRAINT "register_automations_condition_check" CHECK (jsonb_typeof("condition") = 'object'),
  ADD CONSTRAINT "register_automations_action_check" CHECK (jsonb_typeof("action") = 'object');
CREATE UNIQUE INDEX "register_automations_system_key_uq"
  ON "public"."register_automations" ("register_id", "system_key") WHERE "system_key" IS NOT NULL;

ALTER TABLE "public"."automation_events"
  ADD CONSTRAINT "automation_events_type_check" CHECK ("event_type" IN ('remind', 'notify', 'escalate')),
  ADD CONSTRAINT "automation_events_status_check" CHECK ("status" IN ('new', 'processed')),
  ADD CONSTRAINT "automation_events_recipients_check" CHECK (jsonb_typeof("recipients") = 'array'),
  ADD CONSTRAINT "automation_events_processed_check"
    CHECK (("status" = 'processed') = ("processed_at" IS NOT NULL));
