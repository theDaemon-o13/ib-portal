-- Аннулирование скана (1.13.12, ADR-0052; docs/plans/release-1.13.12.md): событие корзины с entity = 'vuln_scan'.
-- Скан не меняется (vuln_scans_guard прежний). Расширяются допустимые значения двух CHECK у deletions;
-- существующие строки остаются допустимыми. Влияние на данные: 0 изменённых строк.
ALTER TABLE "deletions" DROP CONSTRAINT "deletions_entity_check",
  ADD CONSTRAINT "deletions_entity_check" CHECK ("entity" IN ('register', 'vuln_group', 'vuln_node', 'register_records', 'vuln_scan'));
ALTER TABLE "deletions" DROP CONSTRAINT "deletions_reason_code_check",
  ADD CONSTRAINT "deletions_reason_code_check" CHECK ("reason_code" IS NULL OR "reason_code" IN ('wrong_import', 'false_positive', 'duplicate', 'other', 'reupload', 'wrong_file'));

-- «Аннулирован ли скан» — невосстановленное событие по entity_id.
CREATE INDEX "deletions_active_entity_idx" ON "deletions" ("entity", "entity_id") WHERE "restored_at" IS NULL;
