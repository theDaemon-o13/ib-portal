-- Мягкое удаление реестров, групп и узлов уязвимостей, записей; корзина (релиз 1.6.1, ADR-0033).
-- Влияние на данные: новая пустая таблица deletions; новые колонки deleted_at и deletion_id — NULL у всех строк;
-- существующие строки не меняются (затронуто 0 строк). Уникальные индексы названий реестров и групп и «тип в группе»
-- пересоздаются частичными (WHERE deleted_at IS NULL): удалённых строк сейчас нет, поэтому на текущих данных они
-- проверяют то же самое. Откат на 1.6.0: новые колонки и таблица не читаются; удалённые в 1.6.1 реестры, группы
-- и узлы после отката видны снова, пустые (их записи старый backend тоже не показывает).

-- AlterTable
ALTER TABLE "register_automations" ADD COLUMN     "deletion_id" UUID;

-- AlterTable
ALTER TABLE "register_records" ADD COLUMN     "deletion_id" UUID;

-- AlterTable
ALTER TABLE "registers" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "deletion_id" UUID;

-- AlterTable
ALTER TABLE "vuln_groups" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "deletion_id" UUID;

-- AlterTable
ALTER TABLE "vuln_nodes" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "deletion_id" UUID;

-- CreateTable
CREATE TABLE "deletions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "reason_code" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "snapshot" JSONB NOT NULL DEFAULT '[]',
    "deleted_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restored_by" UUID,
    "restored_at" TIMESTAMPTZ(3),

    CONSTRAINT "deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deletions_deleted_at_idx" ON "deletions"("deleted_at" DESC);

-- CreateIndex
CREATE INDEX "register_automations_deletion_id_idx" ON "register_automations"("deletion_id");

-- CreateIndex
CREATE INDEX "register_records_deletion_id_idx" ON "register_records"("deletion_id");

-- CreateIndex
CREATE INDEX "registers_deletion_id_idx" ON "registers"("deletion_id");

-- CreateIndex
CREATE INDEX "vuln_groups_deletion_id_idx" ON "vuln_groups"("deletion_id");

-- CreateIndex
CREATE INDEX "vuln_nodes_deletion_id_idx" ON "vuln_nodes"("deletion_id");

-- AddForeignKey
ALTER TABLE "registers" ADD CONSTRAINT "registers_deletion_id_fkey" FOREIGN KEY ("deletion_id") REFERENCES "deletions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_records" ADD CONSTRAINT "register_records_deletion_id_fkey" FOREIGN KEY ("deletion_id") REFERENCES "deletions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_groups" ADD CONSTRAINT "vuln_groups_deletion_id_fkey" FOREIGN KEY ("deletion_id") REFERENCES "deletions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vuln_nodes" ADD CONSTRAINT "vuln_nodes_deletion_id_fkey" FOREIGN KEY ("deletion_id") REFERENCES "deletions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deletions" ADD CONSTRAINT "deletions_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deletions" ADD CONSTRAINT "deletions_restored_by_fkey" FOREIGN KEY ("restored_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_automations" ADD CONSTRAINT "register_automations_deletion_id_fkey" FOREIGN KEY ("deletion_id") REFERENCES "deletions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Проверки.
ALTER TABLE "deletions"
  ADD CONSTRAINT "deletions_entity_check" CHECK ("entity" IN ('register', 'vuln_group', 'vuln_node', 'register_records')),
  ADD CONSTRAINT "deletions_reason_code_check" CHECK ("reason_code" IS NULL OR "reason_code" IN ('wrong_import', 'false_positive', 'duplicate', 'other')),
  ADD CONSTRAINT "deletions_reason_check" CHECK (
    CASE WHEN "reason_code" IS NULL OR "reason_code" = 'other' THEN length(btrim("reason")) > 0 ELSE true END),
  ADD CONSTRAINT "deletions_reason_length_check" CHECK (length("reason") <= 2000),
  ADD CONSTRAINT "deletions_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 500),
  ADD CONSTRAINT "deletions_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'array'),
  ADD CONSTRAINT "deletions_restored_check" CHECK (("restored_at" IS NULL) = ("restored_by" IS NULL));

-- Системные объекты не удаляются (дублирует проверку backend).
ALTER TABLE "registers"   ADD CONSTRAINT "registers_system_not_deleted"   CHECK ("system_key" IS NULL OR "deleted_at" IS NULL);
ALTER TABLE "vuln_groups" ADD CONSTRAINT "vuln_groups_system_not_deleted" CHECK ("system_key" IS NULL OR "deleted_at" IS NULL);
ALTER TABLE "vuln_nodes"  ADD CONSTRAINT "vuln_nodes_system_not_deleted"  CHECK ("system_key" IS NULL OR "deleted_at" IS NULL);
-- Отметка и событие ставятся и снимаются вместе.
ALTER TABLE "registers"   ADD CONSTRAINT "registers_deletion_check"   CHECK ("deletion_id" IS NULL OR "deleted_at" IS NOT NULL);
ALTER TABLE "vuln_groups" ADD CONSTRAINT "vuln_groups_deletion_check" CHECK ("deletion_id" IS NULL OR "deleted_at" IS NOT NULL);
ALTER TABLE "vuln_nodes"  ADD CONSTRAINT "vuln_nodes_deletion_check"  CHECK ("deletion_id" IS NULL OR "deleted_at" IS NOT NULL);
ALTER TABLE "register_records" ADD CONSTRAINT "register_records_deletion_check" CHECK ("deletion_id" IS NULL OR "deleted_at" IS NOT NULL);
ALTER TABLE "register_automations" ADD CONSTRAINT "register_automations_deletion_check" CHECK ("deletion_id" IS NULL OR "deleted_at" IS NOT NULL);

-- Название удалённого не занято: уникальность только среди неудалённых.
DROP INDEX "registers_name_uq";
CREATE UNIQUE INDEX "registers_name_uq" ON "registers" (lower("name")) WHERE "archived_at" IS NULL AND "deleted_at" IS NULL;
DROP INDEX "vuln_groups_name_uq";
CREATE UNIQUE INDEX "vuln_groups_name_uq" ON "vuln_groups" (lower(btrim("name"))) WHERE "deleted_at" IS NULL;
DROP INDEX "vuln_nodes_group_type_uq";
CREATE UNIQUE INDEX "vuln_nodes_group_type_uq" ON "vuln_nodes" ("group_id", "system_type_id")
  WHERE "system_type_id" IS NOT NULL AND "deleted_at" IS NULL;

-- Событие удаления не меняется: только однократное восстановление.
CREATE OR REPLACE FUNCTION deletions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  restore text[] := ARRAY['restored_at', 'restored_by'];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."restored_at" IS NULL
     AND (to_jsonb(NEW) - restore) = (to_jsonb(OLD) - restore) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'deletions: событие удаления не меняется, восстановление — один раз (% запрещён)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER deletions_guard BEFORE UPDATE OR DELETE ON "deletions" FOR EACH ROW EXECUTE FUNCTION deletions_guard();

-- Роль приложения.
REVOKE DELETE, TRUNCATE ON "deletions" FROM ibportal_app;
