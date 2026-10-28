-- Релиз 1.1.0, задача 4: файл, по которому выгрузку или отчёт сканера сравнивали с реестром, хранится
-- в files как доказательство; ссылка на него — у предпросмотра импорта, с которого запущено сравнение.
--
-- Влияние на данные: новая колонка register_imports.file_id = NULL у всех строк (без перезаписи таблицы);
-- функция file_active_refs() начинает учитывать эту ссылку — сейчас ссылок нет, ни один счётчик не меняется,
-- поэтому уборка непривязанных файлов и запрет удаления для существующих файлов работают как прежде.
-- Откат: backend 1.0.1 колонку не читает; лишнее слагаемое функции только не даёт пометить файл сравнения удалённым.

-- AlterTable
ALTER TABLE "register_imports" ADD COLUMN     "file_id" UUID;

-- AddForeignKey
ALTER TABLE "register_imports" ADD CONSTRAINT "register_imports_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Файл сравнения — используемый: не помечается удалённым, пока на него ссылается предпросмотр импорта.
CREATE OR REPLACE FUNCTION file_active_refs(f uuid) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT count(*) FROM "public"."register_decisions" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_versions" WHERE "pdf_file_id" = f)
       + (SELECT count(*) FROM "public"."evidence_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_record_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_imports" WHERE "file_id" = f);
$$;
