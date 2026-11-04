-- Цепочки задач (1.7.0, ADR-0035): задачи с одной темой («RE: тема») собирает человек, портал подсказывает.
-- Статус цепочки от статусов задач не зависит; удаление цепочки мягкое, задачи отвязываются.
--
-- Влияние на данные: новая пустая таблица task_chains; в tasks новая колонка chain_id, у всех существующих строк NULL.
-- Существующие строки не меняются: ADD COLUMN без значения по умолчанию меняет только описание таблицы.
-- Индекс tasks_chain_id_idx частичный (только строки с цепочкой) — при выкладке пустой.
-- Откат на 1.6.7 без отката базы совместим: backend 1.6.7 выбирает колонки tasks явно, chain_id не читает и не пишет
-- (новые задачи — NULL), task_chains не читает; задачи в цепочках работают как обычные.

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "chain_id" UUID;

-- CreateTable
CREATE TABLE "task_chains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "title_key" TEXT NOT NULL,
    "owner_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "due_date" DATE,
    "summary" TEXT NOT NULL DEFAULT '',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "task_chains_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_chains_status_check" CHECK ("status" IN ('open', 'closed')),
    CONSTRAINT "task_chains_closed_at_check" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)),
    CONSTRAINT "task_chains_title_check" CHECK (btrim("title") <> '' AND "title_key" <> '')
);

-- CreateIndex
CREATE UNIQUE INDEX "task_chains_number_key" ON "task_chains"("number");

-- CreateIndex
CREATE INDEX "task_chains_owner_id_idx" ON "task_chains"("owner_id");

-- Подсказка: открытые цепочки с тем же ключом (ключ не уникален, дубли допустимы).
CREATE INDEX "task_chains_open_key_idx" ON "task_chains"("title_key") WHERE "status" = 'open' AND "deleted_at" IS NULL;

-- Подсказка «Вернуть в работу»: закрытые цепочки с тем же ключом, по дате закрытия.
CREATE INDEX "task_chains_closed_key_idx" ON "task_chains"("title_key", "closed_at") WHERE "status" = 'closed' AND "deleted_at" IS NULL;

-- Состав цепочки: только задачи с цепочкой.
CREATE INDEX "tasks_chain_id_idx" ON "tasks"("chain_id") WHERE "chain_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "task_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_chains" ADD CONSTRAINT "task_chains_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_chains" ADD CONSTRAINT "task_chains_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
