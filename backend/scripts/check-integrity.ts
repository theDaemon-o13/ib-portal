// Проверка целостности после миграций (CLAUDE.md, раздел 9, п. 4):
//   npm run check:integrity
// Ничего не меняет, только читает. Код выхода 1, если что-то не так.
// Файлы (этап 7): каждый неудалённый файл есть в FILES_DIR и совпадает по размеру; --sha — ещё и по sha256
// (читает все файлы целиком). Файлы на диске без строки в БД — предупреждение (ничего не удаляется).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createPrisma } from '../src/lib/db.js';
import { diskFileStore } from '../src/lib/file-store.js';
import { SYSTEM_ITEMS } from '../src/lib/catalogs.js';
import { APPROVAL_PERMISSIONS, PERMISSIONS, SUPER_ADMIN_LOCKED, SYSTEM_ROLES } from '../src/lib/permissions.js';
import { VULN_FIELDS, VULN_REGISTER_KEY } from '../src/modules/vulns/definition.js';
import { RISK_FIELDS, RISK_REGISTER_KEY } from '../src/modules/risks/definition.js';
import { INCIDENT_DATE_KEY, INCIDENT_REGISTER_KEY } from '../src/modules/dashboard/incidents.js';

const prisma = createPrisma();
let failed = 0;

