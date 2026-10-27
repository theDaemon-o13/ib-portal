-- Этап 8б: событие автоматизации «установить значение» (1 января разрешение «Действует» → «Истекло»).
-- Такое событие создаётся сразу обработанным, задач не порождает; изменение записи — в журнале аудита.
--
-- Влияние на данные: CHECK automation_events_type_check пересоздаётся шире (добавлено 'set_option');
-- существующие строки ему соответствуют, затронуто 0 строк, без перезаписи таблицы.
-- Откат приложения без отката базы: прежний backend таких событий не создаёт.

ALTER TABLE "public"."automation_events"
  DROP CONSTRAINT "automation_events_type_check",
  ADD CONSTRAINT "automation_events_type_check" CHECK ("event_type" IN ('remind', 'notify', 'escalate', 'set_option'));
