-- Общая задача (1.6.4, ADR-0034): кто может взять себе задачу без исполнителя — проверка документа сотрудниками,
-- этап перевода с несколькими ответственными. Список приводит к составу syncStageTasks (строки заменяются).
--
-- Влияние на данные: новая пустая таблица task_candidates. Существующие строки не меняются (0 строк).
-- Откат на 1.6.3 совместим: таблица не читается.

-- CreateTable
CREATE TABLE "task_candidates" (
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "task_candidates_pkey" PRIMARY KEY ("task_id","user_id")
);

-- CreateIndex
CREATE INDEX "task_candidates_user_id_idx" ON "task_candidates"("user_id");

-- AddForeignKey
ALTER TABLE "task_candidates" ADD CONSTRAINT "task_candidates_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_candidates" ADD CONSTRAINT "task_candidates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