function check(ok: boolean, label: string, hint = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && hint ? ` — ${hint}` : ''}`);
  if (!ok) failed++;
}

async function main() {
  type Priv = { priv: string; granted: boolean };
  const privs = await prisma.$queryRaw<Priv[]>`
    SELECT p AS priv, has_table_privilege('ibportal_app', 'public.audit_log', p) AS granted
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p`;
  const has = (p: string) => privs.find((x) => x.priv === p)?.granted === true;
  check(has('SELECT') && has('INSERT'), 'ibportal_app: SELECT и INSERT на audit_log');
  check(!has('UPDATE') && !has('DELETE') && !has('TRUNCATE'), 'ibportal_app: нет UPDATE, DELETE, TRUNCATE на audit_log');

  const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.audit_log'::regclass AND NOT tgisinternal`;
  const names = triggers.map((t) => t.tgname);
  check(
    names.includes('audit_log_no_update_delete') && names.includes('audit_log_no_truncate'),
    'триггеры запрета правки audit_log на месте',
  );

  const migrationsAccess = await prisma.$queryRaw<{ granted: boolean }[]>`
    SELECT bool_or(has_table_privilege('ibportal_app', 'public._prisma_migrations', p)) AS granted
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p`;
  check(migrationsAccess[0]?.granted === false, 'ibportal_app: нет доступа к _prisma_migrations');

  const decisionPrivs = await prisma.$queryRaw<{ granted: boolean }[]>`
    SELECT bool_or(has_table_privilege('ibportal_app', 'public.register_decisions', p)) AS granted
    FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p`;
  check(decisionPrivs[0]?.granted === false, 'ibportal_app: нет UPDATE, DELETE, TRUNCATE на register_decisions');

  // Этап 4: роль приложения пишет в новые таблицы (права — через ALTER DEFAULT PRIVILEGES).
  for (const table of ['scan_reports', 'scan_hosts', 'register_automations', 'automation_events']) {
    const ok = await prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT bool_and(has_table_privilege('ibportal_app', ${`public.${table}`}, p)) AS ok
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p`;
    check(ok[0]?.ok === true, `ibportal_app: SELECT, INSERT, UPDATE на ${table}`);
  }

  // Этап 5: задачи и метки получателей.
  for (const table of ['tasks', 'task_mail_sources', 'task_comments', 'automation_event_tasks', 'catalog_item_users']) {
    const ok = await prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT bool_and(has_table_privilege('ibportal_app', ${`public.${table}`}, p)) AS ok
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p`;
    check(ok[0]?.ok === true, `ibportal_app: SELECT, INSERT, UPDATE на ${table}`);
  }
  const seq = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT has_sequence_privilege('ibportal_app', pg_get_serial_sequence('public.tasks', 'number'), 'USAGE') AS ok`;
  check(seq[0]?.ok === true, 'ibportal_app: USAGE на последовательность номеров задач');

  // Этап 6: документы. История согласования только пополняется; версии не удаляются,
  // утверждённая версия не меняется (триггер).
  for (const table of ['documents', 'document_versions', 'document_approvals']) {
    const ok = await prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT bool_and(has_table_privilege('ibportal_app', ${`public.${table}`}, p)) AS ok
      FROM unnest(ARRAY['SELECT', 'INSERT']) AS p`;
    check(ok[0]?.ok === true, `ibportal_app: SELECT, INSERT на ${table}`);
  }
  const docSeq = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT has_sequence_privilege('ibportal_app', pg_get_serial_sequence('public.documents', 'number'), 'USAGE') AS ok`;
  check(docSeq[0]?.ok === true, 'ibportal_app: USAGE на последовательность номеров документов');
  const approvalPrivs = await prisma.$queryRaw<{ granted: boolean }[]>`
    SELECT bool_or(has_table_privilege('ibportal_app', 'public.document_approvals', p)) AS granted
    FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p`;
  check(approvalPrivs[0]?.granted === false, 'ibportal_app: нет UPDATE, DELETE, TRUNCATE на document_approvals');
  const versionPrivs = await prisma.$queryRaw<{ granted: boolean }[]>`
    SELECT bool_or(has_table_privilege('ibportal_app', 'public.document_versions', p)) AS granted
    FROM unnest(ARRAY['DELETE', 'TRUNCATE']) AS p`;
  check(versionPrivs[0]?.granted === false, 'ibportal_app: нет DELETE, TRUNCATE на document_versions');
  const docTriggers = await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger
    WHERE tgrelid IN ('public.document_approvals'::regclass, 'public.document_versions'::regclass) AND NOT tgisinternal`;
  const docTriggerNames = docTriggers.map((t) => t.tgname);
  check(
    ['document_approvals_no_update_delete', 'document_approvals_no_truncate', 'document_versions_guard', 'document_versions_no_truncate',
      'document_versions_require_pdf']
      .every((n) => docTriggerNames.includes(n)),
    'триггеры неизменности истории и версий документов и «утверждение только с PDF» на месте',
  );

  const sysItems = await prisma.catalogItem.findMany({ where: { isSystem: true, deletedAt: null }, select: { catalogCode: true, systemKey: true } });
  const missingItems = SYSTEM_ITEMS.filter((i) => !sysItems.some((x) => x.catalogCode === i.catalog && x.systemKey === i.key)).map((i) => i.value);
  check(missingItems.length === 0, `системные значения справочников на месте (${SYSTEM_ITEMS.length})`, `нет: ${missingItems.join(', ')} — выполните seed`);

  // Системный реестр уязвимостей: все системные поля на месте (формулы и импорт ищут их по ключу).
  const vulns = await prisma.register.findUnique({
    where: { systemKey: VULN_REGISTER_KEY },
    include: { fields: { where: { deletedAt: null, systemKey: { not: null } }, select: { systemKey: true, archivedAt: true } } },
  });
  check(vulns !== null, 'есть системный «Реестр уязвимостей»', 'выполните seed');
  if (vulns) {
    const keys = new Set(vulns.fields.filter((f) => f.archivedAt === null).map((f) => f.systemKey));
    const missing = VULN_FIELDS.filter((f) => !keys.has(f.key)).map((f) => f.label);
    check(missing.length === 0, 'у реестра уязвимостей все системные поля', `нет: ${missing.join(', ')}`);
    const rules = await prisma.registerAutomation.count({ where: { registerId: vulns.id, systemKey: { not: null }, deletedAt: null } });
    check(rules === 3, 'системные правила п. 7.4 на месте (3)', `найдено ${rules}`);
  }

  // Этап 7: файлы и доказательства. Строки не удаляются (права и триггеры), содержимое файла не меняется.
  for (const table of ['files', 'evidence', 'evidence_files']) {
    const rights = await prisma.$queryRaw<{ p: string; granted: boolean }[]>`
      SELECT p, has_table_privilege('ibportal_app', ${`public.${table}`}, p) AS granted
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p`;
    const g = (p: string) => rights.find((x) => x.p === p)?.granted === true;
    check(g('SELECT') && g('INSERT') && g('UPDATE'), `ibportal_app: SELECT, INSERT, UPDATE на ${table}`);
    check(!g('DELETE') && !g('TRUNCATE'), `ibportal_app: нет DELETE, TRUNCATE на ${table}`);
  }
  const evSeq = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT has_sequence_privilege('ibportal_app', pg_get_serial_sequence('public.evidence', 'number'), 'USAGE') AS ok`;
  check(evSeq[0]?.ok === true, 'ibportal_app: USAGE на последовательность номеров доказательств');
  const fileTriggers = (await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger
    WHERE tgrelid IN ('public.files'::regclass, 'public.evidence'::regclass, 'public.evidence_files'::regclass,
                      'public.register_decisions'::regclass, 'public.document_versions'::regclass) AND NOT tgisinternal`).map((t) => t.tgname);
  check(
    ['files_guard', 'files_no_truncate', 'evidence_guard', 'evidence_no_truncate', 'evidence_files_guard', 'evidence_files_no_truncate',
      'register_decisions_file_alive', 'evidence_files_file_alive', 'document_versions_pdf_alive'].every((n) => fileTriggers.includes(n)),
    'триггеры неизменности файлов и доказательств на месте',
  );
  const deletedWithRefs = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM files WHERE deleted_at IS NOT NULL AND file_active_refs(id) > 0`;
  check(Number(deletedWithRefs[0]?.n ?? 0) === 0, 'нет файлов «удалён», на которые есть ссылки');

  const risks = await prisma.register.findUnique({
    where: { systemKey: RISK_REGISTER_KEY },
    include: { fields: { where: { deletedAt: null, archivedAt: null, systemKey: { not: null } }, select: { systemKey: true } } },
  });
  check(risks !== null, 'есть системный «Реестр рисков ИБ»', 'выполните seed');
  if (risks) {
    const keys = new Set(risks.fields.map((f) => f.systemKey));
    const missing = RISK_FIELDS.filter((f) => f.system && !keys.has(f.key)).map((f) => f.label);
    check(missing.length === 0, 'у реестра рисков ИБ все системные поля', `нет: ${missing.join(', ')}`);
  }

  // Этап 8: дашборд, ключ импорта, настенный монитор.
  const tilePrivs = await prisma.$queryRaw<{ p: string; granted: boolean }[]>`
    SELECT p, has_table_privilege('ibportal_app', 'public.dashboard_tiles', p) AS granted
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p`;
  const tp = (x: string) => tilePrivs.find((r) => r.p === x)?.granted === true;
  check(tp('SELECT') && tp('INSERT') && tp('UPDATE') && !tp('DELETE') && !tp('TRUNCATE'), 'ibportal_app: dashboard_tiles — SELECT, INSERT, UPDATE, без DELETE и TRUNCATE');
  const keyTrigger = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_trigger WHERE tgrelid = 'public.register_records'::regclass AND tgname = 'register_records_import_key'`;
  check(Number(keyTrigger[0]?.n ?? 0) === 1, 'триггер ключа импорта register_records_import_key на месте');
  const staleKeys = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM register_records r
    LEFT JOIN register_fields f ON f.register_id = r.register_id AND f.is_import_key AND f.deleted_at IS NULL
    WHERE r.import_key IS DISTINCT FROM CASE WHEN f.id IS NULL THEN NULL ELSE register_import_key(r."values" ->> f.id::text) END`;
  check(Number(staleKeys[0]?.n ?? 0) === 0, 'import_key записей совпадает с полем-ключом', `расходится у ${staleKeys[0]?.n} записей`);
  const incidents = await prisma.register.findUnique({ where: { systemKey: INCIDENT_REGISTER_KEY }, include: { fields: { where: { systemKey: INCIDENT_DATE_KEY, deletedAt: null } } } });
  if (incidents) check(incidents.fields.length === 1, 'у реестра инцидентов есть системное поле «Дата выявления»');
  else console.log('· системного «Реестра инцидентов» нет — KPI «Инциденты за 30 дней» не настроен');
  const kioskMixed = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM (
      SELECT r.id FROM roles r JOIN role_permissions p ON p.role_id = r.id
      GROUP BY r.id HAVING bool_or(p.permission_code = 'monitor.kiosk') AND count(*) > 1
      UNION ALL
      SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
      GROUP BY u.id HAVING count(*) > 1 AND bool_or(EXISTS (
        SELECT 1 FROM role_permissions p WHERE p.role_id = ur.role_id AND p.permission_code = 'monitor.kiosk'))
    ) x`;
  check(Number(kioskMixed[0]?.n ?? 0) === 0, 'право «Настенный монитор» ни с чем не сочетается (роли и пользователи)');

  // Этап 8б: файлы записей, текст PDF, фиксация полей статусом.
  for (const table of ['register_record_files', 'file_texts']) {
    const rights = await prisma.$queryRaw<{ p: string; granted: boolean }[]>`
      SELECT p, has_table_privilege('ibportal_app', ${`public.${table}`}, p) AS granted
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p`;
    const g = (p: string) => rights.find((x) => x.p === p)?.granted === true;
    check(g('SELECT') && g('INSERT') && g('UPDATE') && !g('DELETE') && !g('TRUNCATE'), `ibportal_app: ${table} — SELECT, INSERT, UPDATE, без DELETE и TRUNCATE`);
  }
  const lockTriggers = (await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger
    WHERE tgrelid IN ('public.register_records'::regclass, 'public.register_record_files'::regclass) AND NOT tgisinternal`).map((t) => t.tgname);
  check(['register_records_lock_guard', 'register_record_files_guard'].every((n) => lockTriggers.includes(n)), 'триггеры фиксации полей статусом на месте');
  const pdfWithoutText = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM files f WHERE f.mime = 'application/pdf' AND f.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM file_texts t WHERE t.file_id = f.id)`;
  check(Number(pdfWithoutText[0]?.n ?? 0) === 0, 'у каждого PDF есть строка file_texts (текст для поиска)', `нет у ${pdfWithoutText[0]?.n}`);
  const badLinks = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM register_record_files x JOIN register_fields f ON f.id = x.field_id
    JOIN register_records r ON r.id = x.record_id WHERE f.type <> 'file' OR f.register_id <> r.register_id`;
  check(Number(badLinks[0]?.n ?? 0) === 0, 'файлы записей привязаны к полям «Файл» своего реестра');

  await checkFileStore(process.argv.includes('--sha'));

  const appCanCreate = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT has_schema_privilege('ibportal_app', 'public', 'CREATE') AS ok`;
  check(appCanCreate[0]?.ok === false, 'ibportal_app не может создавать объекты в схеме public');

  const perms = await prisma.permission.findMany({ select: { code: true } });
  const permCodes = new Set(perms.map((p) => p.code));
  check(PERMISSIONS.every((p) => permCodes.has(p.code)), `все ${PERMISSIONS.length} кодов прав на месте`, 'выполните seed');
  check(perms.length === PERMISSIONS.length, 'в БД нет лишних кодов прав');

  for (const role of SYSTEM_ROLES) {
    const r = await prisma.role.findUnique({ where: { code: role.code } });
    check(r?.isSystem === true, `системная роль «${role.name}»`, 'выполните seed');
  }

  const superAdmin = await prisma.role.findUnique({
    where: { code: 'super_admin' },
    include: { permissions: true },
  });
  const superPerms = new Set(superAdmin?.permissions.map((p) => p.permissionCode) ?? []);
  check(SUPER_ADMIN_LOCKED.every((p) => superPerms.has(p)), 'у супер-администратора есть settings.manage и users.manage');
  check(!APPROVAL_PERMISSIONS.some((p) => superPerms.has(p)), 'у супер-администратора нет прав согласования этапов');

  const admins = await prisma.user.count({
    where: {
      isActive: true,
      roles: { some: { role: { permissions: { some: { permissionCode: 'users.manage' } } } } },
    },
  });
  check(admins > 0, 'есть активный пользователь с users.manage', 'создайте администратора: create-admin');
}

