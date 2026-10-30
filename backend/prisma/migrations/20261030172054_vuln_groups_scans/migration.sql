-- Релиз 1.5.0, шаг 1 (ADR-0029): раздел «Уязвимости» — группы, узлы «группа × тип систем», сканы, записи узлов.
-- Записи остаются строками системного реестра уязвимостей; принадлежность узлу — vuln_records (1 : 1).
-- Влияние на данные: пять новых пустых таблиц (vuln_groups, vuln_nodes, vuln_scans, vuln_records,
-- vuln_record_scans), индексы, проверки и триггеры на них; функция file_active_refs() заменяется — для прежних
-- таблиц результат тот же, добавлены ссылки vuln_scans.file_id и vuln_scans.handover_file_id. Существующие таблицы
-- и строки не меняются: затронуто 0 строк. Данные (группа «Без группы», перенос прежнего реестра) пишет seed.
-- Откат: backend 1.1.0–1.4.0 новые таблицы не читает; лишние ссылки в file_active_refs() только дольше держат файл
-- занятым.

-- CreateTable
CREATE TABLE "vuln_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "system_key" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "vuln_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vuln_nodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "system_type_id" UUID,
    "system_key" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vuln_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vuln_scans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "node_id" UUID NOT NULL,
    "import_id" UUID,
    "legacy_report_id" UUID,
    "file_id" UUID,
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "scan_date" DATE NOT NULL,
    "coverage_title" TEXT NOT NULL DEFAULT '',
    "hosts" JSONB NOT NULL DEFAULT '[]',
    "hosts_count" INTEGER NOT NULL DEFAULT 0,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "findings_count" INTEGER NOT NULL DEFAULT 0,
    "comparison" JSONB,
    "previous_scan_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handed_over_on" DATE,
    "handed_over_to" TEXT,
    "handover_file_id" UUID,
    "handed_over_by" UUID,
    "handed_over_at" TIMESTAMPTZ(3),

    CONSTRAINT "vuln_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vuln_records" (
    "record_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "key_norm" TEXT,
    "deadline_scan_id" UUID,
    "first_scan_id" UUID,
    "last_scan_id" UUID,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "reopened_at" TIMESTAMPTZ(3),
    "legacy" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vuln_records_pkey" PRIMARY KEY ("record_id")
);

