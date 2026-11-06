-- Ручной обратный перенос документов в работе с маршрута 1.11.0 (этапы 21–24) на маршрут 1.2.0 (этапы 11–16).
-- План 1.11.0, раздел 8 (решение владельца 9): миграцией не делается, запускается администратором по желанию —
-- ТОЛЬКО после отката кода на 1.10.0 (VERSION=1.10.0 в .env, backend и frontend 1.10.0 запущены), если документы
-- в работе нужно двигать в старой версии. Без скрипта 1.10.0 документы на 21–24 только показывает.
--
--   docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d ibportal -v ON_ERROR_STOP=1' < 1.11.0-documents-stages.sql
--
-- Что делает (одной транзакцией):
--   21 «Драфт» → 11 «Драфт»; 21 «На проверке у начальника ИБ» → 13 «Согласование начальника ИБ»;
--   22 «Согласование» и «На повторной проверке» → 14 «Согласование с ответственными лицами»; 23 «Перевод» → 15 «Перевод»;
--   24 «Утверждение» → 16 «Подписание».
--   Только рабочие версии (не утверждённые, не отменённые); утверждённые версии не меняются (их охраняет триггер).
--   Новые колонки 1.11.0 (route_state, файлы этапа 24, приказ, event, approved_on, due_days, reworked_at,
--   onlyoffice_url, файлы языков) НЕ трогаются: 1.10.0 их не читает, при повторной выкладке 1.11.0 они пригодятся.
--   На каждую версию — решение migrated «Возвращён на маршрут 1.2.0 при откате: «…» → «…»» (в истории — «Система»),
--   в журнал — сводка. Повторный запуск ничего не меняет: берутся только версии на этапах 21–24.
-- Влияние на данные: меняются этап рабочих версий на 21–24 и version их документов; добавляются решения migrated и
-- одна строка журнала. Ничего не удаляется. Обратно: повторная выкладка 1.11.0 — шаг seed docs.route.v3 переносит
-- версии снова на 21–24 (13 → 21 «на проверке», 14 → 22 по отметкам лиц).
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE rollback_1110 ON COMMIT DROP AS
SELECT v.id, v.document_id, v.no, v.round, v.stage, v.route_state, d.owner_id,
       CASE WHEN v.stage = 21 AND v.route_state = 'head_review' THEN 13
            WHEN v.stage = 21 THEN 11 WHEN v.stage = 22 THEN 14 WHEN v.stage = 23 THEN 15 ELSE 16 END AS to_stage
FROM document_versions v
JOIN documents d ON d.working_version_id = v.id
WHERE v.stage BETWEEN 21 AND 24 AND v.approved_at IS NULL AND v.cancelled_at IS NULL;

INSERT INTO document_approvals (document_id, version_id, version_no, round, stage, to_stage, decision, comment, actor_id)
SELECT r.document_id, r.id, r.no, r.round, r.stage, r.to_stage, 'migrated',
       'Возвращён на маршрут 1.2.0 при откате: «'
       || CASE r.stage WHEN 21 THEN CASE WHEN r.route_state = 'head_review' THEN 'Драфт — На проверке у начальника ИБ' ELSE 'Драфт' END
                       WHEN 22 THEN CASE WHEN r.route_state = 'head_recheck' THEN 'Согласование — На повторной проверке у начальника ИБ' ELSE 'Согласование' END
                       WHEN 23 THEN 'Перевод' ELSE 'Утверждение' END
       || '» → «'
       || CASE r.to_stage WHEN 11 THEN 'Драфт' WHEN 13 THEN 'Согласование начальника ИБ' WHEN 14 THEN 'Согласование с ответственными лицами'
                          WHEN 15 THEN 'Перевод' ELSE 'Подписание' END
       || '»',
       r.owner_id
FROM rollback_1110 r;

UPDATE document_versions v SET stage = r.to_stage, updated_at = now() FROM rollback_1110 r WHERE v.id = r.id;
UPDATE documents d SET version = d.version + 1, updated_at = now() FROM rollback_1110 r WHERE d.id = r.document_id;

INSERT INTO audit_log (user_id, action, entity, entity_id, diff)
SELECT NULL, 'document.route_rollback', 'document', NULL, jsonb_build_object(
  'summary', 'Документы: возвращены на маршрут 1.2.0 при откате 1.11.0 → 1.10.0 — ' || count(*)
             || ' (на 11: ' || count(*) FILTER (WHERE to_stage = 11) || ', на 13: ' || count(*) FILTER (WHERE to_stage = 13)
             || ', на 14: ' || count(*) FILTER (WHERE to_stage = 14) || ', на 15: ' || count(*) FILTER (WHERE to_stage = 15)
             || ', на 16: ' || count(*) FILTER (WHERE to_stage = 16) || ')',
  'moved', count(*))
FROM rollback_1110 HAVING count(*) > 0;

SELECT to_stage AS "на этап", count(*) AS "версий" FROM rollback_1110 GROUP BY to_stage ORDER BY to_stage;
COMMIT;
