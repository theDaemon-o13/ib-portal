-- Релиз 1.2.0, этап Б1: переходы задач между колонками (ADR-0022) — кто, когда, откуда, куда, комментарий.
-- Влияние на данные: новая таблица task_transitions (только пополняется: права и триггер, как у audit_log, ADR-0002)
-- и колонка task_comments.transition_id — NULL у всех существующих комментариев. Существующие строки не меняются.
-- Перенос задач в новую колонку «Поставленные» делает шаг seed tasks.process.v1_2, а не эта миграция.
-- Откат: backend 1.1.0 таблицу и колонку не читает.

-- AlterTable
ALTER TABLE "task_comments" ADD COLUMN     "transition_id" UUID;

-- CreateTable
CREATE TABLE "task_transitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "from_status_id" UUID,
    "to_status_id" UUID NOT NULL,
    "actor_id" UUID,
    "kind" TEXT NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_transitions_task_id_at_idx" ON "task_transitions"("task_id", "at");

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_transition_id_fkey" FOREIGN KEY ("transition_id") REFERENCES "task_transitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_transitions" ADD CONSTRAINT "task_transitions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_transitions" ADD CONSTRAINT "task_transitions_from_status_id_fkey" FOREIGN KEY ("from_status_id") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_transitions" ADD CONSTRAINT "task_transitions_to_status_id_fkey" FOREIGN KEY ("to_status_id") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_transitions" ADD CONSTRAINT "task_transitions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_transitions" ADD CONSTRAINT "task_transitions_kind_check"
  CHECK ("kind" IN ('process', 'override', 'assign', 'system', 'migration'));

-- Переходы только пополняются (как audit_log и document_approvals).
REVOKE UPDATE, DELETE, TRUNCATE ON "task_transitions" FROM ibportal_app;

CREATE FUNCTION task_transitions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task_transitions только пополняется: % запрещён', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER task_transitions_no_update_delete
  BEFORE UPDATE OR DELETE ON "task_transitions"
  FOR EACH ROW EXECUTE FUNCTION task_transitions_append_only();

CREATE TRIGGER task_transitions_no_truncate
  BEFORE TRUNCATE ON "task_transitions"
  FOR EACH STATEMENT EXECUTE FUNCTION task_transitions_append_only();