-- CreateTable
CREATE TABLE "vuln_record_scans" (
    "record_id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "changes" JSONB,

    CONSTRAINT "vuln_record_scans_pkey" PRIMARY KEY ("record_id","scan_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vuln_groups_system_key_key" ON "vuln_groups"("system_key");

-- CreateIndex
CREATE UNIQUE INDEX "vuln_nodes_system_key_key" ON "vuln_nodes"("system_key");

-- CreateIndex
CREATE INDEX "vuln_nodes_group_id_idx" ON "vuln_nodes"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "vuln_scans_import_id_key" ON "vuln_scans"("import_id");

-- CreateIndex
CREATE UNIQUE INDEX "vuln_scans_legacy_report_id_key" ON "vuln_scans"("legacy_report_id");

-- CreateIndex
CREATE INDEX "vuln_scans_node_id_scan_date_created_at_idx" ON "vuln_scans"("node_id", "scan_date" DESC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "vuln_records_node_id_idx" ON "vuln_records"("node_id");

-- CreateIndex
CREATE INDEX "vuln_record_scans_scan_id_idx" ON "vuln_record_scans"("scan_id");

-- AddForeignKey
ALTER TABLE "vuln_groups" ADD CONSTRAINT "vuln_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_nodes" ADD CONSTRAINT "vuln_nodes_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "vuln_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_nodes" ADD CONSTRAINT "vuln_nodes_system_type_id_fkey" FOREIGN KEY ("system_type_id") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_nodes" ADD CONSTRAINT "vuln_nodes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_scans" ADD CONSTRAINT "vuln_scans_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "vuln_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_scans" ADD CONSTRAINT "vuln_scans_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "register_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_scans" ADD CONSTRAINT "vuln_scans_legacy_report_id_fkey" FOREIGN KEY ("legacy_report_id") REFERENCES "scan_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_scans" ADD CONSTRAINT "vuln_scans_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_scans" ADD CONSTRAINT "vuln_scans_previous_scan_id_fkey" FOREIGN KEY ("previous_scan_id") REFERENCES "vuln_scans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_scans" ADD CONSTRAINT "vuln_scans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_scans" ADD CONSTRAINT "vuln_scans_handover_file_id_fkey" FOREIGN KEY ("handover_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_scans" ADD CONSTRAINT "vuln_scans_handed_over_by_fkey" FOREIGN KEY ("handed_over_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_records" ADD CONSTRAINT "vuln_records_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "register_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_records" ADD CONSTRAINT "vuln_records_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "vuln_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_records" ADD CONSTRAINT "vuln_records_deadline_scan_id_fkey" FOREIGN KEY ("deadline_scan_id") REFERENCES "vuln_scans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_records" ADD CONSTRAINT "vuln_records_first_scan_id_fkey" FOREIGN KEY ("first_scan_id") REFERENCES "vuln_scans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_records" ADD CONSTRAINT "vuln_records_last_scan_id_fkey" FOREIGN KEY ("last_scan_id") REFERENCES "vuln_scans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_record_scans" ADD CONSTRAINT "vuln_record_scans_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "register_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_record_scans" ADD CONSTRAINT "vuln_record_scans_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "vuln_scans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Группа: название и вид; «Без группы» — единственная временная (system_key).
ALTER TABLE "vuln_groups"
  ADD CONSTRAINT "vuln_groups_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "vuln_groups_kind_check" CHECK ("kind" IN ('service', 'department', 'temporary')),
  ADD CONSTRAINT "vuln_groups_system_check" CHECK (("kind" = 'temporary') = ("system_key" IS NOT NULL));
CREATE UNIQUE INDEX "vuln_groups_name_uq" ON "vuln_groups" (lower(btrim("name")));

-- Узел: тип систем или системный «Из прежнего реестра»; один тип в группе — один узел.
ALTER TABLE "vuln_nodes"
  ADD CONSTRAINT "vuln_nodes_type_check" CHECK (("system_type_id" IS NULL) = ("system_key" IS NOT NULL));
CREATE UNIQUE INDEX "vuln_nodes_group_type_uq" ON "vuln_nodes" ("group_id", "system_type_id") WHERE "system_type_id" IS NOT NULL;

-- Скан: новый (импорт) или отчёт прежнего реестра; передача ИКТ — целиком и не раньше даты скана.
ALTER TABLE "vuln_scans"
  ADD CONSTRAINT "vuln_scans_source_check" CHECK (("import_id" IS NULL) <> ("legacy_report_id" IS NULL)),
  ADD CONSTRAINT "vuln_scans_handover_date_check" CHECK ("handed_over_on" IS NULL OR "handed_over_on" >= "scan_date"),
  ADD CONSTRAINT "vuln_scans_handover_check" CHECK (
    ("handed_over_on" IS NULL) = ("handed_over_by" IS NULL) AND ("handed_over_on" IS NULL) = ("handed_over_at" IS NULL)
    AND ("handed_over_on" IS NULL) = ("handed_over_to" IS NULL)
    AND ("handover_file_id" IS NULL OR "handed_over_on" IS NOT NULL)),
  ADD CONSTRAINT "vuln_scans_counts_check" CHECK ("hosts_count" >= 0 AND "findings_count" >= 0);

-- Скан не меняется; единственное изменение — передача ИКТ, один раз (из NULL в значение).
CREATE OR REPLACE FUNCTION vuln_scans_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  handover text[] := ARRAY['handed_over_on', 'handed_over_to', 'handover_file_id', 'handed_over_by', 'handed_over_at'];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."handed_over_on" IS NULL
     AND (to_jsonb(NEW) - handover) = (to_jsonb(OLD) - handover) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vuln_scans: скан не меняется, передача ИКТ — один раз (% запрещён)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER vuln_scans_guard BEFORE UPDATE OR DELETE ON "vuln_scans" FOR EACH ROW EXECUTE FUNCTION vuln_scans_guard();

-- Запись узла: один ключ в узле; цикл с единицы.
ALTER TABLE "vuln_records"
  ADD CONSTRAINT "vuln_records_cycle_check" CHECK ("cycle" >= 1),
  ADD CONSTRAINT "vuln_records_key_check" CHECK ("key_norm" IS NULL OR length("key_norm") > 1);
CREATE UNIQUE INDEX "vuln_records_node_key_uq" ON "vuln_records" ("node_id", "key_norm") WHERE "key_norm" IS NOT NULL;

-- Сканы записи — только пополняются.
ALTER TABLE "vuln_record_scans"
  ADD CONSTRAINT "vuln_record_scans_outcome_check" CHECK ("outcome" IN ('new', 'reopened', 'changed', 'unchanged', 'fixed', 'legacy')),
  ADD CONSTRAINT "vuln_record_scans_cycle_check" CHECK ("cycle" >= 1);
CREATE OR REPLACE FUNCTION vuln_record_scans_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vuln_record_scans только пополняется: % запрещён', TG_OP USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER vuln_record_scans_append_only BEFORE UPDATE OR DELETE ON "vuln_record_scans"
  FOR EACH ROW EXECUTE FUNCTION vuln_record_scans_append_only();

-- Роль приложения: группы, узлы, сканы и записи узлов не удаляются (раздел 3.4); сканы записи — только INSERT.
REVOKE DELETE, TRUNCATE ON "vuln_groups", "vuln_nodes", "vuln_scans", "vuln_records" FROM ibportal_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "vuln_record_scans" FROM ibportal_app;

-- Файл скана и файл передачи ИКТ — используемые, пока на них ссылается скан (сканы не удаляются).
CREATE OR REPLACE FUNCTION file_active_refs(f uuid) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT count(*) FROM "public"."register_decisions" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_versions" WHERE "pdf_file_id" = f)
       + (SELECT count(*) FROM "public"."evidence_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_record_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_imports" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."document_approvals" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."vuln_scans" WHERE "file_id" = f OR "handover_file_id" = f);
$$;
