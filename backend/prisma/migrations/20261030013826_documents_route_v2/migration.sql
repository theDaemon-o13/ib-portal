-- Релиз 1.2.0, этап Г1: маршрут документа из 6 этапов (11–16) рядом со старым (0–3), комментарии сотрудников,
-- файлы версии, отмена пересмотра, мягкое удаление документа (ADR-0024).
--
-- Влияние на данные: новые колонки пустые (self_approved = false), новые таблицы пустые. Ограничения этапа и решения
-- пересоздаются шире — существующие строки (этапы 0–3, прежние решения) им соответствуют, ни одна не меняется.
-- Функция file_active_refs() начинает учитывать файлы документов — сейчас их нет, ни один счётчик не меняется.
-- Перенос рабочих версий на новый маршрут — шаг seed docs.route.v1_2 (не эта миграция).
-- Откат: backend 1.1.0 новые колонки и таблицы не читает; версии на этапах 11–16 он не узнаёт и не двигает
-- (этапа нет в его маршруте); удалённый документ для него — архивный (удаление ставит и archived_at).

-- AlterTable
ALTER TABLE "document_approvals" ADD COLUMN     "self_approved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "to_stage" SMALLINT;

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "signed_on" DATE;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "deleted_by" UUID;

-- CreateTable
CREATE TABLE "document_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "file_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,

    CONSTRAINT "document_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_comments_document_id_created_at_idx" ON "document_comments"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "document_files_version_id_round_idx" ON "document_files"("version_id", "round");

-- CreateIndex
CREATE INDEX "document_files_file_id_idx" ON "document_files"("file_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Этапы: старый маршрут 0–3 (только история и версии, утверждённые до 1.2.0) и новый 11–16.
ALTER TABLE "document_versions"
  DROP CONSTRAINT "document_versions_stage_check",
  ADD CONSTRAINT "document_versions_stage_check" CHECK ("stage" BETWEEN 0 AND 3 OR "stage" BETWEEN 11 AND 16),
  -- Утверждена: на старом маршруте — после этапа 3, на новом — подписанием на этапе 16 с датой подписания.
  DROP CONSTRAINT "document_versions_approved_check",
  ADD CONSTRAINT "document_versions_approved_check"
    CHECK ("approved_at" IS NULL OR "stage" = 3 OR ("stage" = 16 AND "signed_on" IS NOT NULL)),
  ADD CONSTRAINT "document_versions_signed_check" CHECK ("signed_on" IS NULL OR "approved_at" IS NOT NULL),
  -- Отменить можно только неутверждённую версию.
  ADD CONSTRAINT "document_versions_cancelled_check" CHECK ("cancelled_at" IS NULL OR "approved_at" IS NULL);

ALTER TABLE "document_approvals"
  DROP CONSTRAINT "document_approvals_stage_check",
  ADD CONSTRAINT "document_approvals_stage_check" CHECK ("stage" BETWEEN 0 AND 3 OR "stage" BETWEEN 11 AND 16),
  ADD CONSTRAINT "document_approvals_to_stage_check" CHECK ("to_stage" IS NULL OR "to_stage" BETWEEN 11 AND 16),
  DROP CONSTRAINT "document_approvals_decision_check",
  ADD CONSTRAINT "document_approvals_decision_check" CHECK ("decision" IN
    ('submitted', 'approved', 'returned', 'revision_started', 'skipped', 'moved', 'signed', 'migrated', 'cancelled')),
  -- Возврат, пропуск и отмена пересмотра — только с комментарием.
  DROP CONSTRAINT "document_approvals_comment_check",
  ADD CONSTRAINT "document_approvals_comment_check" CHECK (
    length("comment") <= 4000 AND ("decision" NOT IN ('returned', 'skipped', 'cancelled') OR length(btrim("comment")) >= 1)
  ),
  -- «Без независимого согласования» — только согласование этапа 13.
  ADD CONSTRAINT "document_approvals_self_check" CHECK (NOT "self_approved" OR ("decision" = 'approved' AND "stage" = 13));

-- Удалённый документ: без подписанной версии и в архиве (так его не показывает и backend 1.1.0 после отката).
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_deleted_check" CHECK (
    ("deleted_by" IS NULL OR "deleted_at" IS NOT NULL)
    AND ("deleted_at" IS NULL OR ("archived_at" IS NOT NULL AND "approved_version_id" IS NULL))
  );

ALTER TABLE "document_comments"
  ADD CONSTRAINT "document_comments_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 4000);
-- Комментарии не правятся и не удаляются.
REVOKE UPDATE, DELETE, TRUNCATE ON "document_comments" FROM ibportal_app;

ALTER TABLE "document_files"
  ADD CONSTRAINT "document_files_kind_check" CHECK ("kind" IN ('draft', 'head_approved', 'final')),
  ADD CONSTRAINT "document_files_round_check" CHECK ("round" >= 1),
  ADD CONSTRAINT "document_files_removed_check" CHECK (
    ("removed_by" IS NULL OR "removed_at" IS NOT NULL) AND ("removed_at" IS NULL OR "kind" = 'draft')
  );
-- Одобренная начальником ИБ и финальная версия — по одному файлу на круг маршрута.
CREATE UNIQUE INDEX "document_files_fixed_uq" ON "document_files" ("version_id", "round", "kind")
  WHERE "kind" IN ('head_approved', 'final');

-- Привязки файлов не удаляются; меняется только отметка «снят» (один раз).
REVOKE DELETE, TRUNCATE ON "document_files" FROM ibportal_app;

CREATE FUNCTION document_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."removed_at" IS NULL
     AND NEW."id" = OLD."id" AND NEW."document_id" = OLD."document_id" AND NEW."version_id" = OLD."version_id"
     AND NEW."round" = OLD."round" AND NEW."kind" = OLD."kind" AND NEW."file_id" = OLD."file_id"
     AND NEW."added_by" = OLD."added_by" AND NEW."added_at" = OLD."added_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document_files: привязка файла не удаляется и не меняется, только снимается один раз (% запрещён)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER document_files_guard
  BEFORE UPDATE OR DELETE ON "document_files"
  FOR EACH ROW EXECUTE FUNCTION document_files_guard();
CREATE TRIGGER document_files_no_truncate
  BEFORE TRUNCATE ON "document_files"
  FOR EACH STATEMENT EXECUTE FUNCTION document_files_guard();
CREATE TRIGGER document_files_file_alive
  BEFORE INSERT ON "document_files"
  FOR EACH ROW EXECUTE FUNCTION file_ref_alive();

-- Файл документа — используемый, пока привязка не снята.
CREATE OR REPLACE FUNCTION file_active_refs(f uuid) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT count(*) FROM "public"."register_decisions" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_versions" WHERE "pdf_file_id" = f)
       + (SELECT count(*) FROM "public"."evidence_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_record_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_imports" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_files" WHERE "file_id" = f AND "removed_at" IS NULL);
$$;
