-- Продления сроков уязвимостей по обоснованию ОИКТ (релиз 1.5.0, ADR-0030).
-- Влияние на данные: две новые пустые таблицы (vuln_extensions, vuln_extension_items), затронуто 0 строк, существующие
-- таблицы не меняются. Функция file_active_refs() заменяется: для существующих таблиц результат тот же, добавлена ссылка
-- vuln_extensions.basis_file_id. Откат: 1.1.0–1.4.0 новые таблицы не читают.

-- CreateTable
CREATE TABLE "vuln_extensions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "node_id" UUID,
    "group_id" UUID,
    "days_by_level" JSONB NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "basis_number" TEXT NOT NULL,
    "basis_date" DATE NOT NULL,
    "basis_file_id" UUID NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "records_count" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,

    CONSTRAINT "vuln_extensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vuln_extension_items" (
    "extension_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "days" INTEGER NOT NULL,
    "due_before" DATE NOT NULL,
    "due_after" DATE NOT NULL,

    CONSTRAINT "vuln_extension_items_pkey" PRIMARY KEY ("extension_id","record_id")
);

-- CreateIndex
CREATE INDEX "vuln_extensions_node_id_idx" ON "vuln_extensions"("node_id");

-- CreateIndex
CREATE INDEX "vuln_extensions_group_id_idx" ON "vuln_extensions"("group_id");

-- CreateIndex
CREATE INDEX "vuln_extension_items_record_id_idx" ON "vuln_extension_items"("record_id");

-- AddForeignKey
ALTER TABLE "vuln_extensions" ADD CONSTRAINT "vuln_extensions_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "vuln_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_extensions" ADD CONSTRAINT "vuln_extensions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "vuln_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_extensions" ADD CONSTRAINT "vuln_extensions_basis_file_id_fkey" FOREIGN KEY ("basis_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_extensions" ADD CONSTRAINT "vuln_extensions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_extensions" ADD CONSTRAINT "vuln_extensions_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_extension_items" ADD CONSTRAINT "vuln_extension_items_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "vuln_extensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_extension_items" ADD CONSTRAINT "vuln_extension_items_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "register_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Проверки.
ALTER TABLE "vuln_extensions"
  ADD CONSTRAINT "vuln_extensions_scope_check" CHECK (("node_id" IS NULL) <> ("group_id" IS NULL)),
  ADD CONSTRAINT "vuln_extensions_basis_number_check" CHECK (length(btrim("basis_number")) BETWEEN 1 AND 100),
  ADD CONSTRAINT "vuln_extensions_comment_check" CHECK (length("comment") <= 2000),
  ADD CONSTRAINT "vuln_extensions_records_check" CHECK ("records_count" > 0),
  ADD CONSTRAINT "vuln_extensions_cancel_check" CHECK (("cancelled_at" IS NULL) = ("cancelled_by" IS NULL));
ALTER TABLE "vuln_extension_items"
  ADD CONSTRAINT "vuln_extension_items_days_check" CHECK ("days" BETWEEN 1 AND 365),
  ADD CONSTRAINT "vuln_extension_items_cycle_check" CHECK ("cycle" >= 1),
  ADD CONSTRAINT "vuln_extension_items_due_check" CHECK ("due_after" > "due_before");

-- Продление не меняется: только однократная отмена.
CREATE OR REPLACE FUNCTION vuln_extensions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cancel text[] := ARRAY['cancelled_at', 'cancelled_by'];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."cancelled_at" IS NULL
     AND (to_jsonb(NEW) - cancel) = (to_jsonb(OLD) - cancel) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vuln_extensions: продление не меняется, отмена — один раз (% запрещён)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER vuln_extensions_guard BEFORE UPDATE OR DELETE ON "vuln_extensions" FOR EACH ROW EXECUTE FUNCTION vuln_extensions_guard();

CREATE OR REPLACE FUNCTION vuln_extension_items_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vuln_extension_items только пополняется: % запрещён', TG_OP USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER vuln_extension_items_append_only BEFORE UPDATE OR DELETE ON "vuln_extension_items"
  FOR EACH ROW EXECUTE FUNCTION vuln_extension_items_append_only();

-- Роль приложения.
REVOKE DELETE, TRUNCATE ON "vuln_extensions" FROM ibportal_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "vuln_extension_items" FROM ibportal_app;

-- Файл обоснования — используемый, пока на него ссылается продление.
CREATE OR REPLACE FUNCTION file_active_refs(f uuid) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT count(*) FROM "public"."register_decisions" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_versions" WHERE "pdf_file_id" = f)
       + (SELECT count(*) FROM "public"."evidence_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_record_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_imports" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."document_approvals" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."vuln_scans" WHERE "file_id" = f OR "handover_file_id" = f)
       + (SELECT count(*) FROM "public"."vuln_extensions" WHERE "basis_file_id" = f);
$$;
