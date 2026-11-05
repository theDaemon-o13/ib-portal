-- Учебные письма и расписание рассылок (1.9.0, ADR-0039, ADR-0040; docs/specs/awareness.md, часть 2;
-- docs/plans/release-1.9.0.md, раздел «Схема»). Семь новых таблиц:
--   awareness_templates        — шаблоны писем с переменными {{…}};
--   awareness_fragments        — системный фрагмент «Подпись ИБ» (строку создаёт seed, не миграция);
--   awareness_letters          — письма: статус, заморозка отправленного, ссылки на текущую, утверждённую и
--                                отправленную версии;
--   awareness_letter_versions  — версии письма, только пополняются;
--   awareness_letter_events    — события: согласование, возврат, отправка, архив; только пополняются;
--   awareness_schedule_rules   — правила расписания;
--   awareness_schedule_runs    — запуски правил: «правило + номинальная дата» уникальны (идемпотентность прогона).
--
-- Влияние на данные: добавляются новые таблицы, существующие данные не меняются (0 строк). Существующие таблицы
-- (users, roles, tasks, register_records) получают только входящие внешние ключи из новых таблиц; их столбцы,
-- ограничения и триггеры не меняются, tasks_source_check не меняется.
-- Откат на 1.8.0 без отката базы совместим: 1.8.0 новые таблицы не читает; задачи модуля — обычные строки tasks с
-- source = 'manual', без автора (created_by NULL), и task_candidates; связь с письмом и правилом — только в таблицах
-- модуля (tasks_automation_check требует automation_id у source = 'automation', поэтому не 'automation'; решение
-- владельца 05.11.2026, вариант A). Откатывать саму миграцию не нужно; если понадобится — DROP новых таблиц
-- (только после резервной копии: в них письма).
--
-- Заморозка (условие владельца 05.11.2026): у отправленного письма (frozen) нельзя менять тему, текст, статус и
-- версии — новые версии не добавляются, старые не меняются никогда; меняются только archived_at (архив и возврат),
-- version и updated_at. Письма, версии и события физически не удаляются (раздел 3.4 CLAUDE.md).

-- CreateTable
CREATE TABLE "awareness_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "subject_ru" TEXT NOT NULL DEFAULT '',
    "subject_tj" TEXT NOT NULL DEFAULT '',
    "html_ru" TEXT NOT NULL DEFAULT '',
    "html_tj" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "awareness_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "awareness_fragments" (
    "code" TEXT NOT NULL,
    "html_ru" TEXT NOT NULL,
    "html_tj" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "awareness_fragments_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "awareness_letters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "template_id" UUID,
    "task_id" UUID,
    "current_version_id" UUID,
    "approved_version_id" UUID,
    "sent_version_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "awareness_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "awareness_letter_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "letter_id" UUID NOT NULL,
    "no" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "restored_from" INTEGER,
    "subject_ru" TEXT NOT NULL,
    "subject_tj" TEXT NOT NULL,
    "html_ru" TEXT NOT NULL,
    "html_tj" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "awareness_letter_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "awareness_letter_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "letter_id" UUID NOT NULL,
    "version_id" UUID,
    "action" TEXT NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "self_approved" BOOLEAN NOT NULL DEFAULT false,
    "without_approval" BOOLEAN NOT NULL DEFAULT false,
    "sent_on" DATE,
    "audience" TEXT,
    "record_id" UUID,
    "task_id" UUID,
    "actor_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "awareness_letter_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "awareness_schedule_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "cadence" JSONB NOT NULL,
    "starts_on" DATE NOT NULL,
    "lead_days" INTEGER NOT NULL DEFAULT 10,
    "role_id" UUID NOT NULL,
    "template_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "awareness_schedule_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "awareness_schedule_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rule_id" UUID NOT NULL,
    "nominal_date" DATE NOT NULL,
    "planned_date" DATE NOT NULL,
    "draft_due" DATE NOT NULL,
    "review_due" DATE NOT NULL,
    "task_id" UUID NOT NULL,
    "letter_id" UUID,
    "escalated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "awareness_schedule_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "awareness_letters_number_key" ON "awareness_letters"("number");

-- CreateIndex
CREATE INDEX "awareness_letters_task_id_idx" ON "awareness_letters"("task_id");

