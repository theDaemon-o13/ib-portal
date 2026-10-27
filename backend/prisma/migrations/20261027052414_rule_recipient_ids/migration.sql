-- Правила автоматизаций ссылаются на метку получателя по id значения справочника
-- «Получатели уведомлений», а не по названию (как везде, ADR-0005). Схема «расширить → перенести»:
-- в получателя-метку добавляется ключ itemId, прежний ключ label (название) остаётся.
--
-- Влияние на данные: меняется jsonb action в register_automations — у получателей вида
-- { kind: label } добавляется "itemId": id метки с тем же названием (без учёта регистра и лишних пробелов)
-- или null, если такой метки нет («получатель не найден» — правило работает, это видно в «Автоматизации»).
-- Затрагиваются только неудалённые правила с метками без itemId (на dev — 14 правил, на сервере — 3
-- системных правила реестра уязвимостей, если этап 4 уже выложен). Остальные таблицы не меняются,
-- версии правил не увеличиваются. Ключ label не удаляется: backend предыдущей версии читает его как раньше,
-- откат приложения без отката базы. Удаление ключа label — отдельным релизом после подтверждения («сузить»).
--
-- Если меток ещё нет (первая установка: справочник создаёт seed после миграций), itemId остаётся null,
-- и seed повторяет ту же привязку функцией link_recipient_labels() — она трогает только непривязанные.

CREATE FUNCTION "public"."link_recipient_labels"() RETURNS integer
  LANGUAGE sql
AS $$
  WITH upd AS (
    UPDATE "public"."register_automations" a
    SET "action" = jsonb_set(a."action", '{recipients}', (
      SELECT coalesce(jsonb_agg(
        CASE
          WHEN e.r ->> 'kind' = 'label' AND (e.r ->> 'itemId') IS NULL THEN
            e.r || jsonb_build_object('itemId', (
              SELECT ci."id"::text FROM "public"."catalog_items" ci
              WHERE ci."catalog_code" = 'notify_recipients' AND ci."deleted_at" IS NULL
                AND lower(btrim(ci."value")) = lower(regexp_replace(btrim(e.r ->> 'label'), '\s+', ' ', 'g'))
              LIMIT 1
            ))
          ELSE e.r
        END ORDER BY e.ord), '[]'::jsonb)
      FROM jsonb_array_elements(a."action" -> 'recipients') WITH ORDINALITY AS e(r, ord)
    ))
    WHERE a."deleted_at" IS NULL
      AND jsonb_typeof(a."action" -> 'recipients') = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(a."action" -> 'recipients') x(r)
        WHERE x.r ->> 'kind' = 'label' AND (x.r ->> 'itemId') IS NULL
      )
    RETURNING 1
  )
  SELECT count(*)::integer FROM upd;
$$;

COMMENT ON FUNCTION "public"."link_recipient_labels"() IS
  'Привязать метки получателей в правилах автоматизаций к id значений справочника notify_recipients по названию; трогает только непривязанные';

SELECT "public"."link_recipient_labels"();
