-- «Сузить» после rule_recipient_ids (ADR-0009, решение владельца проекта 27.10.2026 — одним релизом перед
-- первой выкладкой): правило автоматизации ссылается на метку получателя только по id значения справочника
-- «Получатели уведомлений». Ключ label (название на момент сохранения, его читал backend до 1.0.0) удаляется,
-- поиск метки по названию — тоже (функция link_recipient_labels и её вызов в seed).
-- Миграция 20261027215250_narrow_rule_recipient_labels осталась пустой: на dev её применил migrate dev раньше, чем
-- в файл попал SQL, а применённые миграции не правятся.
--
-- Влияние на данные: меняется jsonb action в register_automations — у получателей вида { kind: label }
-- остаются только kind и itemId (порядок получателей и остальные виды не меняются). Перед этим последний раз
-- выполняется привязка по названию: метка без itemId, найденная в справочнике, получает id. Затем проверка:
-- если остаётся метка без itemId или с itemId, которого нет среди неудалённых значений справочника, миграция
-- останавливается (RAISE EXCEPTION со списком правил и названий меток) и не меняет ничего — название метки не
-- теряется ни при каких условиях. Такие метки администратор выбирает заново из справочника, затем повторяет выкладку.
-- Затрагиваются правила с получателями-метками, включая удалённые: на dev — 35 правил (37 меток, у всех
-- itemId уже есть, null — 0); на сервере портал ещё не выкладывался. Версии правил не увеличиваются, журнал
-- аудита не меняется. Снимки получателей в automation_events (история) не меняются.
-- Откат: названия меток восстанавливаются по itemId из справочника, но backend до 1.0.0 на сервер не
-- выкладывался — откатываться не на что. Функция link_recipient_labels удаляется: seed 1.0.0 её не вызывает.

SELECT "public"."link_recipient_labels"();

DO $$
DECLARE
  lost text;
BEGIN
  SELECT string_agg(format('реестр «%s», правило %s: метка «%s»%s', r."name", a."id",
           coalesce(x.r ->> 'label', '(без названия)'),
           CASE WHEN x.r ->> 'itemId' IS NULL THEN ' без itemId' ELSE ' — itemId ' || (x.r ->> 'itemId') || ' нет в справочнике' END),
         '; ' ORDER BY r."name", a."id")
    INTO lost
  FROM "public"."register_automations" a
  JOIN "public"."registers" r ON r."id" = a."register_id"
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(a."action" -> 'recipients') = 'array' THEN a."action" -> 'recipients' ELSE '[]'::jsonb END
  ) AS x(r)
  WHERE x.r ->> 'kind' = 'label'
    AND NOT EXISTS (
      SELECT 1 FROM "public"."catalog_items" ci
      WHERE ci."catalog_code" = 'notify_recipients' AND ci."deleted_at" IS NULL AND ci."id"::text = x.r ->> 'itemId'
    );
  IF lost IS NOT NULL THEN
    RAISE EXCEPTION 'rule_recipient_labels_by_id: метки получателей не привязаны к справочнику «Получатели уведомлений», название потеряется — миграция остановлена, данные не изменены. Выберите метку заново в правиле: %', lost
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

UPDATE "public"."register_automations" a
SET "action" = jsonb_set(a."action", '{recipients}', (
  SELECT coalesce(jsonb_agg(
    CASE
      WHEN e.r ->> 'kind' = 'label' THEN jsonb_build_object('kind', 'label', 'itemId', e.r -> 'itemId')
      ELSE e.r
    END ORDER BY e.ord), '[]'::jsonb)
  FROM jsonb_array_elements(a."action" -> 'recipients') WITH ORDINALITY AS e(r, ord)
))
WHERE jsonb_typeof(a."action" -> 'recipients') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(a."action" -> 'recipients') x(r)
    WHERE x.r ->> 'kind' = 'label' AND (x.r ? 'label' OR NOT x.r ? 'itemId')
  );

DROP FUNCTION "public"."link_recipient_labels"();
