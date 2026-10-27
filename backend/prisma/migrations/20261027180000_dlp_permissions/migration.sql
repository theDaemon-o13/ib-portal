-- Этап 8б: поля «Файл» и «Связь с записью», фиксация полей по статусу, текст PDF и полнотекстовый поиск,
-- сводные события автоматизаций (ADR-0013).
--
-- Влияние на данные:
--  * register_fields: новые колонки link_register_id и settings (NULL, без перезаписи таблицы); CHECK типа
--    расширен значениями 'file' и 'link' — существующие поля ему соответствуют. Затронуто 0 строк.
--  * register_records: новая вычисляемая колонка search_tsv = to_tsvector('russian', search_text) — таблица
--    перезаписывается целиком под блокировкой (на dev 2490 строк — доли секунды). "values", search_text и
--    версии записей не меняются.
--  * file_texts: по строке 'pending' на каждый неудалённый PDF (на dev 26); текст извлечёт фоновый прогон.
--  * register_record_files: новая пустая таблица. file_active_refs() теперь считает и её ссылки —
--    для существующих файлов результат прежний.
--  * automation_events_subject_check и tasks_automation_check пересоздаются шире: событие и задача правила
--    могут быть без записи (сводная задача по реестру). Существующие строки им соответствуют (на dev проверено:
--    0 нарушений). Затронуто 0 строк.
--  * Новые триггеры только запрещают изменения (зафиксированные поля, удаление); существующие записи
--    не затрагивают: ни у одного поля ещё нет настройки фиксации.
-- Откат: портал ещё не выкладывался (первый релиз — с этапом 8б); прежний backend новых колонок и таблиц
-- не читает, но поля новых типов из стартового seed он показать не сможет (RELEASE.template.md).

-- AlterTable
ALTER TABLE "public"."register_fields" ADD COLUMN     "link_register_id" UUID,
ADD COLUMN     "settings" JSONB;

-- AlterTable
-- Вычисляемая колонка: пишет только БД, приложение её не передаёт.
ALTER TABLE "public"."register_records" ADD COLUMN     "search_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('russian', "search_text")) STORED;

-- CreateTable
CREATE TABLE "public"."register_record_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "record_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,

    CONSTRAINT "register_record_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."file_texts" (
    "file_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "content" TEXT,
    "pages" INTEGER,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "extracted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('russian', COALESCE("content", ''))) STORED,

    CONSTRAINT "file_texts_pkey" PRIMARY KEY ("file_id")
);

-- CreateIndex
CREATE INDEX "register_record_files_record_id_field_id_idx" ON "public"."register_record_files"("record_id", "field_id");

-- CreateIndex
CREATE INDEX "register_record_files_file_id_idx" ON "public"."register_record_files"("file_id");

-- CreateIndex
CREATE INDEX "file_texts_status_idx" ON "public"."file_texts"("status");

-- AddForeignKey
ALTER TABLE "public"."register_fields" ADD CONSTRAINT "register_fields_link_register_id_fkey" FOREIGN KEY ("link_register_id") REFERENCES "public"."registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_record_files" ADD CONSTRAINT "register_record_files_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."register_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_record_files" ADD CONSTRAINT "register_record_files_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "public"."register_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_record_files" ADD CONSTRAINT "register_record_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_record_files" ADD CONSTRAINT "register_record_files_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."register_record_files" ADD CONSTRAINT "register_record_files_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."file_texts" ADD CONSTRAINT "file_texts_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Дополнения вручную (Prisma 6 их не описывает: CHECK, частичные и GIN-индексы, функции, триггеры).
-- ---------------------------------------------------------------------------

