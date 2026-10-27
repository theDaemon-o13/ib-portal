-- Этап 6 «Документы»: реестр внутренних документов ИБ, версии, маршрут согласования
-- (Автор → Начальник ИБ → Юридический отдел → Утверждение правлением), контроль пересмотра (ADR-0010).
--
-- Влияние на данные: создаются 3 новые пустые таблицы (documents, document_versions, document_approvals).
-- В существующие таблицы добавляются колонки со значением NULL, значения существующих строк не меняются:
--   automation_events.document_id — событие пересмотра документа;
--   tasks.document_id, tasks.document_reason — задача по документу (пересмотр, возврат на доработку).
-- У automation_events.register_id, record_id, automation_id снимается NOT NULL (расширение); новое
-- ограничение automation_events_subject_check требует, чтобы у каждой существующей строки все три были
-- заданы, — так и есть. tasks_source_check пересоздаётся с более широким списком (добавлен 'document').
-- Затронуто 0 строк данных; проверено на dev перед применением (см. CHANGELOG).
-- Системную категорию задач «Документы» добавляет seed (однократно).
-- Совместима с backend предыдущей версии: он читает события только по реестру или записи и события
-- в статусе 'new' (событие документа обрабатывается в той же транзакции, где создаётся), а его вставки
-- задач и событий проходят новые ограничения. Откат приложения без отката базы.

-- AlterTable
ALTER TABLE "public"."automation_events" ADD COLUMN     "document_id" UUID,
ALTER COLUMN "register_id" DROP NOT NULL,
ALTER COLUMN "record_id" DROP NOT NULL,
ALTER COLUMN "automation_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "public"."tasks" ADD COLUMN     "document_id" UUID,
ADD COLUMN     "document_reason" TEXT;

-- CreateTable
CREATE TABLE "public"."documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" SERIAL NOT NULL,
    "type_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "review_months" INTEGER NOT NULL DEFAULT 12,
    "review_due" DATE,
    "approved_version_id" UUID,
    "working_version_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."document_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "no" INTEGER NOT NULL,
    "edition" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "onlyoffice_url" TEXT NOT NULL,
    "change_note" TEXT NOT NULL DEFAULT '',
    "stage" SMALLINT NOT NULL DEFAULT 0,
    "round" INTEGER NOT NULL DEFAULT 1,
    "approved_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."document_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "stage" SMALLINT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "actor_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_number_key" ON "public"."documents"("number");

