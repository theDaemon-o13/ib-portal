-- Исправление функции триггера file_ref_alive() из 20261027140000_files_evidence: plpgsql разбирал оба поля NEW
-- в CASE (pdf_file_id и file_id) для любой таблицы, и вставка в evidence_files и register_decisions падала
-- («record "new" has no field "pdf_file_id"»). Поле теперь читается по имени таблицы через to_jsonb(NEW).
--
-- Влияние на данные: меняется только тело функции, таблицы и строки не затрагиваются (0 строк). Совместима с
-- backend предыдущей версии: он в эти таблицы не пишет. Откат приложения без отката базы.

CREATE OR REPLACE FUNCTION file_ref_alive() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fid uuid;
  gone timestamptz;
BEGIN
  fid := (to_jsonb(NEW) ->> CASE TG_TABLE_NAME WHEN 'document_versions' THEN 'pdf_file_id' ELSE 'file_id' END)::uuid;
  IF fid IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "deleted_at" INTO gone FROM "public"."files" WHERE "id" = fid FOR SHARE;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION 'files: файл удалён — ссылаться на него нельзя' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