-- Новые типы полей: «Файл» (файлы — в register_record_files, не в "values") и «Связь с записью»
-- ("values" — массив id записей реестра link_register_id).
ALTER TABLE "public"."register_fields"
  DROP CONSTRAINT "register_fields_type_check",
  ADD CONSTRAINT "register_fields_type_check"
    CHECK ("type" IN ('text', 'select', 'number', 'date', 'user', 'calc', 'decision', 'catalog', 'file', 'link')),
  ADD CONSTRAINT "register_fields_link_check" CHECK (("type" = 'link') = ("link_register_id" IS NOT NULL)),
  ADD CONSTRAINT "register_fields_settings_check" CHECK ("settings" IS NULL OR jsonb_typeof("settings") = 'object');

-- Полнотекстовый поиск по записям; обратные связи («кто ссылается на запись») — по "values" @> {...}.
CREATE INDEX "register_records_search_tsv_idx" ON "public"."register_records" USING gin ("search_tsv");
CREATE INDEX "register_records_values_idx" ON "public"."register_records" USING gin ("values" jsonb_path_ops);

-- Текст PDF: статусы разбора; полнотекстовый индекс. Строки не удаляются.
ALTER TABLE "public"."file_texts"
  ADD CONSTRAINT "file_texts_status_check" CHECK ("status" IN ('pending', 'text', 'no_text', 'failed')),
  ADD CONSTRAINT "file_texts_content_check" CHECK ("content" IS NULL OR length("content") <= 2000000);
CREATE INDEX "file_texts_tsv_idx" ON "public"."file_texts" USING gin ("tsv");
REVOKE DELETE, TRUNCATE ON "public"."file_texts" FROM ibportal_app;
INSERT INTO "public"."file_texts" ("file_id", "status")
  SELECT "id", 'pending' FROM "public"."files" WHERE "mime" = 'application/pdf' AND "deleted_at" IS NULL;

-- Файлы записей: один действующий файл один раз на поле записи; отвязка мягкая.
CREATE UNIQUE INDEX "register_record_files_active_uq" ON "public"."register_record_files" ("record_id", "field_id", "file_id")
  WHERE "removed_at" IS NULL;
ALTER TABLE "public"."register_record_files"
  ADD CONSTRAINT "register_record_files_removed_check" CHECK (("removed_at" IS NULL) = ("removed_by" IS NULL));
REVOKE DELETE, TRUNCATE ON "public"."register_record_files" FROM ibportal_app;

-- Действующие ссылки на файл: + файлы полей «Файл» записей реестров.
CREATE OR REPLACE FUNCTION file_active_refs(f uuid) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT count(*) FROM "public"."register_decisions" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_versions" WHERE "pdf_file_id" = f)
       + (SELECT count(*) FROM "public"."evidence_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_record_files" WHERE "file_id" = f AND "removed_at" IS NULL);
$$;

-- ---------------------------------------------------------------------------
-- Фиксация полей статусом записи (настройка поля settings.lock, lib/field-settings.ts):
--   { "statusOptionIds": [id значений поля статуса], "mode": "locked" | "reason" }.
-- locked — заполненное значение не меняется и не очищается, файл не отвязывается и второй не добавляется;
-- reason — менять можно, причину требует backend (в БД не проверяется).
-- Пока у записи такой статус: запись не удаляется, а статус меняется только на другой фиксирующий.
-- ---------------------------------------------------------------------------