async function sha256Of(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Содержимое в FILES_DIR против метаданных в files. Без доступа к тому — пропуск (dev: сервис migrate без тома). */
async function checkFileStore(withSha: boolean) {
  const root = process.env.FILES_DIR ?? '/data/files';
  if (!existsSync(root)) {
    console.log(`– файлы: каталог ${root} недоступен — проверка содержимого пропущена (запустите в контейнере backend)`);
    return;
  }
  const store = diskFileStore(root);
  const rows = await prisma.file.findMany({ select: { id: true, storageKey: true, size: true, sha256: true, deletedAt: true } });
  const problems: string[] = [];
  for (const f of rows) {
    const size = await store.size(f.storageKey);
    if (size === null) {
      problems.push(`${f.id}: нет файла ${f.storageKey}${f.deletedAt ? ' (помечен удалённым)' : ''}`);
      continue;
    }
    if (size !== Number(f.size)) problems.push(`${f.id}: размер ${size} вместо ${f.size}`);
    else if (withSha && (await sha256Of(join(root, ...f.storageKey.split('/')))) !== f.sha256) problems.push(`${f.id}: sha256 не совпадает`);
  }
  check(problems.length === 0, `файлы на месте: ${rows.length}${withSha ? ', sha256 сверены' : ' (размер; sha256 — с флагом --sha)'}`, problems.slice(0, 20).join('; '));
  // Файлы на диске без строки в БД: запись на диск прошла, вставка в БД — нет. Только предупреждение.
  const known = new Set(rows.map((r) => r.storageKey));
  let orphans = 0;
  for (const yyyy of (await readdir(root)).filter((d) => /^\d{4}$/.test(d))) {
    for (const mm of (await readdir(join(root, yyyy))).filter((d) => /^\d{2}$/.test(d))) {
      for (const name of await readdir(join(root, yyyy, mm))) if (!known.has(`${yyyy}/${mm}/${name}`)) orphans++;
    }
  }
  console.log(orphans ? `! файлов на диске без строки в БД: ${orphans} (не удаляются; разобрать вручную)` : '✓ на диске нет файлов без строки в БД');
}

main()
  .catch((err: unknown) => {
    console.error('Проверка прервана:', err instanceof Error ? err.message : err);
    failed++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(failed === 0 ? 'Целостность в порядке' : `Проблем: ${failed}`);
    process.exitCode = failed === 0 ? 0 : 1;
  });
