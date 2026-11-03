-- Задачи по этапам маршрута документа (1.6.3): тот, кто действует на этапе («Сейчас у»), получает задачу;
-- смена этапа закрывает её. Новая причина задачи по документу — 'stage', состояние маршрута — tasks.document_state.
--
-- Влияние на данные: новая колонка tasks.document_state — NULL у всех строк; CHECK задачи по документу принимает
-- причину 'stage'. Существующие строки не меняются (0 строк). Откат на 1.6.2: backend 1.6.2 не знает причины
-- 'stage' — перед сменой версии UPDATE tasks SET document_reason = 'returned', document_state = NULL
-- WHERE document_reason = 'stage' (RELEASE.md, «Откат»).

ALTER TABLE "public"."tasks" ADD COLUMN "document_state" TEXT;

ALTER TABLE "public"."tasks"
  DROP CONSTRAINT "tasks_document_check",
  ADD CONSTRAINT "tasks_document_check" CHECK (
    ("source" = 'document') = ("document_id" IS NOT NULL)
    AND ("document_id" IS NULL) = ("document_reason" IS NULL)
    AND ("document_reason" IS NULL OR "document_reason" IN ('review', 'returned', 'stage'))
    -- Состояние маршрута — только у задачи этапа, и у неё обязательно.
    AND (("document_reason" IS NOT DISTINCT FROM 'stage') = ("document_state" IS NOT NULL))
  );
