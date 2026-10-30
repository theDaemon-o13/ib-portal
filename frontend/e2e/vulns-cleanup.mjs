// Очистка за сквозными тестами: группы «E2E-…» раздела «Уязвимости» и их данные — напрямую в dev-базе, только код тестов.
// В продукте удаления групп нет (ADR-0029), сканы и продления защищены триггерами, поэтому подключение — владельцем схемы,
// триггеры-стражи выключаются на время транзакции. Внешние ключи остаются включёнными: забытая ссылка откатит всё.
// Работает только с dev-базой на этой машине. Журнал аудита не трогается, файлы — тоже: без ссылок их уберёт часовая очистка.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { Client } = createRequire(new URL('../../backend/package.json', import.meta.url))('pg');

const GUARDS = [
  ['vuln_scans', 'vuln_scans_guard'],
  ['vuln_record_scans', 'vuln_record_scans_append_only'],
  ['vuln_extensions', 'vuln_extensions_guard'],
  ['vuln_extension_items', 'vuln_extension_items_append_only'],
  ['task_transitions', 'task_transitions_no_update_delete'],
  ['register_records', 'register_records_lock_guard'],
];

function devEnv() {
  for (const name of ['.env.dev', '.env.dev.example']) {
    const path = fileURLToPath(new URL(`../../deploy/${name}`, import.meta.url));
    if (existsSync(path)) {
      return Object.fromEntries(readFileSync(path, 'utf8').split('\n').map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    }
  }
  throw new Error('нет deploy/.env.dev');
}

/** Удалить группы «E2E-…». Возвращает, что удалено. Против стенда релиза (https) — ничего не делает. */
export async function cleanE2eGroups() {
  if (process.env.NODE_ENV === 'production') throw new Error('очистка e2e запрещена при NODE_ENV=production');
  if ((process.env.E2E_BASE_URL ?? '').startsWith('https:')) return null;
  const env = devEnv();
  const database = process.env.E2E_DB_NAME ?? 'ibportal_dev';
  const host = process.env.E2E_DB_HOST ?? '127.0.0.1';
  if (!database.endsWith('_dev')) throw new Error(`очистка e2e — только в dev-базе (*_dev), а не «${database}»`);
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error(`очистка e2e — только локально, а не ${host}`);
  const db = new Client({ host, port: Number(process.env.E2E_DB_PORT ?? 5433), database, user: env.DB_OWNER_USER, password: env.DB_OWNER_PASSWORD });
  await db.connect();
  const ids = async (sql, params = []) => (await db.query(sql, params)).rows.map((r) => r.id);
  const del = async (sql, params) => (await db.query(sql, params)).rowCount;
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL lock_timeout = '15s'`);
    const groups = await ids(`SELECT id FROM vuln_groups WHERE name LIKE 'E2E-%' AND system_key IS NULL`);
    if (!groups.length) {
      await db.query('ROLLBACK');
      return { groups: 0, records: 0, restored: 0 };
    }
    for (const [table, trigger] of GUARDS) await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    const nodes = await ids('SELECT id FROM vuln_nodes WHERE group_id = ANY($1::uuid[])', [groups]);
    const scans = await ids('SELECT id FROM vuln_scans WHERE node_id = ANY($1::uuid[])', [nodes]);
    const exts = await ids('SELECT id FROM vuln_extensions WHERE node_id = ANY($1::uuid[]) OR group_id = ANY($2::uuid[])', [nodes, groups]);

    // Записи прежнего реестра, перенесённые прогоном, — не его данные: обратно в «Без группы», какими были (не в архиве).
    const legacyNode = (await db.query(`SELECT id FROM vuln_nodes WHERE system_key = 'legacy'`)).rows[0]?.id;
    const restored = await ids('SELECT record_id AS id FROM vuln_records WHERE node_id = ANY($1::uuid[]) AND legacy', [nodes]);
    if (restored.length) {
      await db.query(
        `UPDATE vuln_records SET node_id = $2::uuid, key_norm = NULL, version = version + 1,
           first_scan_id = CASE WHEN first_scan_id = ANY($3::uuid[]) THEN NULL ELSE first_scan_id END,
           last_scan_id = CASE WHEN last_scan_id = ANY($3::uuid[]) THEN NULL ELSE last_scan_id END,
           deadline_scan_id = CASE WHEN deadline_scan_id = ANY($3::uuid[]) THEN NULL ELSE deadline_scan_id END
         WHERE record_id = ANY($1::uuid[])`, [restored, legacyNode, scans]);
      await db.query('UPDATE register_records SET archived_at = NULL, version = version + 1 WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [restored]);
    }

    const records = await ids('SELECT record_id AS id FROM vuln_records WHERE node_id = ANY($1::uuid[]) AND NOT legacy', [nodes]);
    // Значения списков, которые завёл прогон: отчёт сканирования его записей и его пакеты, если больше нигде не используются.
    const reg = (await db.query(`SELECT id FROM registers WHERE system_key = 'vulns'`)).rows[0].id;
    const reportField = (await db.query(`SELECT id::text AS id FROM register_fields WHERE register_id = $1 AND system_key = 'report'`, [reg])).rows[0].id;
    const reportOptions = (await db.query('SELECT DISTINCT "values" ->> $2 AS id FROM register_records WHERE id = ANY($1::uuid[])', [records, reportField])).rows.map((r) => r.id).filter(Boolean);

    const tasks = await ids('SELECT id FROM tasks WHERE record_id = ANY($1::uuid[])', [records]);
    const events = await ids('SELECT id FROM automation_events WHERE record_id = ANY($1::uuid[])', [records]);
    await del('DELETE FROM automation_event_tasks WHERE event_id = ANY($1::uuid[]) OR task_id = ANY($2::uuid[])', [events, tasks]);
    await del('DELETE FROM task_comments WHERE event_id = ANY($1::uuid[]) OR task_id = ANY($2::uuid[])', [events, tasks]);
    await del('DELETE FROM task_transitions WHERE task_id = ANY($1::uuid[])', [tasks]);
    await del('DELETE FROM task_mail_sources WHERE task_id = ANY($1::uuid[])', [tasks]);
    await del('DELETE FROM notifications WHERE task_id = ANY($1::uuid[])', [tasks]);
    await del('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [tasks]);
    await del('DELETE FROM automation_events WHERE id = ANY($1::uuid[])', [events]);
    await del('DELETE FROM vuln_extension_items WHERE extension_id = ANY($1::uuid[]) OR record_id = ANY($2::uuid[])', [exts, records]);
    await del('DELETE FROM vuln_extensions WHERE id = ANY($1::uuid[])', [exts]);
    await del('DELETE FROM vuln_record_scans WHERE scan_id = ANY($1::uuid[]) OR record_id = ANY($2::uuid[])', [scans, records]);
    await del('DELETE FROM vuln_records WHERE record_id = ANY($1::uuid[])', [records]);
    await del('DELETE FROM register_record_files WHERE record_id = ANY($1::uuid[])', [records]);
    const removed = await del('DELETE FROM register_records WHERE id = ANY($1::uuid[])', [records]);
    const imports = await ids('SELECT import_id AS id FROM vuln_scans WHERE id = ANY($1::uuid[]) AND import_id IS NOT NULL', [scans]);
    await db.query('UPDATE vuln_scans SET previous_scan_id = NULL WHERE id = ANY($1::uuid[])', [scans]);
    await del('DELETE FROM vuln_scans WHERE id = ANY($1::uuid[])', [scans]);
    // Предпросмотры узлов прогона, в том числе не применённые, живут в payload.
    await del(`DELETE FROM register_imports WHERE id = ANY($1::uuid[]) OR (kind = 'scan' AND payload ->> 'nodeId' = ANY($2::text[]))`, [imports, nodes]);
    await del('DELETE FROM vuln_nodes WHERE id = ANY($1::uuid[])', [nodes]);
    await del('DELETE FROM vuln_groups WHERE id = ANY($1::uuid[])', [groups]);
    await del(`DELETE FROM register_field_options o WHERE (o.id::text = ANY($1::text[]) OR o.label LIKE 'Пакет E2E-%')
      AND NOT EXISTS (SELECT 1 FROM register_records r WHERE r.register_id = $2::uuid AND r."values" ->> o.field_id::text = o.id::text)`, [reportOptions, reg]);
    for (const [table, trigger] of GUARDS) await db.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await db.query('COMMIT');
    return { groups: groups.length, records: removed, restored: restored.length };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}
