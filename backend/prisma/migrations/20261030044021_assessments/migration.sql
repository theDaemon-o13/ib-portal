-- Релиз 1.3.0, этап Д1: самооценка уровня кибербезопасности (docs/self-assessment.md, ADR-0025, ADR-0026).
--
-- Влияние на данные: четыре новые пустые таблицы; существующие таблицы и строки не меняются (затронуто 0 строк).
-- Seed добавляет код права assessment.manage, системную роль «Самооценка» без пользователей и методику cyber-express-v1.
-- Откат: backend 1.2.0 новые таблицы не читает; незнакомое право в сумме прав не учитывается.

-- CreateTable
CREATE TABLE "assessment_methodologies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "assessment_methodologies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "methodology_id" UUID NOT NULL,
    "methodology_snapshot" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "assessed_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "profile" JSONB NOT NULL DEFAULT '{}',
    "previous_id" UUID,
    "result" JSONB,
    "finalized_by" UUID,
    "finalized_at" TIMESTAMPTZ(3),
    "reopen_comment" TEXT NOT NULL DEFAULT '',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_answers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assessment_id" UUID NOT NULL,
    "section_code" TEXT NOT NULL,
    "level" SMALLINT,
    "target_level" SMALLINT,
    "comment" TEXT NOT NULL DEFAULT '',
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "assessment_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "answer_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assessment_methodologies_code_version_key" ON "assessment_methodologies"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_answers_assessment_id_section_code_key" ON "assessment_answers"("assessment_id", "section_code");

-- CreateIndex
CREATE INDEX "assessment_links_entity_type_entity_id_idx" ON "assessment_links"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_links_answer_id_entity_type_entity_id_key" ON "assessment_links"("answer_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_methodology_id_fkey" FOREIGN KEY ("methodology_id") REFERENCES "assessment_methodologies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_previous_id_fkey" FOREIGN KEY ("previous_id") REFERENCES "assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_finalized_by_fkey" FOREIGN KEY ("finalized_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_answers" ADD CONSTRAINT "assessment_answers_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_answers" ADD CONSTRAINT "assessment_answers_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_links" ADD CONSTRAINT "assessment_links_answer_id_fkey" FOREIGN KEY ("answer_id") REFERENCES "assessment_answers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_links" ADD CONSTRAINT "assessment_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assessment_methodologies"
  ADD CONSTRAINT "assessment_methodologies_version_check" CHECK ("version" >= 1);
-- Активна одна версия методики на код.
CREATE UNIQUE INDEX "assessment_methodologies_active_uq" ON "assessment_methodologies" ("code") WHERE "is_active";

ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "assessments_status_check" CHECK ("status" IN ('draft', 'final', 'archived')),
  ADD CONSTRAINT "assessments_reopen_comment_check" CHECK (length("reopen_comment") <= 4000),
  -- Зафиксированная — с замороженным итогом; черновик — без него (итог считается при чтении).
  ADD CONSTRAINT "assessments_final_check" CHECK ("status" <> 'final' OR ("result" IS NOT NULL AND "finalized_at" IS NOT NULL)),
  ADD CONSTRAINT "assessments_draft_check" CHECK ("status" <> 'draft' OR "result" IS NULL),
  ADD CONSTRAINT "assessments_archived_check" CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL));
-- Одна оценка в работе (правило 10).
CREATE UNIQUE INDEX "assessments_one_draft_uq" ON "assessments" ((true)) WHERE "status" = 'draft';
-- Удаления нет — только архив (ADR-0026).
REVOKE DELETE, TRUNCATE ON "assessments", "assessment_answers", "assessment_links" FROM ibportal_app;

ALTER TABLE "assessment_answers"
  ADD CONSTRAINT "assessment_answers_level_check" CHECK ("level" BETWEEN 1 AND 4),
  ADD CONSTRAINT "assessment_answers_target_check" CHECK ("target_level" BETWEEN 1 AND 4),
  ADD CONSTRAINT "assessment_answers_comment_check" CHECK (length("comment") <= 4000);

-- Ответ меняется только в черновике (правило 9): проверка в сервисе (409) и триггер в БД.
CREATE FUNCTION assessment_answers_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT "status" FROM "assessments" WHERE "id" = NEW."assessment_id") <> 'draft' THEN
    RAISE EXCEPTION 'assessment_answers: ответы меняются только в черновике' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "assessment_answers_draft_only"
  BEFORE UPDATE ON "assessment_answers"
  FOR EACH ROW EXECUTE FUNCTION assessment_answers_draft_only();

ALTER TABLE "assessment_links"
  ADD CONSTRAINT "assessment_links_type_check" CHECK ("entity_type" IN ('task', 'evidence', 'document'));
