-- Релиз 1.1.0, задача 5: раскладка дашборда пользователя или по умолчанию для роли (ADR-0018).
-- Влияние на данные: новая пустая таблица, существующие строки не меняются (раскладки ролей заводит seed).
-- Откат: backend 1.0.1 таблицу не читает. «Сбросить» удаляет строку пользователя физически (настройка
-- интерфейса, не бизнес-данные) — с записью в журнале аудита.

-- CreateTable
CREATE TABLE "dashboard_layouts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "role_id" UUID,
    "items" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dashboard_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_layouts_user_id_key" ON "dashboard_layouts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_layouts_role_id_key" ON "dashboard_layouts"("role_id");

-- AddForeignKey
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Раскладка принадлежит ровно одному: пользователю или роли.
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_owner_check" CHECK (("user_id" IS NULL) <> ("role_id" IS NULL));
