-- Наполнение проверочного стенда данными «за 3 года» (этап 5 подготовки к 1.0.0). Только ibportal-releasetest:
-- запускается из fill.sh, который проверяет имя compose-проекта. На рабочем сервере не запускать.
--   уязвимости 20 000, задачи 5 000, устройства DLP 2 000, разрешения на доступ 1 000 с PDF.
-- Значения — по описанию полей реестра (как их пишет backend): списки и справочники — id значений, даты — ISO,
-- сотрудник — id пользователя, связь — массив id записей. Файлы: строки files + register_record_files + file_texts;
-- содержимое (один и тот же маленький PDF) раскладывает fill.sh по ключам из этого скрипта.
\set ON_ERROR_STOP on
BEGIN;

DO $$ BEGIN
  IF current_setting('loadtest.target', true) IS DISTINCT FROM 'ibportal-releasetest' THEN
    RAISE EXCEPTION 'fill.sql: только для стенда ibportal-releasetest (запускать через tools/loadtest/fill.sh)';
  END IF;
END $$;

-- Значения записи по полям реестра. i — номер строки (для текстов), since — начало периода дат.
CREATE FUNCTION pg_temp.row_values(reg uuid, i int, since date) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  f record; v jsonb := '{}'; opts uuid[]; user_ids uuid[];
BEGIN
  SELECT array_agg(id) INTO user_ids FROM users WHERE is_active;
  FOR f IN SELECT * FROM register_fields WHERE register_id = reg AND deleted_at IS NULL AND archived_at IS NULL
                                       AND type IN ('text', 'select', 'number', 'date', 'user', 'catalog') LOOP
    -- ~10% необязательных значений пустые (кроме заголовка).
    CONTINUE WHEN NOT f.is_title AND random() < 0.1;
    IF f.type = 'text' THEN
      v := v || jsonb_build_object(f.id, CASE
        WHEN f.label ILIKE '%хост%' THEN format('WS-%s-%s', upper(substr(md5(i::text), 1, 4)), lpad(i::text, 5, '0'))
        WHEN f.label ILIKE '%IP%' THEN format('10.%s.%s.%s', i % 200, (i / 200) % 250, 1 + i % 250)
        WHEN f.label ILIKE '%CVE%' THEN format('CVE-%s-%s', 2023 + i % 3, 10000 + i)
        WHEN f.label ILIKE '%пакет%' THEN (ARRAY['openssl', 'libxml2', 'nginx', 'openssh', 'glibc', 'curl', 'zlib', 'sudo'])[1 + i % 8] || '-' || (i % 40)
        WHEN f.label ILIKE '%сотрудник%' THEN (ARRAY['Иванов И.', 'Петрова А.', 'Сидоров К.', 'Калинов Д.', 'Ромашова Н.', 'Шарипов Ф.'])[1 + i % 6]
        WHEN f.label ILIKE '%№%' THEN format('%s-р/%s', 100 + i, 2024 + i % 3)
        ELSE format('%s %s: %s', f.label, i, (ARRAY['обновить пакет', 'закрыть порт', 'проверить настройки', 'согласовать с владельцем', 'ограничить доступ'])[1 + i % 5])
      END);
    ELSIF f.type = 'select' THEN
      SELECT array_agg(id) INTO opts FROM register_field_options WHERE field_id = f.id AND archived_at IS NULL;
      IF opts IS NOT NULL THEN v := v || jsonb_build_object(f.id, opts[1 + floor(random() * array_length(opts, 1))::int]); END IF;
    ELSIF f.type = 'catalog' THEN
      SELECT array_agg(id) INTO opts FROM catalog_items WHERE catalog_code = f.catalog_code AND archived_at IS NULL AND deleted_at IS NULL;
      IF opts IS NOT NULL THEN v := v || jsonb_build_object(f.id, opts[1 + floor(random() * array_length(opts, 1))::int]); END IF;
    ELSIF f.type = 'user' THEN
      v := v || jsonb_build_object(f.id, user_ids[1 + floor(random() * array_length(user_ids, 1))::int]);
    ELSIF f.type = 'number' THEN
      v := v || jsonb_build_object(f.id, round((random() * 10)::numeric, 1));
    ELSIF f.type = 'date' THEN
      v := v || jsonb_build_object(f.id, to_char(since + floor(random() * 1095)::int, 'YYYY-MM-DD'));
    END IF;
  END LOOP;
  RETURN v;
END $$;

