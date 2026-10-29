-- Релиз 1.2.0, этап Б1: признаки колонок доски задач (ADR-0022) — обязателен ли комментарий при переходе в колонку
-- вперёд и при возврате в неё. Используются только у справочника «Статусы задач».
-- Влияние на данные: две колонки в catalog_items со значением false у всех строк (на dev 147 строк); значения справочников
-- не меняются. Признаки системных колонок выставит шаг seed tasks.process.v1_2. Откат: backend 1.1.0 колонки не читает.

-- AlterTable
ALTER TABLE "catalog_items" ADD COLUMN     "comment_forward" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "comment_return" BOOLEAN NOT NULL DEFAULT false;
