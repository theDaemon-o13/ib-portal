-- Релиз 1.10.0: сессии без повторного входа — «Запомнить меня», «Мои сессии» (ADR-0023, изменение 1.10.0).
--
-- Влияние на данные: две колонки в sessions. remember = false у всех существующих строк (dev: 15 135), public_id —
-- новый UUID у каждой (ADD COLUMN с gen_random_uuid() переписывает таблицу; на dev — доли секунды). Ни одна сессия
-- не закрывается и не продлевается: открытые до выкладки доживают прежний expires_at (вход + 12 часов). Новый
-- частичный индекс открытых сессий пользователя — для «Моих сессий» и закрытия всех сессий пользователя.
-- Откат на 1.9.0 без отката базы: колонки не читаются; сессии 1.10.0 для 1.9.0 — обычные (30 минут без действий,
-- 12 часов от created_at), expires_at у них дальний — 1.9.0 закроет их по своим правилам.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "public_id" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD COLUMN     "remember" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "sessions_public_id_key" ON "sessions"("public_id");

-- Дополнение вручную (Prisma не описывает частичные индексы): открытые сессии пользователя.
CREATE INDEX "sessions_user_open_idx" ON "sessions" ("user_id") WHERE "revoked_at" IS NULL;