CREATE FUNCTION register_locked_fields(reg uuid, vals jsonb) RETURNS TABLE ("field_id" uuid, "mode" text)
LANGUAGE sql STABLE AS $$
  SELECT f."id", COALESCE(f."settings" #>> '{lock,mode}', 'locked')
  FROM "public"."register_fields" f
  WHERE f."register_id" = reg AND f."deleted_at" IS NULL
    AND jsonb_typeof(f."settings" #> '{lock,statusOptionIds}') = 'array'
    AND (f."settings" #> '{lock,statusOptionIds}') ? (vals ->> (
      SELECT s."id"::text FROM "public"."register_fields" s
      WHERE s."register_id" = reg AND s."is_status" AND s."deleted_at" IS NULL
      LIMIT 1));
$$;

CREATE FUNCTION register_records_lock_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l record;
  any_lock boolean := false;
BEGIN
  FOR l IN SELECT * FROM register_locked_fields(OLD."register_id", OLD."values") LOOP
    any_lock := true;
    IF TG_OP = 'UPDATE' AND l."mode" = 'locked' AND OLD."values" ? l."field_id"::text
       AND (NEW."values" -> l."field_id"::text) IS DISTINCT FROM (OLD."values" -> l."field_id"::text) THEN
      RAISE EXCEPTION 'register_records: поле % зафиксировано статусом записи', l."field_id"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;
  IF NOT any_lock THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' OR (NEW."deleted_at" IS NOT NULL AND OLD."deleted_at" IS NULL) THEN
    RAISE EXCEPTION 'register_records: запись с зафиксированными полями не удаляется'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."register_id" <> OLD."register_id"
     OR NOT EXISTS (SELECT 1 FROM register_locked_fields(NEW."register_id", NEW."values")) THEN
    RAISE EXCEPTION 'register_records: статус записи меняется только на другой фиксирующий'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER register_records_lock_guard
  BEFORE UPDATE OR DELETE ON "public"."register_records"
  FOR EACH ROW EXECUTE FUNCTION register_records_lock_guard();

CREATE FUNCTION register_record_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec record;
  locked boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'register_record_files: ссылки на файлы не удаляются — только отвязка (removed_at)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r."register_id", r."values" INTO rec FROM "public"."register_records" r WHERE r."id" = NEW."record_id";
  locked := EXISTS (SELECT 1 FROM register_locked_fields(rec."register_id", rec."values") l
                    WHERE l."field_id" = NEW."field_id" AND l."mode" = 'locked');
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" <> OLD."id" OR NEW."record_id" <> OLD."record_id" OR NEW."field_id" <> OLD."field_id"
       OR NEW."file_id" <> OLD."file_id" OR NEW."added_by" <> OLD."added_by" OR NEW."added_at" <> OLD."added_at" THEN
      RAISE EXCEPTION 'register_record_files: ссылка на файл не меняется' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD."removed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'register_record_files: отвязанный файл не меняется' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."removed_at" IS NOT NULL AND locked THEN
      RAISE EXCEPTION 'register_record_files: файл зафиксирован статусом записи' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF locked AND EXISTS (SELECT 1 FROM "public"."register_record_files" x
                           WHERE x."record_id" = NEW."record_id" AND x."field_id" = NEW."field_id" AND x."removed_at" IS NULL) THEN
    RAISE EXCEPTION 'register_record_files: поле зафиксировано статусом записи — файл уже приложен'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER register_record_files_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."register_record_files"
  FOR EACH ROW EXECUTE FUNCTION register_record_files_guard();

-- ---------------------------------------------------------------------------
-- Сводное событие правила (1 декабря — «Продление разрешений»): реестр и правило без записи.
-- ---------------------------------------------------------------------------
ALTER TABLE "public"."automation_events"
  DROP CONSTRAINT "automation_events_subject_check",
  ADD CONSTRAINT "automation_events_subject_check" CHECK (
    num_nonnulls("document_id", "evidence_id") <= 1
    AND ("document_id" IS NULL AND "evidence_id" IS NULL) = ("register_id" IS NOT NULL AND "automation_id" IS NOT NULL)
    AND ("record_id" IS NULL OR "register_id" IS NOT NULL)
  );
-- Одно сводное событие на правило и дату срабатывания.
CREATE UNIQUE INDEX "automation_events_register_uq"
  ON "public"."automation_events" ("automation_id", "trigger_key") WHERE "record_id" IS NULL AND "automation_id" IS NOT NULL;

ALTER TABLE "public"."tasks"
  DROP CONSTRAINT "tasks_automation_check",
  -- Задача автоматизации всегда знает правило; запись — кроме сводной задачи по реестру.
  ADD CONSTRAINT "tasks_automation_check" CHECK (("source" = 'automation') = ("automation_id" IS NOT NULL));