-- CreateIndex
CREATE INDEX "awareness_letters_status_archived_at_idx" ON "awareness_letters"("status", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "awareness_letters_current_version_id_key" ON "awareness_letters"("current_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "awareness_letters_approved_version_id_key" ON "awareness_letters"("approved_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "awareness_letters_sent_version_id_key" ON "awareness_letters"("sent_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "awareness_letter_versions_letter_id_no_key" ON "awareness_letter_versions"("letter_id", "no");

-- CreateIndex
CREATE INDEX "awareness_letter_events_letter_id_at_idx" ON "awareness_letter_events"("letter_id", "at");

-- CreateIndex
CREATE INDEX "awareness_letter_events_action_sent_on_idx" ON "awareness_letter_events"("action", "sent_on");

-- CreateIndex
CREATE UNIQUE INDEX "awareness_schedule_runs_task_id_key" ON "awareness_schedule_runs"("task_id");

-- CreateIndex
CREATE INDEX "awareness_schedule_runs_rule_id_planned_date_idx" ON "awareness_schedule_runs"("rule_id", "planned_date");

-- CreateIndex
CREATE INDEX "awareness_schedule_runs_letter_id_idx" ON "awareness_schedule_runs"("letter_id");

-- CreateIndex
CREATE UNIQUE INDEX "awareness_schedule_runs_rule_id_nominal_date_key" ON "awareness_schedule_runs"("rule_id", "nominal_date");

-- AddForeignKey
ALTER TABLE "awareness_templates" ADD CONSTRAINT "awareness_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_templates" ADD CONSTRAINT "awareness_templates_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_fragments" ADD CONSTRAINT "awareness_fragments_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letters" ADD CONSTRAINT "awareness_letters_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "awareness_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letters" ADD CONSTRAINT "awareness_letters_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letters" ADD CONSTRAINT "awareness_letters_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letters" ADD CONSTRAINT "awareness_letters_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "awareness_letter_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letters" ADD CONSTRAINT "awareness_letters_approved_version_id_fkey" FOREIGN KEY ("approved_version_id") REFERENCES "awareness_letter_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letters" ADD CONSTRAINT "awareness_letters_sent_version_id_fkey" FOREIGN KEY ("sent_version_id") REFERENCES "awareness_letter_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_versions" ADD CONSTRAINT "awareness_letter_versions_letter_id_fkey" FOREIGN KEY ("letter_id") REFERENCES "awareness_letters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_versions" ADD CONSTRAINT "awareness_letter_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_events" ADD CONSTRAINT "awareness_letter_events_letter_id_fkey" FOREIGN KEY ("letter_id") REFERENCES "awareness_letters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_events" ADD CONSTRAINT "awareness_letter_events_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "awareness_letter_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_events" ADD CONSTRAINT "awareness_letter_events_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "register_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_events" ADD CONSTRAINT "awareness_letter_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_letter_events" ADD CONSTRAINT "awareness_letter_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_schedule_rules" ADD CONSTRAINT "awareness_schedule_rules_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_schedule_rules" ADD CONSTRAINT "awareness_schedule_rules_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "awareness_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_schedule_rules" ADD CONSTRAINT "awareness_schedule_rules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_schedule_runs" ADD CONSTRAINT "awareness_schedule_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "awareness_schedule_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_schedule_runs" ADD CONSTRAINT "awareness_schedule_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "awareness_schedule_runs" ADD CONSTRAINT "awareness_schedule_runs_letter_id_fkey" FOREIGN KEY ("letter_id") REFERENCES "awareness_letters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ——— Ограничения, которых нет в schema.prisma ———

ALTER TABLE "awareness_templates"
  ADD CONSTRAINT "awareness_templates_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "awareness_templates_version_check" CHECK ("version" >= 1);

ALTER TABLE "awareness_fragments"
  ADD CONSTRAINT "awareness_fragments_code_check" CHECK ("code" IN ('signature')),
  ADD CONSTRAINT "awareness_fragments_version_check" CHECK ("version" >= 1);

ALTER TABLE "awareness_letters"
  ADD CONSTRAINT "awareness_letters_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "awareness_letters_kind_check" CHECK ("kind" IN ('planned', 'urgent')),
  ADD CONSTRAINT "awareness_letters_status_check" CHECK ("status" IN ('draft', 'review', 'approved', 'sent')),
  -- Повод обязателен для срочного письма.
  ADD CONSTRAINT "awareness_letters_reason_check" CHECK ("kind" <> 'urgent' OR length(btrim("reason")) > 0),
  -- Отправленное = замороженное, и у него есть версия отправки.
  ADD CONSTRAINT "awareness_letters_frozen_check" CHECK ("frozen" = ("status" = 'sent') AND (NOT "frozen" OR "sent_version_id" IS NOT NULL)),
  -- Утверждённое ссылается на утверждённую версию.
  ADD CONSTRAINT "awareness_letters_approved_check" CHECK ("status" <> 'approved' OR "approved_version_id" IS NOT NULL),
  ADD CONSTRAINT "awareness_letters_version_check" CHECK ("version" >= 1);

ALTER TABLE "awareness_letter_versions"
  ADD CONSTRAINT "awareness_letter_versions_no_check" CHECK ("no" >= 1),
  ADD CONSTRAINT "awareness_letter_versions_reason_check" CHECK ("reason" IN ('created', 'edit', 'restore', 'template', 'copy', 'sent')),
  ADD CONSTRAINT "awareness_letter_versions_restored_check" CHECK (
    ("reason" = 'restore') = ("restored_from" IS NOT NULL) AND ("restored_from" IS NULL OR "restored_from" BETWEEN 1 AND "no" - 1));

ALTER TABLE "awareness_letter_events"
  ADD CONSTRAINT "awareness_letter_events_action_check" CHECK (
    "action" IN ('submitted', 'withdrawn', 'approved', 'returned', 'approval_dropped', 'sent', 'archived', 'unarchived')),
  -- Отправка — с датой и аудиторией; у остальных событий даты отправки нет.
  ADD CONSTRAINT "awareness_letter_events_sent_check" CHECK (
    ("action" = 'sent') = ("sent_on" IS NOT NULL) AND ("action" <> 'sent' OR length(btrim(coalesce("audience", ''))) > 0)),
  -- Возврат на доработку — только с комментарием.
  ADD CONSTRAINT "awareness_letter_events_returned_check" CHECK ("action" <> 'returned' OR length(btrim("comment")) > 0),
  -- «Отправлено без согласования» — только отметка отправки и только с причиной.
  ADD CONSTRAINT "awareness_letter_events_without_approval_check" CHECK (
    NOT "without_approval" OR ("action" = 'sent' AND length(btrim("comment")) > 0)),
  ADD CONSTRAINT "awareness_letter_events_self_approved_check" CHECK (NOT "self_approved" OR "action" = 'approved');

ALTER TABLE "awareness_schedule_rules"
  ADD CONSTRAINT "awareness_schedule_rules_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "awareness_schedule_rules_lead_check" CHECK ("lead_days" BETWEEN 7 AND 90),
  ADD CONSTRAINT "awareness_schedule_rules_cadence_check" CHECK (
    jsonb_typeof("cadence") = 'object' AND "cadence" ->> 'kind' IN ('monthly', 'twice_monthly', 'quarterly', 'yearly', 'weekly')),
  ADD CONSTRAINT "awareness_schedule_rules_version_check" CHECK ("version" >= 1);

ALTER TABLE "awareness_schedule_runs"
  -- Перенос только назад; этапы по порядку: черновик ≤ согласование ≤ отправка.
  ADD CONSTRAINT "awareness_schedule_runs_dates_check" CHECK (
    "planned_date" <= "nominal_date" AND "draft_due" <= "review_due" AND "review_due" <= "planned_date");

-- ——— Триггеры ———

-- Версии и события письма только пополняются.
CREATE OR REPLACE FUNCTION awareness_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: только пополняется (% запрещён)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER awareness_letter_versions_append_only BEFORE UPDATE OR DELETE ON "awareness_letter_versions"
  FOR EACH ROW EXECUTE FUNCTION awareness_append_only();
CREATE TRIGGER awareness_letter_events_append_only BEFORE UPDATE OR DELETE ON "awareness_letter_events"
  FOR EACH ROW EXECUTE FUNCTION awareness_append_only();

-- Новая версия у отправленного письма запрещена. Строка письма блокируется на чтение: заморозка в параллельной
-- транзакции дождётся вставки или вставка — заморозки.
CREATE OR REPLACE FUNCTION awareness_letter_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  is_frozen boolean;
BEGIN
  SELECT "frozen" INTO is_frozen FROM "awareness_letters" WHERE "id" = NEW."letter_id" FOR SHARE;
  IF is_frozen THEN
    RAISE EXCEPTION 'awareness_letter_versions: письмо отправлено — новых версий нет' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER awareness_letter_versions_guard BEFORE INSERT ON "awareness_letter_versions"
  FOR EACH ROW EXECUTE FUNCTION awareness_letter_versions_guard();

-- Письмо: у замороженного меняются только archived_at, version и updated_at; ссылки на версии — только на версии
-- этого письма, версия отправки — с причиной sent; физического удаления нет.
CREATE OR REPLACE FUNCTION awareness_letters_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  free text[] := ARRAY['archived_at', 'version', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'awareness_letters: письмо не удаляется — только архив' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."frozen" AND (to_jsonb(NEW) - free) IS DISTINCT FROM (to_jsonb(OLD) - free) THEN
    RAISE EXCEPTION 'awareness_letters: письмо отправлено — меняется только архив' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[NEW."current_version_id", NEW."approved_version_id", NEW."sent_version_id"]) AS v(id)
    WHERE v.id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "awareness_letter_versions" x WHERE x."id" = v.id AND x."letter_id" = NEW."id")
  ) THEN
    RAISE EXCEPTION 'awareness_letters: ссылка на версию другого письма' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sent_version_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "awareness_letter_versions" x WHERE x."id" = NEW."sent_version_id" AND x."reason" = 'sent') THEN
    RAISE EXCEPTION 'awareness_letters: версия отправки должна быть версией sent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER awareness_letters_guard BEFORE INSERT OR UPDATE OR DELETE ON "awareness_letters"
  FOR EACH ROW EXECUTE FUNCTION awareness_letters_guard();

-- ——— Права роли приложения (ADR-0002) ———
-- Права на новые таблицы роль ibportal_app получила через ALTER DEFAULT PRIVILEGES; здесь — только сужение.
-- Версии и события — только INSERT и SELECT; остальные таблицы — без физического удаления (мягкое, раздел 3.4).
REVOKE UPDATE, DELETE, TRUNCATE ON "awareness_letter_versions", "awareness_letter_events" FROM ibportal_app;
REVOKE DELETE, TRUNCATE ON "awareness_letters", "awareness_templates", "awareness_fragments",
  "awareness_schedule_rules", "awareness_schedule_runs" FROM ibportal_app;
