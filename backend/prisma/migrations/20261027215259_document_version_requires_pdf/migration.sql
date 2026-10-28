-- Этап 7 (ADR-0011, решение владельца проекта 27.10.2026): версия документа утверждается только с итоговым PDF.
-- Сервис проверяет это с этапа 7 (PDF_REQUIRED); триггер — та же проверка в БД, в том числе для владельца схемы.
-- Срабатывает, когда approved_at становится заполненным (из NULL или при INSERT), а pdf_file_id пуст, и когда
-- у утверждённой версии обнуляют pdf_file_id (это же запрещает и guard — здесь проверка не зависит от него).
-- Порядок с document_versions_guard: оба BEFORE, срабатывают по имени — сначала guard (утверждённая версия
-- не меняется), затем эта проверка.
--
-- Влияние на данные: данные не меняются, затронуто 0 строк. Уже утверждённые версии без PDF (утверждены до
-- этапа 7; на dev — 12) остаются как есть: триггер проверяет только момент утверждения. Версии на маршруте без
-- PDF (на dev — 6, этап 1) утвердить нельзя ни сервису (так уже с этапа 7), ни SQL: владелец прикладывает PDF,
-- маршрут начинается заново. Откат: DROP TRIGGER и DROP FUNCTION; backend до 1.0.0 на сервер не выкладывался.

CREATE FUNCTION "public"."document_versions_require_pdf"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."approved_at" IS NOT NULL AND NEW."pdf_file_id" IS NULL
     AND (TG_OP = 'INSERT' OR OLD."approved_at" IS NULL OR OLD."pdf_file_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'document_versions: версия утверждается только с итоговым PDF (pdf_file_id пуст)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "document_versions_require_pdf"
  BEFORE INSERT OR UPDATE OF "approved_at", "pdf_file_id" ON "public"."document_versions"
  FOR EACH ROW EXECUTE FUNCTION "public"."document_versions_require_pdf"();
