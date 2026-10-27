-- Этап маршрута, который некому согласовать, кроме владельца документа, пропускается: в историю согласования
-- пишется решение 'skipped' с причиной (кто владелец, почему пропущен). Владелец этапы 1–3 своего документа
-- не согласует (ADR-0010).
--
-- Влияние на данные: ограничение document_approvals_decision_check пересоздаётся с более широким списком
-- (добавлен 'skipped'); ограничение комментария дополнено: у пропуска причина обязательна. Существующие строки
-- (на dev — 42, на сервере таблицы ещё нет) новым ограничениям соответствуют: решений 'skipped' среди них нет.
-- Затронуто 0 строк, данные не меняются. Совместимость: backend этапа 5 таблицу не читает. Сборка этапа 6 без
-- этой правки не открыла бы карточку документа с пропущенным этапом (решение 'skipped' не входит в её схему
-- ответа), поэтому этап 6 и эта миграция выкладываются одним релизом — этап 6 на сервер ещё не выкладывался.
-- Откат на версию до этапа 6 — без отката базы.

ALTER TABLE "public"."document_approvals"
  DROP CONSTRAINT "document_approvals_decision_check",
  ADD CONSTRAINT "document_approvals_decision_check"
    CHECK ("decision" IN ('submitted', 'approved', 'returned', 'revision_started', 'skipped')),
  DROP CONSTRAINT "document_approvals_comment_check",
  ADD CONSTRAINT "document_approvals_comment_check" CHECK (
    length("comment") <= 4000 AND ("decision" NOT IN ('returned', 'skipped') OR length(btrim("comment")) >= 1)
  );