-- CreateIndex
CREATE UNIQUE INDEX "documents_approved_version_id_key" ON "public"."documents"("approved_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_working_version_id_key" ON "public"."documents"("working_version_id");

-- CreateIndex
CREATE INDEX "documents_owner_id_idx" ON "public"."documents"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_no_key" ON "public"."document_versions"("document_id", "no");

-- CreateIndex
CREATE INDEX "document_approvals_document_id_at_idx" ON "public"."document_approvals"("document_id", "at");

-- CreateIndex
CREATE INDEX "document_approvals_version_id_round_idx" ON "public"."document_approvals"("version_id", "round");

-- CreateIndex
CREATE INDEX "tasks_document_id_idx" ON "public"."tasks"("document_id");

-- AddForeignKey
ALTER TABLE "public"."automation_events" ADD CONSTRAINT "automation_events_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."documents" ADD CONSTRAINT "documents_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "public"."catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."documents" ADD CONSTRAINT "documents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."documents" ADD CONSTRAINT "documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."documents" ADD CONSTRAINT "documents_approved_version_id_fkey" FOREIGN KEY ("approved_version_id") REFERENCES "public"."document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."documents" ADD CONSTRAINT "documents_working_version_id_fkey" FOREIGN KEY ("working_version_id") REFERENCES "public"."document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_versions" ADD CONSTRAINT "document_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_approvals" ADD CONSTRAINT "document_approvals_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_approvals" ADD CONSTRAINT "document_approvals_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."document_approvals" ADD CONSTRAINT "document_approvals_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Дополнения вручную (Prisma 6 их не описывает: CHECK, частичные индексы, триггеры, права).
-- ---------------------------------------------------------------------------

-- Событие либо реестра (реестр, запись, правило), либо документа.
ALTER TABLE "public"."automation_events"
  ADD CONSTRAINT "automation_events_subject_check" CHECK (
    ("document_id" IS NULL) = ("register_id" IS NOT NULL AND "record_id" IS NOT NULL AND "automation_id" IS NOT NULL)
  );
-- Одно событие на документ и дату пересмотра: повторный прогон дублей не создаёт, перенос даты — новое событие.
CREATE UNIQUE INDEX "automation_events_document_uq"
  ON "public"."automation_events" ("document_id", "trigger_key") WHERE "document_id" IS NOT NULL;

ALTER TABLE "public"."tasks"
  DROP CONSTRAINT "tasks_source_check",
  ADD CONSTRAINT "tasks_source_check" CHECK ("source" IN ('manual', 'mail', 'automation', 'document')),
  -- Задача по документу всегда знает документ и причину; остальные — нет.
  ADD CONSTRAINT "tasks_document_check" CHECK (
    ("source" = 'document') = ("document_id" IS NOT NULL)
    AND ("document_id" IS NULL) = ("document_reason" IS NULL)
    AND ("document_reason" IS NULL OR "document_reason" IN ('review', 'returned'))
  );
-- Одна открытая задача на (документ, причина, ответственный); повтор — комментарий в ней.
CREATE UNIQUE INDEX "tasks_doc_open_uq"
  ON "public"."tasks" ("document_id", "document_reason", "assignee_id") NULLS NOT DISTINCT
  WHERE "document_id" IS NOT NULL AND "completed_at" IS NULL AND "archived_at" IS NULL AND "deleted_at" IS NULL;

ALTER TABLE "public"."documents"
  ADD CONSTRAINT "documents_number_check" CHECK ("number" >= 1),
  ADD CONSTRAINT "documents_review_months_check" CHECK ("review_months" BETWEEN 1 AND 60),
  ADD CONSTRAINT "documents_has_version_check" CHECK ("approved_version_id" IS NOT NULL OR "working_version_id" IS NOT NULL),
  ADD CONSTRAINT "documents_versions_distinct_check" CHECK ("approved_version_id" IS DISTINCT FROM "working_version_id"),
  ADD CONSTRAINT "documents_review_due_check" CHECK (("approved_version_id" IS NULL) = ("review_due" IS NULL));

ALTER TABLE "public"."document_versions"
  ADD CONSTRAINT "document_versions_no_check" CHECK ("no" >= 1),
  ADD CONSTRAINT "document_versions_edition_check" CHECK (length("edition") <= 20),
  ADD CONSTRAINT "document_versions_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 300),
  ADD CONSTRAINT "document_versions_url_check"
    CHECK ("onlyoffice_url" ~* '^https?://[^[:space:]]+$' AND length("onlyoffice_url") <= 2000),
  ADD CONSTRAINT "document_versions_change_note_check" CHECK (length("change_note") <= 4000),
  ADD CONSTRAINT "document_versions_stage_check" CHECK ("stage" BETWEEN 0 AND 3),
  ADD CONSTRAINT "document_versions_round_check" CHECK ("round" >= 1),
  -- Утверждает только последний этап.
  ADD CONSTRAINT "document_versions_approved_check" CHECK ("approved_at" IS NULL OR "stage" = 3);

ALTER TABLE "public"."document_approvals"
  ADD CONSTRAINT "document_approvals_stage_check" CHECK ("stage" BETWEEN 0 AND 3),
  ADD CONSTRAINT "document_approvals_decision_check"
    CHECK ("decision" IN ('submitted', 'approved', 'returned', 'revision_started')),
  -- Возврат на доработку — только с комментарием.
  ADD CONSTRAINT "document_approvals_comment_check" CHECK (
    length("comment") <= 4000 AND ("decision" <> 'returned' OR length(btrim("comment")) >= 1)
  );
-- Этап одной версии в одном круге согласуется один раз: двойное согласование невозможно и при гонке.
CREATE UNIQUE INDEX "document_approvals_stage_once_uq"
  ON "public"."document_approvals" ("version_id", "round", "stage") WHERE "decision" IN ('submitted', 'approved');

-- История согласования только пополняется (как register_decisions и audit_log).
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."document_approvals" FROM ibportal_app;

CREATE FUNCTION document_approvals_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_approvals только пополняется: % запрещён', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER document_approvals_no_update_delete
  BEFORE UPDATE OR DELETE ON "public"."document_approvals"
  FOR EACH ROW EXECUTE FUNCTION document_approvals_append_only();

CREATE TRIGGER document_approvals_no_truncate
  BEFORE TRUNCATE ON "public"."document_approvals"
  FOR EACH STATEMENT EXECUTE FUNCTION document_approvals_append_only();

-- Версии не удаляются; утверждённая версия не меняется. Рабочую версию (черновик, маршрут) править можно.
REVOKE DELETE, TRUNCATE ON "public"."document_versions" FROM ibportal_app;

CREATE FUNCTION document_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."approved_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document_versions: утверждённая версия не меняется, версии не удаляются (% запрещён)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER document_versions_guard
  BEFORE UPDATE OR DELETE ON "public"."document_versions"
  FOR EACH ROW EXECUTE FUNCTION document_versions_guard();

CREATE TRIGGER document_versions_no_truncate
  BEFORE TRUNCATE ON "public"."document_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION document_versions_guard();
