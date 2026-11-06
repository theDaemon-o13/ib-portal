-- Релиз 1.11.0, шаг 4: механизмы контроля и автоматизации документов (ADR-0043, docs/plans/release-1.11.0-documents.md, раздел 5).
--
-- Влияние на данные: три новые пустые таблицы (document_controls, document_control_automations, document_control_runs);
-- в automation_events — новая колонка control_automation_id (NULL у всех существующих строк); ограничения
-- automation_events_subject_check и tasks_source_check — шире (существующие строки им соответствуют). Ни одна строка не
-- меняется (0 строк). Откат на 1.10.0 без отката базы: новые таблицы и колонку 1.10.0 не читает; события контроля
-- всегда сразу processed (CHECK) — прогоны 1.10.0 их не берут; задачи контроля для 1.10.0 — задачи с неизвестным
-- source (API задач с 1.9.0 принимает неизвестный source без ошибки).

-- AlterTable
ALTER TABLE "automation_events" ADD COLUMN     "control_automation_id" UUID;

-- CreateTable
CREATE TABLE "document_controls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "clause" TEXT NOT NULL DEFAULT '',
    "requirement" TEXT NOT NULL,
    "mechanism" TEXT NOT NULL,
    "check_method" TEXT NOT NULL DEFAULT '',
    "expected_evidence" TEXT NOT NULL DEFAULT '',
    "executor_unit" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_control_automations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "control_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "cadence" JSONB NOT NULL,
    "starts_on" DATE NOT NULL,
    "due_days" INTEGER NOT NULL,
    "due_kind" TEXT NOT NULL,
    "assignee_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "no_assignee_since" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_control_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_control_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "automation_id" UUID NOT NULL,
    "nominal_date" DATE NOT NULL,
    "planned_date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "task_id" UUID,
    "event_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_control_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_controls_document_id_position_idx" ON "document_controls"("document_id", "position");

-- CreateIndex
CREATE INDEX "document_control_automations_document_id_idx" ON "document_control_automations"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_control_runs_automation_id_nominal_date_key" ON "document_control_runs"("automation_id", "nominal_date");

-- AddForeignKey
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_control_automation_id_fkey" FOREIGN KEY ("control_automation_id") REFERENCES "document_control_automations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_controls" ADD CONSTRAINT "document_controls_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_controls" ADD CONSTRAINT "document_controls_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_control_automations" ADD CONSTRAINT "document_control_automations_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_control_automations" ADD CONSTRAINT "document_control_automations_control_id_fkey" FOREIGN KEY ("control_id") REFERENCES "document_controls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_control_automations" ADD CONSTRAINT "document_control_automations_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_control_automations" ADD CONSTRAINT "document_control_automations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_control_runs" ADD CONSTRAINT "document_control_runs_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "document_control_automations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_control_runs" ADD CONSTRAINT "document_control_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_control_runs" ADD CONSTRAINT "document_control_runs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "automation_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Дополнения вручную (Prisma их не описывает: CHECK, триггеры, права).
-- ---------------------------------------------------------------------------

ALTER TABLE "document_controls"
  ADD CONSTRAINT "document_controls_text_check" CHECK (
    length(btrim("requirement")) BETWEEN 1 AND 2000 AND length(btrim("mechanism")) BETWEEN 1 AND 4000
    AND length("clause") <= 300 AND length("check_method") <= 4000 AND length("expected_evidence") <= 4000 AND length("executor_unit") <= 300
  ),
  ADD CONSTRAINT "document_controls_position_check" CHECK ("position" >= 1);

ALTER TABLE "document_control_automations"
  ADD CONSTRAINT "document_control_automations_check" CHECK (
    length(btrim("title")) BETWEEN 1 AND 300 AND length("description") <= 4000
    AND "due_days" BETWEEN 1 AND 365 AND "due_kind" IN ('calendar', 'working')
    AND jsonb_typeof("cadence") = 'object' AND "cadence"->>'kind' IN ('daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'yearly')
  );

ALTER TABLE "document_control_runs"
  ADD CONSTRAINT "document_control_runs_status_check" CHECK (
    "status" IN ('created', 'skipped_late', 'no_assignee', 'doc_archived')
    AND ("status" = 'created') = ("task_id" IS NOT NULL)
    AND "planned_date" <= "nominal_date"
  );

-- Механизмы и автоматизации физически не удаляются — только active = false (как значения справочников).
REVOKE DELETE, TRUNCATE ON "public"."document_controls", "public"."document_control_automations" FROM ibportal_app;
CREATE FUNCTION document_controls_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: не удаляется — отключите (active = false)', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER document_controls_no_delete BEFORE DELETE ON "public"."document_controls"
  FOR EACH ROW EXECUTE FUNCTION document_controls_no_delete();
CREATE TRIGGER document_controls_no_truncate BEFORE TRUNCATE ON "public"."document_controls"
  FOR EACH STATEMENT EXECUTE FUNCTION document_controls_no_delete();
CREATE TRIGGER document_control_automations_no_delete BEFORE DELETE ON "public"."document_control_automations"
  FOR EACH ROW EXECUTE FUNCTION document_controls_no_delete();
CREATE TRIGGER document_control_automations_no_truncate BEFORE TRUNCATE ON "public"."document_control_automations"
  FOR EACH STATEMENT EXECUTE FUNCTION document_controls_no_delete();

-- Запуски только пополняются (как awareness_schedule_runs по смыслу и task_transitions по правилу).
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."document_control_runs" FROM ibportal_app;
CREATE FUNCTION document_control_runs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_control_runs: только пополняется (% запрещён)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER document_control_runs_append_only BEFORE UPDATE OR DELETE ON "public"."document_control_runs"
  FOR EACH ROW EXECUTE FUNCTION document_control_runs_append_only();
CREATE TRIGGER document_control_runs_no_truncate BEFORE TRUNCATE ON "public"."document_control_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION document_control_runs_append_only();

-- Событие контроля — без реестра, документа и доказательства; создаётся сразу обработанным (прогоны событий его не берут).
ALTER TABLE "public"."automation_events"
  DROP CONSTRAINT "automation_events_subject_check",
  ADD CONSTRAINT "automation_events_subject_check" CHECK (
    num_nonnulls("document_id", "evidence_id", "control_automation_id") <= 1
    AND ("document_id" IS NULL AND "evidence_id" IS NULL AND "control_automation_id" IS NULL) = ("register_id" IS NOT NULL AND "automation_id" IS NOT NULL)
    AND ("record_id" IS NULL OR "register_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "automation_events_control_processed_check" CHECK ("control_automation_id" IS NULL OR "status" = 'processed');
-- Одно событие на автоматизацию контроля и номинальную дату.
CREATE UNIQUE INDEX "automation_events_control_uq"
  ON "public"."automation_events" ("control_automation_id", "trigger_key") WHERE "control_automation_id" IS NOT NULL;

-- Задача контроля: source = 'document_control', документ — через document_control_runs.task_id (не tasks.document_id).
ALTER TABLE "public"."tasks"
  DROP CONSTRAINT "tasks_source_check",
  ADD CONSTRAINT "tasks_source_check" CHECK ("source" IN ('manual', 'mail', 'automation', 'document', 'evidence', 'document_control'));
