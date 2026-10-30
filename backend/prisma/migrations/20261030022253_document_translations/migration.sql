-- Релиз 1.2.0, этап Г4: этап 15 «Перевод» — языки, переводчики (пользователи портала), сроки с историей, файлы перевода.
-- ADR-0024.
--
-- Влияние на данные: новая пустая таблица document_translations; новые колонки document_files.translation_id и
-- document_deadline_changes.translation_id пустые у всех строк (на dev — файлы и сроки e2e); ограничения пересоздаются
-- шире (вид translation, срок перевода) — существующие строки им соответствуют, затронуто 0 строк; функция-страж
-- document_files сравнивает и translation_id. Откат: backend 1.1.0 новые таблицы и колонки не читает.

-- AlterTable
ALTER TABLE "document_deadline_changes" ADD COLUMN     "translation_id" UUID;

-- AlterTable
ALTER TABLE "document_files" ADD COLUMN     "translation_id" UUID;

-- CreateTable
CREATE TABLE "document_translations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "translator_id" UUID NOT NULL,
    "due_date" DATE NOT NULL,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,

    CONSTRAINT "document_translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_translations_version_id_idx" ON "document_translations"("version_id");

-- CreateIndex
CREATE INDEX "document_translations_translator_id_idx" ON "document_translations"("translator_id");

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_translation_id_fkey" FOREIGN KEY ("translation_id") REFERENCES "document_translations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_deadline_changes" ADD CONSTRAINT "document_deadline_changes_translation_id_fkey" FOREIGN KEY ("translation_id") REFERENCES "document_translations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_translations" ADD CONSTRAINT "document_translations_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_translations" ADD CONSTRAINT "document_translations_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_translations" ADD CONSTRAINT "document_translations_translator_id_fkey" FOREIGN KEY ("translator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_translations" ADD CONSTRAINT "document_translations_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_translations" ADD CONSTRAINT "document_translations_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_translations"
  ADD CONSTRAINT "document_translations_language_check" CHECK (length(btrim("language")) BETWEEN 1 AND 100),
  ADD CONSTRAINT "document_translations_removed_check" CHECK (("removed_at" IS NULL) = ("removed_by" IS NULL));
-- Один язык — один раз в версии (снятые не считаются).
CREATE UNIQUE INDEX "document_translations_language_uq" ON "document_translations" ("version_id", lower(btrim("language")))
  WHERE "removed_at" IS NULL;
REVOKE DELETE, TRUNCATE ON "document_translations" FROM ibportal_app;

-- Срок перевода — в той же истории сроков, что и у ответственных лиц: ровно один предмет.
ALTER TABLE "document_deadline_changes"
  DROP CONSTRAINT "document_deadline_changes_subject_check",
  ADD CONSTRAINT "document_deadline_changes_subject_check" CHECK (num_nonnulls("party_id", "translation_id") = 1);

ALTER TABLE "document_files"
  DROP CONSTRAINT "document_files_kind_check",
  ADD CONSTRAINT "document_files_kind_check" CHECK ("kind" IN ('draft', 'head_approved', 'final', 'response', 'translation')),
  ADD CONSTRAINT "document_files_translation_check" CHECK (("kind" = 'translation') = ("translation_id" IS NOT NULL)),
  DROP CONSTRAINT "document_files_removed_check",
  ADD CONSTRAINT "document_files_removed_check" CHECK (
    ("removed_by" IS NULL OR "removed_at" IS NOT NULL) AND ("removed_at" IS NULL OR "kind" IN ('draft', 'response', 'translation'))
  );

CREATE OR REPLACE FUNCTION document_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."removed_at" IS NULL
     AND NEW."id" = OLD."id" AND NEW."document_id" = OLD."document_id" AND NEW."version_id" = OLD."version_id"
     AND NEW."round" = OLD."round" AND NEW."kind" = OLD."kind" AND NEW."file_id" = OLD."file_id"
     AND NEW."added_by" = OLD."added_by" AND NEW."added_at" = OLD."added_at"
     AND NEW."party_id" IS NOT DISTINCT FROM OLD."party_id"
     AND NEW."translation_id" IS NOT DISTINCT FROM OLD."translation_id" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document_files: привязка файла не удаляется и не меняется, только снимается один раз (% запрещён)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
