-- Этап 5 «Задачи»: доска задач, комментарии, исходное письмо, задачи из событий автоматизаций;
-- метки «Получатели уведомлений» → пользователи; поле реестра «Значение справочника».
--
-- Влияние на данные: создаются 5 новых пустых таблиц (tasks, task_mail_sources, task_comments,
-- automation_event_tasks, catalog_item_users). В существующие таблицы добавляются 2 колонки,
-- значения существующих строк не меняются:
--   catalog_items.emails — '{}' (адресов нет);
--   register_fields.catalog_code — NULL (полей типа «Значение справочника» ещё нет).
-- Ограничения register_fields_type_check и register_fields_analytics_check пересоздаются с более
-- широким списком (добавлен тип 'catalog'): все существующие строки им соответствуют.
-- ADD COLUMN с константой по умолчанию в PostgreSQL 16 не переписывает таблицу. Затронуто 0 строк данных.
-- Справочник «Получатели уведомлений», его системные метки и поле «Система» реестра уязвимостей
-- добавляет seed (однократно).
-- Совместима с backend предыдущей версии: он новые таблицы и колонки не читает, значения по умолчанию
-- подходят его вставкам, а прежние типы полей по-прежнему разрешены. Откат приложения без отката базы.

-- AlterTable
ALTER TABLE "public"."catalog_items" ADD COLUMN     "emails" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "public"."register_fields" ADD COLUMN     "catalog_code" TEXT;

-- CreateTable
CREATE TABLE "public"."catalog_item_users" (
    "item_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "catalog_item_users_pkey" PRIMARY KEY ("item_id","user_id")
);

-- CreateTable
CREATE TABLE "public"."tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status_id" UUID NOT NULL,
    "priority_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "assignee_id" UUID,
    "due_date" DATE,
    "source" TEXT NOT NULL,
    "record_id" UUID,
    "automation_id" UUID,
    "recipient_label" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."task_mail_sources" (
    "task_id" UUID NOT NULL,
    "from_text" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "sent_text" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "mail_rule_id" UUID,
    "rule_hits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "due_reason" TEXT NOT NULL,

    CONSTRAINT "task_mail_sources_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "public"."task_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "author_id" UUID,
    "event_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."automation_event_tasks" (
    "event_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "action" TEXT NOT NULL,

    CONSTRAINT "automation_event_tasks_pkey" PRIMARY KEY ("event_id","task_id")
);

-- CreateIndex
CREATE INDEX "catalog_item_users_user_id_idx" ON "public"."catalog_item_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_number_key" ON "public"."tasks"("number");

-- CreateIndex
CREATE INDEX "tasks_status_id_idx" ON "public"."tasks"("status_id");

-- CreateIndex
CREATE INDEX "tasks_assignee_id_due_date_idx" ON "public"."tasks"("assignee_id", "due_date");

-- CreateIndex
CREATE INDEX "tasks_record_id_idx" ON "public"."tasks"("record_id");

-- CreateIndex
CREATE INDEX "task_comments_task_id_created_at_idx" ON "public"."task_comments"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "automation_event_tasks_task_id_idx" ON "public"."automation_event_tasks"("task_id");

-- AddForeignKey
ALTER TABLE "public"."register_fields" ADD CONSTRAINT "register_fields_catalog_code_fkey" FOREIGN KEY ("catalog_code") REFERENCES "public"."catalogs"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."catalog_item_users" ADD CONSTRAINT "catalog_item_users_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."catalog_item_users" ADD CONSTRAINT "catalog_item_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "public"."catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_priority_id_fkey" FOREIGN KEY ("priority_id") REFERENCES "public"."catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."register_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "public"."register_automations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."task_mail_sources" ADD CONSTRAINT "task_mail_sources_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."task_mail_sources" ADD CONSTRAINT "task_mail_sources_mail_rule_id_fkey" FOREIGN KEY ("mail_rule_id") REFERENCES "public"."catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."task_comments" ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."task_comments" ADD CONSTRAINT "task_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."task_comments" ADD CONSTRAINT "task_comments_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."automation_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."automation_event_tasks" ADD CONSTRAINT "automation_event_tasks_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."automation_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."automation_event_tasks" ADD CONSTRAINT "automation_event_tasks_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Дополнения вручную (Prisma 6 их не описывает: CHECK, частичные индексы).
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."catalog_items"
  ADD CONSTRAINT "catalog_items_emails_check" CHECK ("emails" IS NOT NULL);

-- Тип «Значение справочника»: catalog_code задан тогда и только тогда, когда type = 'catalog'.
ALTER TABLE "public"."register_fields"
  DROP CONSTRAINT "register_fields_type_check",
  ADD CONSTRAINT "register_fields_type_check"
    CHECK ("type" IN ('text', 'select', 'number', 'date', 'user', 'calc', 'decision', 'catalog')),
  DROP CONSTRAINT "register_fields_analytics_check",
  ADD CONSTRAINT "register_fields_analytics_check" CHECK (
    "analytics_role" IS NULL
    OR ("type" IN ('select', 'decision', 'user', 'catalog') AND "analytics_role" = 'dimension')
    OR ("type" = 'number' AND "analytics_role" = 'metric')
    OR ("type" IN ('date', 'calc') AND "analytics_role" IN ('date', 'deadline'))
  ),
  ADD CONSTRAINT "register_fields_catalog_check" CHECK (("type" = 'catalog') = ("catalog_code" IS NOT NULL));

ALTER TABLE "public"."tasks"
  ADD CONSTRAINT "tasks_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 300),
  ADD CONSTRAINT "tasks_description_check" CHECK (length("description") <= 20000),
  ADD CONSTRAINT "tasks_source_check" CHECK ("source" IN ('manual', 'mail', 'automation')),
  -- Задача автоматизации всегда знает запись и правило; ручная и из письма — нет.
  ADD CONSTRAINT "tasks_automation_check"
    CHECK (("source" = 'automation') = ("record_id" IS NOT NULL AND "automation_id" IS NOT NULL));

-- Одна открытая задача на (правило, запись, ответственный); NULLS NOT DISTINCT — и для «не назначен».
-- Повторное событие по той же записи и правилу добавляет комментарий в эту задачу.
CREATE UNIQUE INDEX "tasks_auto_open_uq" ON "public"."tasks" ("automation_id", "record_id", "assignee_id") NULLS NOT DISTINCT
  WHERE "automation_id" IS NOT NULL AND "completed_at" IS NULL AND "archived_at" IS NULL AND "deleted_at" IS NULL;

-- Доска: живые задачи по статусу и сроку.
CREATE INDEX "tasks_board_idx" ON "public"."tasks" ("status_id", "due_date") WHERE "deleted_at" IS NULL;

ALTER TABLE "public"."task_mail_sources"
  ADD CONSTRAINT "task_mail_sources_rule_hits_check" CHECK ("rule_hits" IS NOT NULL),
  ADD CONSTRAINT "task_mail_sources_raw_check" CHECK (length("raw") <= 100000);

ALTER TABLE "public"."task_comments"
  ADD CONSTRAINT "task_comments_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 4000);

ALTER TABLE "public"."automation_event_tasks"
  ADD CONSTRAINT "automation_event_tasks_action_check" CHECK ("action" IN ('created', 'commented'));
