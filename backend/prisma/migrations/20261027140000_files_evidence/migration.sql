-- Этап 7: файлы, доказательная база, решения другого отдела с документом, итоговый PDF версии документа
-- (CLAUDE.md 3.7, ADR-0011).
--
-- Влияние на данные: создаются 3 новые пустые таблицы (files, evidence, evidence_files). В существующие таблицы
-- добавляются колонки со значением NULL, значения существующих строк не меняются:
--   register_decisions.review_due — «Пересмотр до» по документу другого отдела;
--   document_versions.pdf_file_id — итоговый PDF версии (у утверждённых до этапа 7 остаётся NULL —
--     «текст не зафиксирован», задним числом PDF не прикладывается);
--   document_approvals.pdf_sha256 — какой PDF согласован (у прежних решений NULL; append-only не нарушается:
--     ADD COLUMN не переписывает строки);
--   automation_events.evidence_id, tasks.evidence_id, tasks.evidence_reason — события и задачи доказательств.
-- register_decisions.file_id становится NOT NULL с внешним ключом на files. Решений до этапа 7 вносить было
-- нечем (маршрута не было): на dev — 0 строк. Если строка без файла всё же есть, миграция останавливается с
-- ошибкой и ничего не меняет.
-- automation_events_subject_check и tasks_source_check пересоздаются с более широкими условиями; существующие
-- строки им соответствуют. Затронуто 0 строк данных.
-- Совместима с backend предыдущей версии: он решений не вставляет, новые таблицы не читает; события
-- доказательств обрабатываются в той же транзакции, где созданы, поэтому его выборка событий в статусе 'new'
-- их не видит. Откат приложения без отката базы.

-- AlterTable
ALTER TABLE "public"."automation_events" ADD COLUMN     "evidence_id" UUID;

-- AlterTable
ALTER TABLE "public"."document_approvals" ADD COLUMN     "pdf_sha256" CHAR(64);

-- AlterTable
ALTER TABLE "public"."document_versions" ADD COLUMN     "pdf_file_id" UUID;

-- AlterTable
ALTER TABLE "public"."register_decisions" ADD COLUMN     "review_due" DATE;

-- Решение без файла после этапа 7 невозможно: проверить, что таких строк нет, до NOT NULL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."register_decisions" WHERE "file_id" IS NULL) THEN
    RAISE EXCEPTION 'register_decisions: есть решения без файла документа — миграция остановлена, данные не изменены';
  END IF;
END;
$$;
ALTER TABLE "public"."register_decisions" ALTER COLUMN "file_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "public"."tasks" ADD COLUMN     "evidence_id" UUID,
ADD COLUMN     "evidence_reason" TEXT;

