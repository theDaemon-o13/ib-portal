-- Релиз 1.11.0, шаг 1: маршрут документа из 4 этапов (21–24) — ADR-0042, docs/plans/release-1.11.0-documents.md.
--
-- Влияние на данные: только новые колонки (NULL или '' у всех существующих строк), новая пустая таблица
-- document_party_rechecks и более широкие ограничения; существующие строки им соответствуют, ни одна не меняется
-- (0 строк). Перенос рабочих версий на этапы 21–24 — шаг seed docs.route.v3 (не эта миграция). Функция
-- file_active_refs() начинает учитывать новые ссылки на файлы — сейчас их нет, ни один счётчик не меняется.
-- Новые триггеры document_translations_frozen и document_parties_frozen запрещают менять новые колонки строк
-- утверждённой версии; существующие строки не трогают (0 строк). Индекс document_approvals_stage_once_uq
-- пересоздаётся с видом решения (event): прежние строки ему соответствуют, данные не меняются.
-- Откат на 1.10.0 без отката базы: новые колонки и таблицу 1.10.0 не читает; версии на 21–24 он не узнаёт и не
-- двигает (документы в работе после отката только читаются); решения нового маршрута — прежними значениями decision.
-- Ручной обратный перенос этапов — docs/rollback/1.11.0-documents-stages.sql (новые колонки не трогает: поэтому
-- route_state на этапах 0–16 не проверяется).

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN "route_state" TEXT,
ADD COLUMN "source_docx_file_id" UUID,
ADD COLUMN "order_no" TEXT NOT NULL DEFAULT '',
ADD COLUMN "order_date" DATE;

-- AlterTable
ALTER TABLE "document_approvals" ADD COLUMN "event" TEXT;

-- AlterTable
ALTER TABLE "document_parties" ADD COLUMN "approved_on" DATE,
ADD COLUMN "due_days" SMALLINT,
ADD COLUMN "reworked_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "document_translations" ADD COLUMN "onlyoffice_url" TEXT NOT NULL DEFAULT '',
ADD COLUMN "source_docx_file_id" UUID,
ADD COLUMN "signed_pdf_file_id" UUID;

