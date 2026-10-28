-- Релиз 1.1.0, задача 2: журнал запусков автоматизаций (вкладка «Журнал запусков»).
-- Влияние на данные: новая пустая таблица automation_runs, существующие строки не меняются.
-- Права ibportal_app (SELECT, INSERT, UPDATE, DELETE) — через ALTER DEFAULT PRIVILEGES (db/init/01-app-role.sh).
-- Откат: backend 1.0.1 таблицу не читает; удалять её при откате не нужно.

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "register_id" UUID,
    "trigger" TEXT NOT NULL,
    "actor_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "rules" INTEGER NOT NULL DEFAULT 0,
    "checked" INTEGER NOT NULL DEFAULT 0,
    "events_created" INTEGER NOT NULL DEFAULT 0,
    "tasks_created" INTEGER NOT NULL DEFAULT 0,
    "tasks_commented" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_runs_register_id_started_at_idx" ON "automation_runs"("register_id", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
