-- 1.12.0: тип файла message/rfc822 — файл .eml готового письма (ADR-0046). Такие файлы создаёт только сервер
-- (выгрузка письма, отметка «Отправлено»); загрузка пользователем (POST /files) их по-прежнему не принимает:
-- разрешённые для загрузки типы проверяет backend (lib/file-type.ts), эта проверка — список допустимых в БД.
-- Влияние на данные: ограничение шире, существующие строки files ему соответствуют, ни одна не меняется (0 строк).
-- Откат на 1.11.0 без отката базы: 1.11.0 такие файлы отдаёт как любые — только вложением, без предпросмотра.
ALTER TABLE "files" DROP CONSTRAINT "files_mime_check";
ALTER TABLE "files" ADD CONSTRAINT "files_mime_check" CHECK ("mime" IN (
  'application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'message/rfc822'
));