-- CreateTable
CREATE TABLE "document_party_rechecks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "prev_approved_at" TIMESTAMPTZ(3) NOT NULL,
    "prev_approved_on" DATE,
    "prev_approved_by" UUID,
    "prev_comment" TEXT NOT NULL DEFAULT '',
    "reworked_at" TIMESTAMPTZ(3),
    "from_due" DATE NOT NULL,
    "to_due" DATE NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "actor_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_party_rechecks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_party_rechecks_party_id_at_idx" ON "document_party_rechecks"("party_id", "at");

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_source_docx_file_id_fkey" FOREIGN KEY ("source_docx_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_translations" ADD CONSTRAINT "document_translations_source_docx_file_id_fkey" FOREIGN KEY ("source_docx_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_translations" ADD CONSTRAINT "document_translations_signed_pdf_file_id_fkey" FOREIGN KEY ("signed_pdf_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_party_rechecks" ADD CONSTRAINT "document_party_rechecks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_party_rechecks" ADD CONSTRAINT "document_party_rechecks_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "document_parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_party_rechecks" ADD CONSTRAINT "document_party_rechecks_prev_approved_by_fkey" FOREIGN KEY ("prev_approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_party_rechecks" ADD CONSTRAINT "document_party_rechecks_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Дополнения вручную (Prisma их не описывает: CHECK, триггеры, права, функции).
-- ---------------------------------------------------------------------------

-- Этапы 21–24 рядом с прежними (0–3, 11–16).
ALTER TABLE "document_versions"
  DROP CONSTRAINT "document_versions_stage_check",
  ADD CONSTRAINT "document_versions_stage_check" CHECK ("stage" BETWEEN 0 AND 3 OR "stage" BETWEEN 11 AND 16 OR "stage" BETWEEN 21 AND 24),
  -- Утверждена — на этапе 3 (до 1.2.0), 16 или 24 с датой подписания (утверждения).
  DROP CONSTRAINT "document_versions_approved_check",
  ADD CONSTRAINT "document_versions_approved_check"
    CHECK ("approved_at" IS NULL OR "stage" = 3 OR ("stage" IN (16, 24) AND "signed_on" IS NOT NULL)),
  -- Состояние внутри этапа 21 и 22; на других этапах значение не проверяется (ручной откат его не трогает).
  ADD CONSTRAINT "document_versions_route_state_check" CHECK (
    ("stage" = 21 AND "route_state" IN ('draft', 'head_review'))
    OR ("stage" = 22 AND "route_state" IN ('parties', 'head_recheck'))
    OR "stage" NOT IN (21, 22)),
  ADD CONSTRAINT "document_versions_order_check" CHECK (length("order_no") <= 100);

ALTER TABLE "document_approvals"
  DROP CONSTRAINT "document_approvals_stage_check",
  ADD CONSTRAINT "document_approvals_stage_check" CHECK ("stage" BETWEEN 0 AND 3 OR "stage" BETWEEN 11 AND 16 OR "stage" BETWEEN 21 AND 24),
  DROP CONSTRAINT "document_approvals_to_stage_check",
  ADD CONSTRAINT "document_approvals_to_stage_check" CHECK ("to_stage" IS NULL OR "to_stage" BETWEEN 11 AND 16 OR "to_stage" BETWEEN 21 AND 24),
  -- «Без независимого согласования» — одобрение начальника ИБ своего документа: этап 13 (1.2.0), 21 и 22 (1.11.0).
  DROP CONSTRAINT "document_approvals_self_check",
  ADD CONSTRAINT "document_approvals_self_check" CHECK (NOT "self_approved" OR ("decision" = 'approved' AND "stage" IN (13, 21, 22))),
  ADD CONSTRAINT "document_approvals_event_check" CHECK ("event" IS NULL OR "event" IN (
    'head_review_requested', 'head_approved', 'head_returned', 'head_recheck_requested', 'head_reapproved', 'recheck_returned',
    'unchanged_confirmed', 'translations_done', 'approved_final'));

-- Этап одной версии в одном круге согласуется один раз — теперь по виду решения: в маршруте 1.11.0 на этапе 21
-- в одном круге два решения (отправлено на проверку и одобрено), на 22 — повторная проверка и повторное одобрение.
-- У прежних решений и у решений 1.10.0 после отката event пуст — для них правило то же, что было.
DROP INDEX "document_approvals_stage_once_uq";
CREATE UNIQUE INDEX "document_approvals_stage_once_uq"
  ON "public"."document_approvals" ("version_id", "round", "stage", (coalesce("event", ''))) WHERE "decision" IN ('submitted', 'approved');

ALTER TABLE "document_parties"
  ADD CONSTRAINT "document_parties_due_days_check" CHECK ("due_days" IS NULL OR "due_days" BETWEEN 1 AND 90);

ALTER TABLE "document_party_rechecks"
  ADD CONSTRAINT "document_party_rechecks_comment_check" CHECK (length("comment") <= 4000);

-- «Запросить повторно» только пополняется (как document_deadline_changes).
REVOKE UPDATE, DELETE, TRUNCATE ON "public"."document_party_rechecks" FROM ibportal_app;
CREATE FUNCTION document_party_rechecks_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_party_rechecks: только пополняется (% запрещён)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER document_party_rechecks_append_only
  BEFORE UPDATE OR DELETE ON "public"."document_party_rechecks"
  FOR EACH ROW EXECUTE FUNCTION document_party_rechecks_append_only();
CREATE TRIGGER document_party_rechecks_no_truncate
  BEFORE TRUNCATE ON "public"."document_party_rechecks"
  FOR EACH STATEMENT EXECUTE FUNCTION document_party_rechecks_append_only();

-- Неизменность утверждённой версии и новые колонки.
--   document_versions: route_state, source_docx_file_id, order_no, order_date уже под document_versions_guard —
--     он отклоняет любой UPDATE строки с approved_at (вся строка, в том числе у владельца схемы). Не меняется.
--   document_approvals.event: решения только пополняются (document_approvals_append_only). Не меняется.
--   document_party_rechecks: только пополняется (выше).
--   Новые колонки строк перевода и ответственных лиц утверждённой версии (файлы этапа 24, ссылка на перевод,
--     дата согласования, срок в днях, «до доработки») — новый триггер ниже. Триггер срабатывает по списку колонок
--     (UPDATE OF): прежние колонки этих строк 1.10.0 после отката читает и пишет как раньше.
CREATE FUNCTION document_version_children_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."document_versions" WHERE "id" = OLD."version_id" AND "approved_at" IS NOT NULL) THEN
    RAISE EXCEPTION '%: утверждённая версия не меняется (файлы, ссылки и отметки этапов 21–24)', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_translations_frozen
  BEFORE UPDATE OF "onlyoffice_url", "source_docx_file_id", "signed_pdf_file_id", "version_id" ON "public"."document_translations"
  FOR EACH ROW EXECUTE FUNCTION document_version_children_frozen();
CREATE TRIGGER document_parties_frozen
  BEFORE UPDATE OF "approved_on", "due_days", "reworked_at", "version_id" ON "public"."document_parties"
  FOR EACH ROW EXECUTE FUNCTION document_version_children_frozen();

-- Файл, на который ссылается версия или перевод (этап 24), — используемый: не удаляется (раздел 3.7).
CREATE OR REPLACE FUNCTION file_active_refs(f uuid) RETURNS bigint
LANGUAGE sql VOLATILE AS $$
  SELECT (SELECT count(*) FROM "public"."register_decisions" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_versions" WHERE "pdf_file_id" = f OR "source_docx_file_id" = f)
       + (SELECT count(*) FROM "public"."document_translations" WHERE "source_docx_file_id" = f OR "signed_pdf_file_id" = f)
       + (SELECT count(*) FROM "public"."evidence_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_record_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."register_imports" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."document_files" WHERE "file_id" = f AND "removed_at" IS NULL)
       + (SELECT count(*) FROM "public"."document_approvals" WHERE "file_id" = f)
       + (SELECT count(*) FROM "public"."vuln_scans" WHERE "file_id" = f OR "handover_file_id" = f)
       + (SELECT count(*) FROM "public"."vuln_extensions" WHERE "basis_file_id" = f);
$$;
