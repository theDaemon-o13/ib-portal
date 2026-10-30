-- Релиз 1.4.0, шаг 6: переводчик больше не пользователь портала (решение владельца 9) — имя переводчика текстом.
-- Влияние на данные:
--   * document_translations: новая колонка translator_name (TEXT NOT NULL DEFAULT '', не длиннее 200 символов).
--   * Та же таблица: для всех существующих строк (в том числе снятых) translator_name заполняется ФИО учётной записи
--     переводчика (users.full_name по translator_id) — UPDATE только новой колонки; translator_id, language, due_date
--     и остальные колонки не меняются, другие таблицы не затрагиваются.
--   * Число затронутых строк = числу строк document_translations: запрос только на чтение — в deploy/prechecks/1.4.0.md
--     («Переводы: сколько строк заполнит миграция»). На dev — 35 строк.
--   * Откат: backend 1.3.0 колонку не читает; translator_id остаётся заполненным (новые строки — тот, кто добавил).
--     Отменить заполнение не нужно: колонка новая, исходные данные не менялись.

-- AlterTable
ALTER TABLE "document_translations" ADD COLUMN     "translator_name" TEXT NOT NULL DEFAULT '';

ALTER TABLE "document_translations"
  ADD CONSTRAINT "document_translations_translator_name_check" CHECK (char_length("translator_name") <= 200);

-- Строки до 1.4.0: имя из учётной записи переводчика (ФИО в портале — не длиннее 200 символов; left — на всякий случай).
UPDATE "document_translations" t
SET "translator_name" = left(u."full_name", 200)
FROM "users" u
WHERE u."id" = t."translator_id" AND t."translator_name" = '';
