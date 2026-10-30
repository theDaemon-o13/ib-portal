-- Релиз 1.2.0, этап Г3: этап 14 «Согласование с ответственными лицами» — ответственные лица со сроками, история сроков,
-- блокеры, ответы лиц (файлы). ADR-0024.
--
-- Влияние на данные: три новые пустые таблицы; новая колонка document_files.party_id пустая у всех строк (на dev —
-- файлы версий e2e); ограничения document_files пересоздаются шире (вид response) — существующие строки им
-- соответствуют; функция-страж document_files сравнивает и party_id. Строки не меняются, затронуто 0.
-- Откат: backend 1.1.0 новые таблицы и колонку не читает.

-- AlterTable
ALTER TABLE "document_files" ADD COLUMN     "party_id" UUID;

-- CreateTable
CREATE TABLE "document_parties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "department" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "user_id" UUID,
    "due_date" DATE NOT NULL,
    "approved_at" TIMESTAMPTZ(3),
    "approved_by" UUID,
    "approve_comment" TEXT NOT NULL DEFAULT '',
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,

    CONSTRAINT "document_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_deadline_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "party_id" UUID,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "comment" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_deadline_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_blockers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "resolve_comment" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "document_blockers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_parties_version_id_idx" ON "document_parties"("version_id");

-- CreateIndex
CREATE INDEX "document_deadline_changes_document_id_at_idx" ON "document_deadline_changes"("document_id", "at");

-- CreateIndex
CREATE INDEX "document_blockers_version_id_idx" ON "document_blockers"("version_id");

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "document_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_parties" ADD CONSTRAINT "document_parties_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_deadline_changes" ADD CONSTRAINT "document_deadline_changes_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_deadline_changes" ADD CONSTRAINT "document_deadline_changes_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "document_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_deadline_changes" ADD CONSTRAINT "document_deadline_changes_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_blockers" ADD CONSTRAINT "document_blockers_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_blockers" ADD CONSTRAINT "document_blockers_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_blockers" ADD CONSTRAINT "document_blockers_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_blockers" ADD CONSTRAINT "document_blockers_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_parties"
  ADD CONSTRAINT "document_parties_name_check" CHECK (length(btrim("full_name")) BETWEEN 1 AND 300),
  ADD CONSTRAINT "document_parties_department_check" CHECK (length("department") <= 300),
  ADD CONSTRAINT "document_parties_email_check" CHECK (length("email") <= 320),
  ADD CONSTRAINT "document_parties_comment_check" CHECK (length("approve_comment") <= 4000),
  ADD CONSTRAINT "document_parties_approved_check" CHECK (("approved_at" IS NULL) = ("approved_by" IS NULL)),
  -- Снять можно только лицо, которое ещё не согласовало.
  ADD CONSTRAINT "document_parties_removed_check" CHECK (
    ("removed_at" IS NULL) = ("removed_by" IS NULL) AND ("removed_at" IS NULL OR "approved_at" IS NULL)
  );
REVOKE DELETE, TRUNCATE ON "document_parties" FROM ibportal_app;

ALTER TABLE "document_deadline_changes"
  ADD CONSTRAINT "document_deadline_changes_subject_check" CHECK (num_nonnulls("party_id") = 1),
  -- Срок меняется только с комментарием.
  ADD CONSTRAINT "document_deadline_changes_comment_check" CHECK (length(btrim("comment")) BETWEEN 1 AND 4000);
-- История сроков только пополняется (как audit_log и document_approvals).
REVOKE UPDATE, DELETE, TRUNCATE ON "document_deadline_changes" FROM ibportal_app;

CREATE FUNCTION document_deadline_changes_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_deadline_changes только пополняется: % запрещён', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER document_deadline_changes_no_update_delete
  BEFORE UPDATE OR DELETE ON "document_deadline_changes"
  FOR EACH ROW EXECUTE FUNCTION document_deadline_changes_append_only();
CREATE TRIGGER document_deadline_changes_no_truncate
  BEFORE TRUNCATE ON "document_deadline_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION document_deadline_changes_append_only();

ALTER TABLE "document_blockers"
  ADD CONSTRAINT "document_blockers_text_check" CHECK (length(btrim("text")) BETWEEN 1 AND 2000),
  -- Снятие — с комментарием.
  ADD CONSTRAINT "document_blockers_resolved_check" CHECK (
    ("resolved_at" IS NULL) = ("resolved_by" IS NULL)
    AND ("resolved_at" IS NULL OR length(btrim("resolve_comment")) BETWEEN 1 AND 4000)
  );
REVOKE DELETE, TRUNCATE ON "document_blockers" FROM ibportal_app;

-- Блокер не удаляется; меняется только отметка «снят» (один раз).
CREATE FUNCTION document_blockers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."resolved_at" IS NULL
     AND NEW."id" = OLD."id" AND NEW."document_id" = OLD."document_id" AND NEW."version_id" = OLD."version_id"
     AND NEW."text" = OLD."text" AND NEW."opened_by" = OLD."opened_by" AND NEW."opened_at" = OLD."opened_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document_blockers: блокер не удаляется и не меняется, только снимается один раз (% запрещён)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER document_blockers_guard
  BEFORE UPDATE OR DELETE ON "document_blockers"
  FOR EACH ROW EXECUTE FUNCTION document_blockers_guard();
CREATE TRIGGER document_blockers_no_truncate
  BEFORE TRUNCATE ON "document_blockers"
  FOR EACH STATEMENT EXECUTE FUNCTION document_blockers_guard();

-- Ответ ответственного лица — вид response с party_id; снимается, как файл драфта.
ALTER TABLE "document_files"
  DROP CONSTRAINT "document_files_kind_check",
  ADD CONSTRAINT "document_files_kind_check" CHECK ("kind" IN ('draft', 'head_approved', 'final', 'response')),
  ADD CONSTRAINT "document_files_party_check" CHECK (("kind" = 'response') = ("party_id" IS NOT NULL)),
  DROP CONSTRAINT "document_files_removed_check",
  ADD CONSTRAINT "document_files_removed_check" CHECK (
    ("removed_by" IS NULL OR "removed_at" IS NOT NULL) AND ("removed_at" IS NULL OR "kind" IN ('draft', 'response'))
  );

CREATE OR REPLACE FUNCTION document_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."removed_at" IS NULL
     AND NEW."id" = OLD."id" AND NEW."document_id" = OLD."document_id" AND NEW."version_id" = OLD."version_id"
     AND NEW."round" = OLD."round" AND NEW."kind" = OLD."kind" AND NEW."file_id" = OLD."file_id"
     AND NEW."added_by" = OLD."added_by" AND NEW."added_at" = OLD."added_at"
     AND NEW."party_id" IS NOT DISTINCT FROM OLD."party_id" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document_files: привязка файла не удаляется и не меняется, только снимается один раз (% запрещён)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
