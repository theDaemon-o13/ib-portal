-- 1.12.0: макет письма, выгрузка готового письма, регистрация отправки (docs/plans/release-1.12.0.md, ADR-0044–0046).
--   awareness_templates, awareness_letter_versions — заголовок и метка шапки RU/TJ, общая тема RU+TJ (пусто — по умолчанию);
--   awareness_letter_events — у отметки «Отправлено»: языки, получатели, выгрузка;
--   awareness_layout — «Оформление писем», одна строка (её создаёт seed с заглушками);
--   awareness_letter_exports — выгрузки .eml (файл в files), только пополняются;
--   file_active_refs() учитывает логотип и выгрузки: часовая очистка непривязанных файлов их не трогает.
-- Влияние на данные: добавляются колонки (у всех существующих строк '' или NULL) и пустые таблицы; существующие письма,
-- версии, события, шаблоны и записи «Рассылок» не меняются (0 строк). ADD COLUMN … DEFAULT строки не переписывает через
-- триггеры «только пополняется» и заморозки. Откат на 1.11.0 без отката базы: 1.11.0 новые колонки и таблицы не читает,
-- его вставки в версии и события проходят (значения по умолчанию и NULL).

-- AlterTable
ALTER TABLE "awareness_letter_events" ADD COLUMN     "export_id" UUID,
ADD COLUMN     "langs" TEXT,
ADD COLUMN     "recipients" TEXT;

-- AlterTable
ALTER TABLE "awareness_letter_versions" ADD COLUMN     "header_ru" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "header_tj" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "label_ru" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "label_tj" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "subject_both" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "awareness_templates" ADD COLUMN     "header_ru" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "header_tj" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "label_ru" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "label_tj" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "subject_both" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "awareness_layout" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "dept_ru" TEXT NOT NULL,
    "dept_tj" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "closing_ru" TEXT NOT NULL,
    "closing_tj" TEXT NOT NULL,
    "footer_ru" TEXT NOT NULL DEFAULT '',
    "footer_tj" TEXT NOT NULL DEFAULT '',
    "label_urgent_ru" TEXT NOT NULL,
    "label_urgent_tj" TEXT NOT NULL,
    "label_planned_ru" TEXT NOT NULL,
    "label_planned_tj" TEXT NOT NULL,
    "tj_hint" TEXT NOT NULL,
    "logo_file_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "awareness_layout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "awareness_letter_exports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "letter_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "langs" TEXT NOT NULL,
    "file_id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "awareness_letter_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "awareness_letter_exports_letter_id_created_at_idx" ON "awareness_letter_exports"("letter_id", "created_at");

-- AddForeignKey
ALTER TABLE "awareness_letter_events" ADD CONSTRAINT "awareness_letter_events_export_id_fkey" FOREIGN KEY ("export_id") REFERENCES "awareness_letter_exports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_layout" ADD CONSTRAINT "awareness_layout_logo_file_id_fkey" FOREIGN KEY ("logo_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_layout" ADD CONSTRAINT "awareness_layout_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_exports" ADD CONSTRAINT "awareness_letter_exports_letter_id_fkey" FOREIGN KEY ("letter_id") REFERENCES "awareness_letters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_exports" ADD CONSTRAINT "awareness_letter_exports_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "awareness_letter_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_exports" ADD CONSTRAINT "awareness_letter_exports_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_exports" ADD CONSTRAINT "awareness_letter_exports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ——— Ограничения ———

ALTER TABLE "awareness_templates"
  ADD CONSTRAINT "awareness_templates_head_check" CHECK (
    length("header_ru") <= 300 AND length("header_tj") <= 300 AND length("label_ru") <= 300 AND length("label_tj") <= 300 AND length("subject_both") <= 610);
ALTER TABLE "awareness_letter_versions"
  ADD CONSTRAINT "awareness_letter_versions_head_check" CHECK (
    length("header_ru") <= 300 AND length("header_tj") <= 300 AND length("label_ru") <= 300 AND length("label_tj") <= 300 AND length("subject_both") <= 610);
ALTER TABLE "awareness_letter_events"
  ADD CONSTRAINT "awareness_letter_events_langs_check" CHECK ("langs" IS NULL OR "langs" IN ('both', 'ru', 'tj')),
  ADD CONSTRAINT "awareness_letter_events_send_check" CHECK (("langs" IS NULL AND "recipients" IS NULL AND "export_id" IS NULL) OR "action" = 'sent');
ALTER TABLE "awareness_layout"
  ADD CONSTRAINT "awareness_layout_single_check" CHECK ("id" = 1),
  ADD CONSTRAINT "awareness_layout_version_check" CHECK ("version" >= 1);
ALTER TABLE "awareness_letter_exports"
  ADD CONSTRAINT "awareness_letter_exports_langs_check" CHECK ("langs" IN ('both', 'ru', 'tj')),
  ADD CONSTRAINT "awareness_letter_exports_sha_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');

-- ——— Выгрузки только пополняются ———

CREATE TRIGGER awareness_letter_exports_append_only BEFORE UPDATE OR DELETE ON "awareness_letter_exports"
  FOR EACH ROW EXECUTE FUNCTION awareness_append_only();
REVOKE UPDATE, DELETE, TRUNCATE ON "awareness_letter_exports" FROM ibportal_app;
REVOKE DELETE, TRUNCATE ON "awareness_layout" FROM ibportal_app;

-- ——— Ссылки на файлы ———

CREATE OR REPLACE FUNCTION file_active_refs(f uuid) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT count(*) FROM "public"."register_decisions" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_versions" WHERE "pdf_file_id" = f OR "source_docx_file_id" = f)
       + (SELECT count(*) FROM "public"."document_translations" WHERE "source_docx_file_id" = f OR "signed_pdf_file_id" = f)
       + (SELECT count(*) FROM "public"."evidence_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_record_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_imports" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."document_approvals" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."vuln_scans" WHERE "file_id" = f OR "handover_file_id" = f)
       + (SELECT count(*) FROM "public"."vuln_extensions" WHERE "basis_file_id" = f)
       + (SELECT count(*) FROM "public"."awareness_layout" WHERE "logo_file_id" = f)
       + (SELECT count(*) FROM "public"."awareness_letter_exports" WHERE "file_id" = f);
$$;