-- n записей в реестр: номера после текущих, search_text — номер и текстовые значения (как поиск backend: lower, LIKE).
CREATE FUNCTION pg_temp.fill(reg_name text, n int) RETURNS SETOF uuid LANGUAGE plpgsql AS $$
DECLARE reg uuid; first int; since date := current_date - 1095;
BEGIN
  SELECT id, next_number INTO reg, first FROM registers WHERE name = reg_name AND archived_at IS NULL;
  IF reg IS NULL THEN RAISE EXCEPTION 'нет реестра «%»', reg_name; END IF;
  UPDATE registers SET next_number = next_number + n WHERE id = reg;
  RETURN QUERY
  INSERT INTO register_records (register_id, number, values, search_text, created_at, updated_at, archived_at)
  SELECT reg, first + g, v, lower(concat_ws(' ', first + g, (SELECT string_agg(x.value #>> '{}', ' ') FROM jsonb_each(v) x
                                                            WHERE jsonb_typeof(x.value) = 'string' AND x.value #>> '{}' !~ '^[0-9a-f-]{36}$'))),
         t, t, CASE WHEN random() < 0.05 THEN t + interval '30 days' END
  FROM generate_series(0, n - 1) g
  CROSS JOIN LATERAL (SELECT pg_temp.row_values(reg, first + g, since) AS v, now() - random() * interval '1095 days' AS t) s
  RETURNING id;
END $$;

CREATE TEMP TABLE vulns AS SELECT pg_temp.fill('Реестр уязвимостей', 20000) AS id;
CREATE TEMP TABLE devices AS SELECT pg_temp.fill('Устройства DLP', 2000) AS id;
CREATE TEMP TABLE perms AS SELECT pg_temp.fill('Разрешения на доступ', 1000) AS id;

-- Разрешения: связь с 1–3 устройствами и PDF-основание (files + register_record_files + текст для поиска).
UPDATE register_records r SET values = r.values || jsonb_build_object(f.id,
  (SELECT jsonb_agg(d.id) FROM (SELECT id FROM devices ORDER BY md5(r.id::text || devices.id::text) LIMIT 1 + r.number % 3) d))
FROM register_fields f
WHERE r.id IN (SELECT id FROM perms) AND f.register_id = r.register_id AND f.type = 'link' AND f.deleted_at IS NULL;

CREATE TEMP TABLE perm_files AS
SELECT p.id AS record_id, f.id AS field_id, gen_random_uuid() AS file_id, r.number,
       to_char(r.created_at, 'YYYY/MM/') || gen_random_uuid() AS storage_key, r.created_at AS at
FROM perms p JOIN register_records r ON r.id = p.id
JOIN register_fields f ON f.register_id = r.register_id AND f.type = 'file' AND f.deleted_at IS NULL;

INSERT INTO files (id, storage_key, original_name, mime, size, sha256, uploaded_by, uploaded_at)
SELECT file_id, storage_key, format('Разрешение %s.pdf', number), 'application/pdf', :pdf_size, :'pdf_sha256',
       (SELECT id FROM users WHERE is_active ORDER BY created_at LIMIT 1), at
FROM perm_files;
INSERT INTO register_record_files (record_id, field_id, file_id, added_by, added_at)
SELECT record_id, field_id, file_id, (SELECT id FROM users WHERE is_active ORDER BY created_at LIMIT 1), at FROM perm_files;
INSERT INTO file_texts (file_id, status, content, pages, attempts, extracted_at)
SELECT file_id, 'text', format('Разрешение на доступ № %s. Разрешить сотруднику использование USB-носителей и облачного хранилища для служебной переписки. Срок действия — один год.', number),
       1, 1, at
FROM perm_files;

-- Задачи: 5 000 за 3 года; закрытые — с датой выполнения.
INSERT INTO tasks (title, description, status_id, priority_id, category_id, assignee_id, due_date, source, created_by, completed_at, created_at, updated_at, archived_at)
SELECT format('Задача %s: %s', g, (ARRAY['проверить журнал DLP', 'обновить политику паролей', 'разобрать письмо ДИКТ', 'проверить доступы уволенных', 'подготовить отчёт'])[1 + g % 5]),
       'Сгенерировано для проверки нагрузки', st, pr, ca, us, (t + (1 + g % 30) * interval '1 day')::date, 'manual', us,
       CASE WHEN closed THEN t + (g % 20) * interval '1 day' END, t, t, CASE WHEN closed AND random() < 0.3 THEN t + interval '40 days' END
FROM generate_series(1, 5000) g
CROSS JOIN LATERAL (SELECT now() - random() * interval '1095 days' AS t, random() < 0.8 AS closed) a
CROSS JOIN LATERAL (
  SELECT (SELECT id FROM catalog_items WHERE catalog_code = 'task_statuses' AND deleted_at IS NULL
           AND (system_key = 'done') = a.closed ORDER BY md5(g::text || id::text) LIMIT 1) AS st,
         (SELECT id FROM catalog_items WHERE catalog_code = 'task_priorities' AND deleted_at IS NULL ORDER BY md5(g::text || id::text) LIMIT 1) AS pr,
         (SELECT id FROM catalog_items WHERE catalog_code = 'task_categories' AND deleted_at IS NULL ORDER BY md5(g::text || id::text) LIMIT 1) AS ca,
         (SELECT id FROM users WHERE is_active ORDER BY md5(g::text || id::text) LIMIT 1) AS us
) b;

ANALYZE;
COMMIT;

