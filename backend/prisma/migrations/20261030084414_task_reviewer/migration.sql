-- Релиз 1.4.0, шаг 3: проверяющий по задаче (ADR-0028) — фиксируется при отправке «На проверке».
-- Влияние на данные: две новые колонки reviewer_id (NULL, без значения по умолчанию — таблицы не переписываются)
-- в tasks и task_transitions, индекс и внешние ключи на users. Существующие строки не меняются (0 строк).
-- Проверяющего задачам, уже стоящим «На проверке», ставит однократный шаг seed tasks.reviewer.v1_4, а не эта миграция.
-- Откат: backend 1.3.0 колонки не читает; task_transitions по-прежнему только пополняется (права и триггер не меняются).

-- AlterTable
ALTER TABLE "task_transitions" ADD COLUMN     "reviewer_id" UUID;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "reviewer_id" UUID;

-- CreateIndex
CREATE INDEX "tasks_reviewer_id_idx" ON "tasks"("reviewer_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_transitions" ADD CONSTRAINT "task_transitions_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
