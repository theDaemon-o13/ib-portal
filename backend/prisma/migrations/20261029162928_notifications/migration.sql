-- Релиз 1.2.0, этап В2: уведомления в портале (ADR-0023). Видит только адресат.
-- Влияние на данные: новая таблица notifications, существующие строки не меняются. Строки служебные, не бизнес-сущность:
-- прочитанные старше 90 дней и непрочитанные старше 180 дней удаляет фоновая очистка (решение владельца 16) одной записью
-- в журнале аудита с числом строк. Откат: backend 1.1.0 таблицу не читает.

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "task_id" UUID,
    "document_id" UUID,
    "actor_id" UUID,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Счётчик непрочитанных у значка (опрос раз в 45 с).
CREATE INDEX "notifications_unread_idx" ON "notifications"("user_id") WHERE "read_at" IS NULL;

-- «Срок завтра» и «просрочено»: одно уведомление адресату на задачу и срок (повторный часовой прогон не дублирует).
CREATE UNIQUE INDEX "notifications_user_dedupe_key" ON "notifications"("user_id", "dedupe_key") WHERE "dedupe_key" IS NOT NULL;
