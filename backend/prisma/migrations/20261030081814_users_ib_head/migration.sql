-- Релиз 1.4.0: отметка «Является начальником ИБ» у пользователя (docs/plans/release-1.4.0.md, ADR-0027).
--
-- Влияние на данные: новая колонка users.is_ib_head со значением по умолчанию false (PostgreSQL 16 не переписывает
-- таблицу); существующие строки по смыслу не меняются (затронуто 0 строк), отметка никому не ставится.
-- Уникальный частичный индекс: отметка не больше чем у одного пользователя.
-- Откат: backend 1.3.0 колонку не читает и ищет начальника ИБ по праву docs.approve.head, как раньше.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_ib_head" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "users_ib_head_uq" ON "users" ("is_ib_head") WHERE "is_ib_head";