-- CreateTable
CREATE TABLE "public"."files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "storage_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by" UUID,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "record_id" UUID,
    "document_id" UUID,
    "system_item_id" UUID,
    "template_id" UUID,
    "checks" JSONB,
    "decision_id" UUID,
    "confirmed_by" TEXT NOT NULL DEFAULT '',
    "owner_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "valid_until" DATE,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_comment" TEXT NOT NULL DEFAULT '',
    "uploaded_by" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."evidence_files" (
    "evidence_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,

    CONSTRAINT "evidence_files_pkey" PRIMARY KEY ("evidence_id","file_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "public"."files"("storage_key");

-- CreateIndex
CREATE INDEX "files_uploaded_by_uploaded_at_idx" ON "public"."files"("uploaded_by", "uploaded_at");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_number_key" ON "public"."evidence"("number");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_decision_id_key" ON "public"."evidence"("decision_id");

-- CreateIndex
CREATE INDEX "evidence_record_id_idx" ON "public"."evidence"("record_id");

-- CreateIndex
CREATE INDEX "evidence_document_id_idx" ON "public"."evidence"("document_id");

-- CreateIndex
CREATE INDEX "evidence_system_item_id_template_id_idx" ON "public"."evidence"("system_item_id", "template_id");

-- CreateIndex
CREATE INDEX "evidence_status_valid_until_idx" ON "public"."evidence"("status", "valid_until");

-- CreateIndex
CREATE INDEX "evidence_files_file_id_idx" ON "public"."evidence_files"("file_id");

-- CreateIndex
CREATE INDEX "tasks_evidence_id_idx" ON "public"."tasks"("evidence_id");

-- AddForeignKey
ALTER TABLE "public"."register_decisions" ADD CONSTRAINT "register_decisions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."automation_events" ADD CONSTRAINT "automation_events_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_versions" ADD CONSTRAINT "document_versions_pdf_file_id_fkey" FOREIGN KEY ("pdf_file_id") REFERENCES "public"."files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."files" ADD CONSTRAINT "files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."files" ADD CONSTRAINT "files_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence" ADD CONSTRAINT "evidence_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."register_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence" ADD CONSTRAINT "evidence_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence" ADD CONSTRAINT "evidence_system_item_id_fkey" FOREIGN KEY ("system_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence" ADD CONSTRAINT "evidence_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."form_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence" ADD CONSTRAINT "evidence_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "public"."register_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence" ADD CONSTRAINT "evidence_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence" ADD CONSTRAINT "evidence_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence" ADD CONSTRAINT "evidence_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence_files" ADD CONSTRAINT "evidence_files_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence_files" ADD CONSTRAINT "evidence_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence_files" ADD CONSTRAINT "evidence_files_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."evidence_files" ADD CONSTRAINT "evidence_files_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Дополнения вручную (Prisma 6 их не описывает: CHECK, частичные индексы, триггеры, права).
-- ---------------------------------------------------------------------------

-- Файлы: путь без исходного имени, разрешённые типы (по содержимому), 25 МБ.
ALTER TABLE "public"."files"
  ADD CONSTRAINT "files_storage_key_check" CHECK ("storage_key" ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  ADD CONSTRAINT "files_name_check" CHECK (length(btrim("original_name")) BETWEEN 1 AND 255),
  ADD CONSTRAINT "files_mime_check" CHECK ("mime" IN (
    'application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  ADD CONSTRAINT "files_size_check" CHECK ("size" BETWEEN 1 AND 26214400),
  ADD CONSTRAINT "files_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  -- Удаляет пользователь или часовой прогон (непривязанный файл старше суток, автор — система).
  ADD CONSTRAINT "files_deleted_check" CHECK ("deleted_by" IS NULL OR "deleted_at" IS NOT NULL);

-- Действующие ссылки на файл: решение другого отдела, PDF версии документа, файл доказательства.
CREATE FUNCTION file_active_refs(f uuid) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT count(*) FROM "public"."register_decisions" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_versions" WHERE "pdf_file_id" = f)
       + (SELECT count(*) FROM "public"."evidence_files" WHERE "file_id" = f AND "removed_at" IS NULL);
$$;

-- Файлы не удаляются; содержимое и метаданные не меняются; отметка «удалён» — только без ссылок и один раз.
REVOKE DELETE, TRUNCATE ON "public"."files" FROM ibportal_app;

CREATE FUNCTION files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'files: файлы не удаляются (% запрещён)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."storage_key" <> OLD."storage_key" OR NEW."original_name" <> OLD."original_name"
     OR NEW."mime" <> OLD."mime" OR NEW."size" <> OLD."size" OR NEW."sha256" <> OLD."sha256"
     OR NEW."uploaded_by" <> OLD."uploaded_by" OR NEW."uploaded_at" <> OLD."uploaded_at" THEN
    RAISE EXCEPTION 'files: содержимое и метаданные файла не меняются' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."deleted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'files: удалённый файл не меняется' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."deleted_at" IS NOT NULL AND file_active_refs(NEW."id") > 0 THEN
    RAISE EXCEPTION 'files: на файл есть ссылки — он не удаляется' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER files_guard
  BEFORE UPDATE OR DELETE ON "public"."files"
  FOR EACH ROW EXECUTE FUNCTION files_guard();

CREATE TRIGGER files_no_truncate
  BEFORE TRUNCATE ON "public"."files"
  FOR EACH STATEMENT EXECUTE FUNCTION files_guard();

-- Новая ссылка — только на неудалённый файл. FOR SHARE: отметка «удалён» из параллельной транзакции
-- дождётся этой и увидит ссылку.
CREATE FUNCTION file_ref_alive() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fid uuid;
  gone timestamptz;
BEGIN
  fid := CASE TG_TABLE_NAME WHEN 'document_versions' THEN NEW."pdf_file_id" ELSE NEW."file_id" END;
  IF fid IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "deleted_at" INTO gone FROM "public"."files" WHERE "id" = fid FOR SHARE;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION 'files: файл удалён — ссылаться на него нельзя' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER register_decisions_file_alive
  BEFORE INSERT ON "public"."register_decisions"
  FOR EACH ROW EXECUTE FUNCTION file_ref_alive();
CREATE TRIGGER evidence_files_file_alive
  BEFORE INSERT ON "public"."evidence_files"
  FOR EACH ROW EXECUTE FUNCTION file_ref_alive();
CREATE TRIGGER document_versions_pdf_alive
  BEFORE INSERT OR UPDATE OF "pdf_file_id" ON "public"."document_versions"
  FOR EACH ROW EXECUTE FUNCTION file_ref_alive();

ALTER TABLE "public"."document_approvals"
  ADD CONSTRAINT "document_approvals_pdf_sha256_check" CHECK ("pdf_sha256" IS NULL OR "pdf_sha256" ~ '^[0-9a-f]{64}$');

-- Доказательство: ровно один объект; форма — со снимком шаблона; решение — со ссылкой на решение.
ALTER TABLE "public"."evidence"
  ADD CONSTRAINT "evidence_number_check" CHECK ("number" >= 1),
  ADD CONSTRAINT "evidence_kind_check" CHECK ("kind" IN ('form', 'decision', 'file')),
  ADD CONSTRAINT "evidence_status_check" CHECK ("status" IN ('pending', 'accepted', 'rejected')),
  ADD CONSTRAINT "evidence_subject_check" CHECK (num_nonnulls("record_id", "document_id", "system_item_id") = 1),
  ADD CONSTRAINT "evidence_form_check" CHECK (
    ("kind" = 'form') = ("template_id" IS NOT NULL) AND ("template_id" IS NULL) = ("checks" IS NULL)
    AND ("checks" IS NULL OR jsonb_typeof("checks") = 'array')
  ),
  ADD CONSTRAINT "evidence_decision_check" CHECK (("kind" = 'decision') = ("decision_id" IS NOT NULL)),
  ADD CONSTRAINT "evidence_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 300),
  ADD CONSTRAINT "evidence_confirmed_by_check" CHECK (length("confirmed_by") <= 300),
  ADD CONSTRAINT "evidence_review_check" CHECK (
    ("status" = 'pending') = ("reviewed_at" IS NULL) AND ("reviewed_at" IS NULL) = ("reviewed_by" IS NULL)
    AND length("review_comment") <= 4000
    AND ("status" <> 'rejected' OR length(btrim("review_comment")) >= 1)
  );

-- Доказательства не удаляются физически (мягкое удаление — deleted_at); снимок формы, объект и автор не меняются.
REVOKE DELETE, TRUNCATE ON "public"."evidence" FROM ibportal_app;

CREATE FUNCTION evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'evidence: доказательства не удаляются (% запрещён)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."kind" <> OLD."kind" OR NEW."template_id" IS DISTINCT FROM OLD."template_id"
     OR NEW."checks" IS DISTINCT FROM OLD."checks" OR NEW."decision_id" IS DISTINCT FROM OLD."decision_id"
     OR NEW."record_id" IS DISTINCT FROM OLD."record_id" OR NEW."document_id" IS DISTINCT FROM OLD."document_id"
     OR NEW."system_item_id" IS DISTINCT FROM OLD."system_item_id"
     OR NEW."uploaded_by" <> OLD."uploaded_by" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'evidence: снимок формы, объект и автор доказательства не меняются' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evidence_guard
  BEFORE UPDATE OR DELETE ON "public"."evidence"
  FOR EACH ROW EXECUTE FUNCTION evidence_guard();

CREATE TRIGGER evidence_no_truncate
  BEFORE TRUNCATE ON "public"."evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_guard();

-- Файлы доказательства: связь не удаляется, отвязка — один раз отметкой removed_at.
ALTER TABLE "public"."evidence_files"
  ADD CONSTRAINT "evidence_files_removed_check" CHECK (("removed_at" IS NULL) = ("removed_by" IS NULL));

REVOKE DELETE, TRUNCATE ON "public"."evidence_files" FROM ibportal_app;

CREATE FUNCTION evidence_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."removed_at" IS NULL AND NEW."removed_at" IS NOT NULL
     AND NEW."evidence_id" = OLD."evidence_id" AND NEW."file_id" = OLD."file_id"
     AND NEW."added_by" = OLD."added_by" AND NEW."added_at" = OLD."added_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'evidence_files: связь с файлом только отмечается отвязанной (% запрещён)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER evidence_files_guard
  BEFORE UPDATE OR DELETE ON "public"."evidence_files"
  FOR EACH ROW EXECUTE FUNCTION evidence_files_guard();

CREATE TRIGGER evidence_files_no_truncate
  BEFORE TRUNCATE ON "public"."evidence_files"
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_files_guard();

-- Событие: реестра (реестр, запись, правило), документа или доказательства — ровно один предмет.
ALTER TABLE "public"."automation_events"
  DROP CONSTRAINT "automation_events_subject_check",
  ADD CONSTRAINT "automation_events_subject_check" CHECK (
    num_nonnulls("document_id", "evidence_id") <= 1
    AND ("document_id" IS NULL AND "evidence_id" IS NULL)
      = ("register_id" IS NOT NULL AND "record_id" IS NOT NULL AND "automation_id" IS NOT NULL)
  );
-- Одно событие на доказательство и дату окончания срока действия.
CREATE UNIQUE INDEX "automation_events_evidence_uq"
  ON "public"."automation_events" ("evidence_id", "trigger_key") WHERE "evidence_id" IS NOT NULL;

ALTER TABLE "public"."tasks"
  DROP CONSTRAINT "tasks_source_check",
  ADD CONSTRAINT "tasks_source_check" CHECK ("source" IN ('manual', 'mail', 'automation', 'document', 'evidence')),
  ADD CONSTRAINT "tasks_evidence_check" CHECK (
    ("source" = 'evidence') = ("evidence_id" IS NOT NULL)
    AND ("evidence_id" IS NULL) = ("evidence_reason" IS NULL)
    AND ("evidence_reason" IS NULL OR "evidence_reason" IN ('rejected', 'expiring'))
  );
-- Одна открытая задача на (доказательство, причина, ответственный); повтор — комментарий в ней.
CREATE UNIQUE INDEX "tasks_evidence_open_uq"
  ON "public"."tasks" ("evidence_id", "evidence_reason", "assignee_id") NULLS NOT DISTINCT
  WHERE "evidence_id" IS NOT NULL AND "completed_at" IS NULL AND "archived_at" IS NULL AND "deleted_at" IS NULL;
