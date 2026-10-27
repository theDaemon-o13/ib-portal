-- Документ и его первая версия ссылаются друг на друга: documents.working_version_id → document_versions,
-- document_versions.document_id → documents, а documents_has_version_check требует ссылку на версию
-- уже при вставке документа. Внешние ключи документа на версии проверяются в конце транзакции,
-- поэтому документ и версия 1 создаются в одной транзакции в любом порядке. CHECK отложить нельзя,
-- поэтому откладываются внешние ключи.
--
-- Влияние на данные: меняется только момент проверки двух внешних ключей; данные и строки не меняются,
-- затронуто 0 строк (таблица documents на dev пустая, на сервере её ещё нет). Совместима с backend
-- предыдущей версии (он таблицу documents не использует). Откат приложения без отката базы.

ALTER TABLE "public"."documents"
  ALTER CONSTRAINT "documents_working_version_id_fkey" DEFERRABLE INITIALLY DEFERRED,
  ALTER CONSTRAINT "documents_approved_version_id_fkey" DEFERRABLE INITIALLY DEFERRED;
