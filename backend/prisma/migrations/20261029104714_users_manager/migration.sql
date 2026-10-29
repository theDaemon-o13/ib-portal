-- Релиз 1.2.0, этап А2: руководитель у пользователя (ADR-0020). «Старшие» над пользователем — вся цепочка руководителей выше.
-- Влияние на данные: новая колонка users.manager_id — NULL у всех пользователей (на dev 334 строки, на проде — все учётные
-- записи), существующие данные не переписываются. Ограничение и триггер запрещают руководить самим собой и циклы в цепочке.
-- Откат: backend 1.1.0 колонку не читает; NULL — «руководитель не назначен».

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "manager_id" UUID;

-- CreateIndex
CREATE INDEX "users_manager_id_idx" ON "users"("manager_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "users" ADD CONSTRAINT "users_manager_not_self" CHECK ("manager_id" IS NULL OR "manager_id" <> "id");

-- Цикл A → B → … → A запрещён и в БД, не только в backend: проверка цепочки вверх от нового руководителя.
CREATE FUNCTION users_manager_no_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manager_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Две одновременные смены руководителей не обойдут проверку.
  PERFORM pg_advisory_xact_lock(hashtext('ibportal.users.manager_id'));
  IF EXISTS (
    WITH RECURSIVE up(id, depth) AS (
      SELECT NEW.manager_id, 1
      UNION ALL
      SELECT u.manager_id, up.depth + 1
      FROM "users" u JOIN up ON u.id = up.id
      WHERE u.manager_id IS NOT NULL AND up.depth < 100
    )
    SELECT 1 FROM up WHERE up.id = NEW.id
  ) THEN
    RAISE EXCEPTION 'users.manager_id: цикл в цепочке руководителей' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_manager_no_cycle
  BEFORE INSERT OR UPDATE OF manager_id ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_manager_no_cycle();
