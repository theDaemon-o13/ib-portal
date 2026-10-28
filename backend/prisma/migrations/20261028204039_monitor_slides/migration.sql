-- Релиз 1.1.0, задача 6: слайды экрана мониторинга (ADR-0019). Одна настройка на все настенные мониторы.
-- Влияние на данные: новая таблица; шаг seed (однократно) заводит слайды, повторяющие нынешний экран:
-- «Ключевые показатели», «Уязвимости по срокам», «Задачи», «Документы», «Решения ОУР», «Доказательства» —
-- 6 строк. Другие таблицы не меняются. Откат: backend 1.0.1 таблицу не читает и показывает прежний экран.

-- CreateTable
CREATE TABLE "monitor_slides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 12,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "skip_empty" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "monitor_slides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monitor_slides_sort_order_idx" ON "monitor_slides"("sort_order");

-- AddForeignKey
ALTER TABLE "monitor_slides" ADD CONSTRAINT "monitor_slides_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Вид слайда, название, время показа: правила продукта — и в БД.

ALTER TABLE "monitor_slides" ADD CONSTRAINT "monitor_slides_kind_check" CHECK ("kind" IN ('kpis', 'vulns', 'tasks', 'documents', 'risks', 'evidence', 'dlp'));

ALTER TABLE "monitor_slides" ADD CONSTRAINT "monitor_slides_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 120);

ALTER TABLE "monitor_slides" ADD CONSTRAINT "monitor_slides_seconds_check" CHECK ("seconds" BETWEEN 5 AND 300);
