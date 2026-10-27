-- Этап 8: плитки-счётчики дашборда и ключ импорта Excel.
--
-- Влияние на данные: создаётся пустая таблица dashboard_tiles; register_fields.is_import_key — новая колонка
-- со значением false, register_records.import_key — новая колонка NULL (PostgreSQL 16 добавляет их без перезаписи
-- таблиц), затронуто 0 строк. Ключ импорта ещё ни у одного поля не задан, поэтому уникальный индекс строится по
-- пустой колонке. Триггер заполняет только import_key при записи "values". Совместима с backend этапа 7: он
-- новые колонки не читает, а его вставки получают import_key = NULL, пока ключ не задан. Откат приложения без
-- отката базы.

-- AlterTable
ALTER TABLE "public"."register_fields" ADD COLUMN     "is_import_key" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "public"."register_records" ADD COLUMN     "import_key" TEXT;

-- CreateTable
CREATE TABLE "public"."dashboard_tiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "register_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "option_ids" UUID[] NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "dashboard_tiles_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."dashboard_tiles" ADD CONSTRAINT "dashboard_tiles_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "public"."registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."dashboard_tiles" ADD CONSTRAINT "dashboard_tiles_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "public"."register_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."dashboard_tiles" ADD CONSTRAINT "dashboard_tiles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Плитка: непустое название, 1–50 значений. Удаление только мягкое (deleted_at).
ALTER TABLE "public"."dashboard_tiles" ADD CONSTRAINT "dashboard_tiles_title_check"
  CHECK (char_length(btrim("title")) BETWEEN 1 AND 120);
ALTER TABLE "public"."dashboard_tiles" ADD CONSTRAINT "dashboard_tiles_options_check"
  CHECK (cardinality("option_ids") BETWEEN 1 AND 50);
CREATE INDEX "dashboard_tiles_order" ON "public"."dashboard_tiles" ("sort_order") WHERE "deleted_at" IS NULL;
REVOKE DELETE, TRUNCATE ON "public"."dashboard_tiles" FROM ibportal_app;

-- Ключ импорта: одно поле на реестр.
CREATE UNIQUE INDEX "register_fields_one_import_key" ON "public"."register_fields" ("register_id")
  WHERE "is_import_key" AND "deleted_at" IS NULL;

-- Нормализация значения ключа: без регистра, крайних пробелов и повторных пробелов; пустое — NULL.
-- Одна функция для триггера и для сопоставления строк файла при импорте.
CREATE FUNCTION register_import_key(v text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NULLIF(lower(regexp_replace(btrim(v), '[[:space:]]+', ' ', 'g')), '')
$$;

-- import_key всегда считается из "values" по текущему полю-ключу реестра: ни форма, ни импорт,
-- ни отчёт сканера не могут забыть его пересчитать. Смена поля-ключа пересчитывает записи
-- (UPDATE ... SET "values" = "values").
CREATE FUNCTION register_records_import_key() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  key_field uuid;
BEGIN
  SELECT "id" INTO key_field FROM "public"."register_fields"
  WHERE "register_id" = NEW."register_id" AND "is_import_key" AND "deleted_at" IS NULL;
  NEW."import_key" := CASE WHEN key_field IS NULL THEN NULL ELSE register_import_key(NEW."values" ->> key_field::text) END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER register_records_import_key
  BEFORE INSERT OR UPDATE OF "values", "import_key" ON "public"."register_records"
  FOR EACH ROW EXECUTE FUNCTION register_records_import_key();

-- Уникальность ключа среди неудалённых записей реестра (архивные тоже держат ключ).
CREATE UNIQUE INDEX "register_records_import_key" ON "public"."register_records" ("register_id", "import_key")
  WHERE "deleted_at" IS NULL AND "import_key" IS NOT NULL;
