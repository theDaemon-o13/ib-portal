-- Релиз 1.4.0, шаг 7: возврат на доработку — с файлом по желанию (записка начальника ИБ). Файл хранится колонкой
-- в решении «возврат» (document_approvals.file_id), а не видом document_files: backend 1.3.0 выбирает в карточке все
-- файлы версии и отвечал бы 500 на документе с неизвестным видом файла (проверено запуском 1.3.0 на базе 1.4.0).
-- Влияние на данные: document_approvals — новая колонка file_id (UUID, NULL, без значения по умолчанию — таблица не
-- переписывается), внешний ключ на files, индекс; ограничение «файл — только у решения returned». Функция
-- file_active_refs учитывает и эту ссылку (файл записки не удаляется, пока на него ссылается решение); триггер
-- file_ref_alive не даёт сослаться на удалённый файл. Существующие строки не меняются: затронуто 0 строк.
-- document_approvals по-прежнему только пополняется (права и триггер не меняются).
-- Откат: backend 1.3.0 колонку не читает; карточка, список и выдача файлов работают (deploy/prechecks/1.4.0.md,
-- «Откат на 1.3.0: файл возврата»).

-- AlterTable
ALTER TABLE "document_approvals" ADD COLUMN     "file_id" UUID;

-- AddForeignKey
ALTER TABLE "document_approvals" ADD CONSTRAINT "document_approvals_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_approvals"
  ADD CONSTRAINT "document_approvals_file_check" CHECK ("file_id" IS NULL OR "decision" = 'returned');

CREATE INDEX "document_approvals_file_id_idx" ON "document_approvals" ("file_id") WHERE "file_id" IS NOT NULL;

CREATE TRIGGER document_approvals_file_alive
  BEFORE INSERT ON "document_approvals"
  FOR EACH ROW WHEN (NEW."file_id" IS NOT NULL) EXECUTE FUNCTION file_ref_alive();

-- Файл записки к возврату — используемый, пока на него ссылается решение (решения не удаляются).
CREATE OR REPLACE FUNCTION file_active_refs(f uuid) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT count(*) FROM "public"."register_decisions" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_versions" WHERE "pdf_file_id" = f)
       + (SELECT count(*) FROM "public"."evidence_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_record_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_imports" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."document_approvals" WHERE "file_id" = f);
$$;
