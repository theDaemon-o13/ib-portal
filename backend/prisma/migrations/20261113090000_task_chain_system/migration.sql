-- 1.14.0, ADR-0053: системные цепочки автозадач реестров («Уязвимости · <группа>», «Реестр · <название>»).
-- Влияние на данные: три новые колонки в task_chains. У существующих строк kind = 'manual' (значение по умолчанию,
-- в PostgreSQL 16 без перезаписи таблицы), source_type и source_id — NULL. Строки не меняются и не удаляются,
-- задачи не трогаются. Откат на 1.13.12 без отката базы: старый код новые колонки не читает, его цепочки получают 'manual'.

ALTER TABLE "task_chains"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "source_type" TEXT,
  ADD COLUMN "source_id" UUID,
  ADD CONSTRAINT "task_chains_kind_check" CHECK (
    ("kind" = 'manual' AND "source_type" IS NULL AND "source_id" IS NULL)
    OR ("kind" = 'system' AND "source_type" IN ('register', 'vuln_group') AND "source_id" IS NOT NULL));

-- Одна неудалённая системная цепочка на источник: два одновременных создания не дают дубль.
CREATE UNIQUE INDEX "task_chains_system_source_uq" ON "task_chains" ("source_type", "source_id")
  WHERE "kind" = 'system' AND "deleted_at" IS NULL;
