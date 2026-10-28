-- Релиз 1.1.0, задача 4: настройки сравнения с реестром — ключ (поля по порядку; пусто — по колонке ID)
-- и поля, по которым выбирается область сравнения. «Расширить + перенести»: ключ импорта (is_import_key)
-- становится ключом сравнения по умолчанию; сам is_import_key остаётся (он уникален, ключ сравнения — нет).
--
-- Влияние на данные: две новые колонки registers со значением '{}' (PostgreSQL 16 добавляет их без перезаписи
-- таблицы); UPDATE заполняет compare_key_field_ids у реестров с ключом импорта — по одной строке registers на
-- такой реестр (на dev — 1: «Устройства DLP»). Значения записей не меняются. Откат: backend 1.0.1 колонки
-- не читает, откатывать базу не нужно.
-- Prisma описывает списки без NOT NULL — запрет NULL и лимиты держит CHECK (его check:schema не сравнивает).

-- AlterTable
ALTER TABLE "registers" ADD COLUMN     "compare_key_field_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "compare_scope_field_ids" UUID[] DEFAULT ARRAY[]::UUID[];

ALTER TABLE "registers" ADD CONSTRAINT "registers_compare_check" CHECK (
  "compare_key_field_ids" IS NOT NULL AND "compare_scope_field_ids" IS NOT NULL
  AND cardinality("compare_key_field_ids") <= 3 AND cardinality("compare_scope_field_ids") <= 5
);

UPDATE "registers" r SET "compare_key_field_ids" = ARRAY[f."id"]
FROM "register_fields" f
WHERE f."register_id" = r."id" AND f."is_import_key" AND f."deleted_at" IS NULL;
