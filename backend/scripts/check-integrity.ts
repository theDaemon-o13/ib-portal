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
import { APPROVAL_PERMISSIONS, LEGACY_PERMISSION_CODES, PERMISSIONS, RETIRED_ROLE_CODES, SUPER_ADMIN_LOCKED, SYSTEM_ROLES } from '../src/lib/permissions.js';
import { VULN_FIELDS, VULN_REGISTER_KEY } from '../src/modules/vulns/definition.js';
import { RISK_FIELDS, RISK_REGISTER_KEY } from '../src/modules/risks/definition.js';
import { INCIDENT_DATE_KEY, INCIDENT_REGISTER_KEY } from '../src/modules/dashboard/incidents.js';
import { personKey } from '../src/lib/person-key.js';
import { titleKey } from '../src/lib/title-key.js';
import { DirectoryEmailsSchema, DirectorySchema, PARTY_DIRECTORY_EMAILS_KEY, PARTY_DIRECTORY_KEY } from '../src/modules/party-directory/service.js';
import { AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY, EMPLOYEE_FIELDS, RESULT_FIELDS } from '../src/modules/awareness/definition.js';
import { AWARENESS_GRADES_KEY, GradesSchema } from '../src/modules/awareness/grades.js';
import { SERVICE_ROLE_CODE } from '../src/lib/work-users.js';
import { letterIntegrity } from '../src/modules/awareness-letters/integrity.js';
import { ACTIVE_METHODOLOGY } from '../prisma/seed/assessment.js';

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

  // Маршрут 1.11.0 (ADR-0042): новые колонки строк утверждённой версии и «Запросить повторно» не меняются; утверждённая
  // на этапе 24 — с подписанным PDF, исходным Word и Word каждого перевода; рабочая версия на 21–22 — с состоянием этапа.
  const v3Triggers = (await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger WHERE tgrelid IN ('public.document_translations'::regclass, 'public.document_parties'::regclass,
      'public.document_party_rechecks'::regclass) AND NOT tgisinternal`).map((t) => t.tgname);
  check(
    ['document_translations_frozen', 'document_parties_frozen', 'document_party_rechecks_append_only', 'document_party_rechecks_no_truncate']
      .every((n) => v3Triggers.includes(n)),
    'триггеры маршрута 1.11.0 на месте: файлы и отметки утверждённой версии, «Запросить повторно» только пополняется',
  );
  const recheckPrivs = await prisma.$queryRaw<{ granted: boolean }[]>`
    SELECT bool_or(has_table_privilege('ibportal_app', 'public.document_party_rechecks', p)) AS granted FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p`;
  check(recheckPrivs[0]?.granted === false, 'ibportal_app: нет UPDATE, DELETE, TRUNCATE на document_party_rechecks');
  const approvedNoFiles = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM document_versions v
    WHERE v.stage = 24 AND v.approved_at IS NOT NULL
      AND (v.pdf_file_id IS NULL OR v.source_docx_file_id IS NULL
        OR EXISTS (SELECT 1 FROM document_translations t WHERE t.version_id = v.id AND t.removed_at IS NULL AND t.source_docx_file_id IS NULL))`;
  check(Number(approvedNoFiles[0]?.n ?? 0) === 0, 'утверждённые на этапе 24 — с подписанным PDF, исходным Word и Word каждого перевода',
    `версий без обязательных файлов: ${approvedNoFiles[0]?.n ?? 0}`);
  const badState = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM documents d JOIN document_versions v ON v.id = d.working_version_id
    WHERE v.stage IN (21, 22) AND v.route_state IS NULL`;
  check(Number(badState[0]?.n ?? 0) === 0, 'рабочие версии на этапах 21–22 — с состоянием этапа (route_state)', `без состояния: ${badState[0]?.n ?? 0}`);

  // Механизмы контроля (1.11.0, ADR-0043): не удаляются, запуски только пополняются.
  const ctlTriggers = (await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger WHERE tgrelid IN ('public.document_controls'::regclass, 'public.document_control_automations'::regclass,
      'public.document_control_runs'::regclass) AND NOT tgisinternal`).map((t) => t.tgname);
  check(
    ['document_controls_no_delete', 'document_control_automations_no_delete', 'document_control_runs_append_only', 'document_control_runs_no_truncate']
      .every((n) => ctlTriggers.includes(n)),
    'триггеры механизмов контроля на месте: механизмы и автоматизации не удаляются, запуски только пополняются',
  );
  const ctlPrivs = await prisma.$queryRaw<{ t: string; p: string; granted: boolean }[]>`
    SELECT t, p, has_table_privilege('ibportal_app', 'public.' || t, p) AS granted
    FROM unnest(ARRAY['document_controls', 'document_control_automations', 'document_control_runs']) AS t, unnest(ARRAY['UPDATE', 'DELETE']) AS p`;
  check(ctlPrivs.every((r) => !r.granted || (r.p === 'UPDATE' && r.t !== 'document_control_runs')),
    'ibportal_app: механизмы и автоматизации — без DELETE, запуски — без UPDATE и DELETE');

  const badRuns = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM document_control_runs r LEFT JOIN tasks t ON t.id = r.task_id
    WHERE r.status = 'created' AND (t.id IS NULL OR t.source <> 'document_control')`;
  check(Number(badRuns[0]?.n ?? 0) === 0, 'запуски контроля «создана задача» — со ссылкой на задачу контроля', `без задачи: ${badRuns[0]?.n ?? 0}`);

  // Релиз 1.2.0: переходы задач только пополняются (ADR-0022); колонка открытой задачи согласована с исполнителем.
  const transitionPrivs = await prisma.$queryRaw<{ ins: boolean; mod: boolean }[]>`
    SELECT has_table_privilege('ibportal_app', 'public.task_transitions', 'INSERT') AS ins,
           bool_or(has_table_privilege('ibportal_app', 'public.task_transitions', p)) AS mod
    FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p`;
  check(transitionPrivs[0]?.ins === true && transitionPrivs[0]?.mod === false, 'ibportal_app: task_transitions только пополняется');
  const transitionTriggers = await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.task_transitions'::regclass AND NOT tgisinternal`;
  check(
    ['task_transitions_no_update_delete', 'task_transitions_no_truncate'].every((n) => transitionTriggers.some((t) => t.tgname === n)),
    'триггеры запрета правки task_transitions на месте',
  );
  const misplaced = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM tasks t JOIN catalog_items s ON s.id = t.status_id
    WHERE t.deleted_at IS NULL AND t.completed_at IS NULL
      AND ((s.system_key = 'new' AND t.assignee_id IS NOT NULL) OR (s.system_key = 'assigned' AND t.assignee_id IS NULL))`;
  check(Number(misplaced[0]?.n ?? 0) === 0, 'открытые задачи: в Backlog — без исполнителя, в «Поставленные» — с исполнителем',
    `не на месте: ${misplaced[0]?.n} — выполните seed (migrate)`);
  // Релиз 1.4.0 (ADR-0028): проверяющий задачи на проверке — активный и не исполнитель.
  const badReviewers = await prisma.$queryRaw<{ number: number }[]>`
    SELECT t.number FROM tasks t JOIN catalog_items s ON s.id = t.status_id JOIN users u ON u.id = t.reviewer_id
    WHERE t.deleted_at IS NULL AND t.completed_at IS NULL AND s.system_key = 'review'
      AND (NOT u.is_active OR t.reviewer_id = t.assignee_id) ORDER BY t.number`;
  check(badReviewers.length === 0, 'задачи на проверке: проверяющий активен и не исполнитель',
    `задачи ${badReviewers.map((r) => `#${r.number}`).join(', ')} — «Заменить проверяющего» в карточке`);
  // Не ошибка: без проверяющего задачи принимаются по правилам до 1.4.0 (tasks.review). После отката на 1.3.0 и повторной
  // выкладки — сюда попадают задачи, отправленные на 1.3.0: им назначают проверяющего вручную (deploy/prechecks/1.4.0.md).
  const legacyReview = await prisma.$queryRaw<{ number: number }[]>`
    SELECT t.number FROM tasks t JOIN catalog_items s ON s.id = t.status_id
    WHERE t.deleted_at IS NULL AND t.completed_at IS NULL AND s.system_key = 'review' AND t.reviewer_id IS NULL ORDER BY t.number`;
  if (legacyReview.length) {
    const shown = legacyReview.slice(0, 50).map((r) => `#${r.number}`).join(', ');
    console.log(`· задач на проверке без проверяющего (правила до 1.4.0, tasks.review): ${legacyReview.length} — ${shown}${legacyReview.length > 50 ? ', …' : ''}`);
  }

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

  // Релиз 1.5.0 (ADR-0030): «Продлено, дн.» = сумма действующих продлений текущего цикла; таблицы только пополняются.
  const extPrivs = await prisma.$queryRaw<{ ins: boolean; upd: boolean; del: boolean; item_ins: boolean; item_mod: boolean }[]>`
    SELECT has_table_privilege('ibportal_app', 'public.vuln_extensions', 'INSERT') AS ins,
           has_table_privilege('ibportal_app', 'public.vuln_extensions', 'UPDATE') AS upd,
           has_table_privilege('ibportal_app', 'public.vuln_extensions', 'DELETE') AS del,
           has_table_privilege('ibportal_app', 'public.vuln_extension_items', 'INSERT') AS item_ins,
           has_table_privilege('ibportal_app', 'public.vuln_extension_items', 'UPDATE') OR has_table_privilege('ibportal_app', 'public.vuln_extension_items', 'DELETE') AS item_mod`;
  const ep = extPrivs[0];
  check(ep?.ins === true && ep.upd === true && ep.del === false && ep.item_ins === true && ep.item_mod === false, 'ibportal_app: продления только пополняются, отмена — UPDATE одной строки');
  if (vulns) {
    const extDays = await prisma.registerField.findFirst({ where: { registerId: vulns.id, systemKey: 'extDays' }, select: { id: true } });
    if (extDays) {
      const diverged = await prisma.$queryRaw<{ number: number; stored: number; expected: number }[]>`
        SELECT r.number, coalesce((r."values" ->> ${extDays.id})::int, 0) AS stored, coalesce(s.days, 0)::int AS expected
        FROM vuln_records v JOIN register_records r ON r.id = v.record_id
        LEFT JOIN (
          SELECT i.record_id, i.cycle, sum(i.days) AS days FROM vuln_extension_items i
          JOIN vuln_extensions e ON e.id = i.extension_id WHERE e.cancelled_at IS NULL GROUP BY 1, 2
        ) s ON s.record_id = v.record_id AND s.cycle = v.cycle
        WHERE r.deleted_at IS NULL AND coalesce((r."values" ->> ${extDays.id})::int, 0) <> coalesce(s.days, 0)
        ORDER BY r.number LIMIT 20`;
      check(diverged.length === 0, '«Продлено, дн.» совпадает с суммой действующих продлений', diverged.map((d) => `#${d.number}: ${d.stored} вместо ${d.expected}`).join(', '));
    }
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
  // Релиз 1.2.0 (ADR-0024): маршрут 11–16, комментарии и файлы версии, удаление.
  const docPrivs = await prisma.$queryRaw<{ t: string; granted: boolean }[]>`
    SELECT t, bool_or(has_table_privilege('ibportal_app', 'public.' || t, p)) AS granted
    FROM unnest(ARRAY['document_comments', 'document_files']) AS t,
         unnest(ARRAY['DELETE', 'TRUNCATE']) AS p GROUP BY t`;
  check(docPrivs.length === 2 && docPrivs.every((r) => !r.granted), 'ibportal_app: нет DELETE, TRUNCATE на document_comments и document_files');
  const docFileTriggers = (await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.document_files'::regclass AND NOT tgisinternal`).map((t) => t.tgname);
  check(
    ['document_files_guard', 'document_files_no_truncate', 'document_files_file_alive'].every((n) => docFileTriggers.includes(n)),
    'триггеры неизменности файлов документов на месте',
  );
  // Этап 14 (Г3): история сроков только пополняется, блокеры и лица не удаляются.
  const g3Privs = await prisma.$queryRaw<{ t: string; p: string; granted: boolean }[]>`
    SELECT t, p, has_table_privilege('ibportal_app', 'public.' || t, p) AS granted
    FROM unnest(ARRAY['document_parties', 'document_blockers', 'document_deadline_changes', 'document_translations']) AS t,
         unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p`;
  check(
    g3Privs.length === 12 && g3Privs.every((r) => !r.granted || (r.p === 'UPDATE' && r.t !== 'document_deadline_changes')),
    'ibportal_app: нет DELETE и TRUNCATE на лицах, переводах и блокерах документов, история сроков только пополняется',
  );
  const g3Triggers = (await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger WHERE tgrelid IN ('public.document_blockers'::regclass, 'public.document_deadline_changes'::regclass) AND NOT tgisinternal`).map((t) => t.tgname);
  check(
    ['document_blockers_guard', 'document_blockers_no_truncate', 'document_deadline_changes_no_update_delete', 'document_deadline_changes_no_truncate']
      .every((n) => g3Triggers.includes(n)),
    'триггеры неизменности блокеров и истории сроков на месте',
  );
  // После обновления на 1.2.0 рабочих версий на старом маршруте нет (seed docs.route.v1_2 переносит их каждый запуск).
  const legacyWorking = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM documents d JOIN document_versions v ON v.id = d.working_version_id WHERE v.stage BETWEEN 0 AND 3`;
  check(Number(legacyWorking[0]?.n ?? 0) === 0, 'рабочие версии документов — на маршруте 1.2.0 (этапы 11–16)');
  const deletedSigned = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM documents WHERE deleted_at IS NOT NULL AND (approved_version_id IS NOT NULL OR archived_at IS NULL)`;
  check(Number(deletedSigned[0]?.n ?? 0) === 0, 'удалённые документы — без подписанной версии и в архиве');

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
  // Коды прав до 1.2.0 (юрист, правление) остаются в БД до 1.3.0 ради отката (ADR-0024).
  const known = new Set<string>([...PERMISSIONS.map((p) => p.code), ...LEGACY_PERMISSION_CODES]);
  check(perms.every((p) => known.has(p.code)), 'в БД нет лишних кодов прав');

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
  check(![...APPROVAL_PERMISSIONS, ...LEGACY_PERMISSION_CODES].some((p) => superPerms.has(p)), 'у супер-администратора нет прав согласования этапов');
  // Самооценка (ADR-0026): право только у системной роли «Самооценка», методика загружена, удаления нет.
  const assessmentRoles = await prisma.rolePermission.findMany({ where: { permissionCode: 'assessment.manage' }, select: { role: { select: { code: true } } } });
  check(assessmentRoles.length === 1 && assessmentRoles[0]?.role.code === 'assessment', 'право «Самооценка» есть только у системной роли «Самооценка»', 'выполните seed');
  const activeMethodologies = await prisma.assessmentMethodology.findMany({ where: { isActive: true }, select: { code: true, version: true } });
  check(activeMethodologies.length >= 1, 'методика самооценки загружена', 'выполните seed');
  // 1.13.10 (ADR-0050): активная — последняя версия из seed (cyber-express-v2, домен «Контроль ИИ» вне итога).
  check(activeMethodologies.length === 1 && activeMethodologies[0]?.code === ACTIVE_METHODOLOGY.code && activeMethodologies[0]?.version === ACTIVE_METHODOLOGY.version,
    `активная методика самооценки — ${ACTIVE_METHODOLOGY.code} v${ACTIVE_METHODOLOGY.version}`, 'выполните seed (migrate)');
  const assessmentPrivs = await prisma.$queryRaw<{ granted: boolean }[]>`
    SELECT bool_or(has_table_privilege('ibportal_app', 'public.' || t, p)) AS granted
    FROM unnest(ARRAY['assessments', 'assessment_answers', 'assessment_links']) AS t, unnest(ARRAY['DELETE', 'TRUNCATE']) AS p`;
  check(assessmentPrivs[0]?.granted === false, 'ibportal_app: нет DELETE и TRUNCATE на оценках самооценки');
  // Отметка «Начальник ИБ» (1.4.0, ADR-0027): не больше одной (индекс); держатель — активный, с ib.work, не супер-администратор.
  const ibHeads = await prisma.user.findMany({
    where: { isIbHead: true },
    select: { isActive: true, roles: { select: { role: { select: { code: true, permissions: { select: { permissionCode: true } } } } } } },
  });
  const headOk = ibHeads.every((h) => h.isActive && !h.roles.some((r) => r.role.code === 'super_admin')
    && h.roles.some((r) => r.role.permissions.some((p) => p.permissionCode === 'ib.work')));
  check(ibHeads.length <= 1 && headOk, ibHeads.length ? 'отметка «Начальник ИБ»: один держатель, активный, с доступом к разделам ИБ' : 'отметка «Начальник ИБ» не поставлена (этап документов без исполнителя)', 'проверьте карточку пользователя с отметкой');
  // Раздел «Уязвимости» (1.5.0, ADR-0029): группы, узлы, сканы и записи узлов не удаляются, сканы записи только пополняются.
  const vulnPrivs = await prisma.$queryRaw<{ granted: boolean }[]>`
    SELECT bool_or(has_table_privilege('ibportal_app', 'public.' || t, p)) AS granted
    FROM unnest(ARRAY['vuln_groups', 'vuln_nodes', 'vuln_scans', 'vuln_records', 'vuln_record_scans']) AS t, unnest(ARRAY['DELETE', 'TRUNCATE']) AS p`;
  const vulnSeen = await prisma.$queryRaw<{ granted: boolean }[]>`
    SELECT has_table_privilege('ibportal_app', 'public.vuln_record_scans', 'UPDATE') AS granted`;
  check(vulnPrivs[0]?.granted === false && vulnSeen[0]?.granted === false, 'ibportal_app: нет DELETE и TRUNCATE в разделе «Уязвимости», сканы записи только пополняются');
  const ungrouped = await prisma.vulnNode.count({ where: { systemKey: 'legacy', group: { systemKey: 'ungrouped' } } });
  check(ungrouped === 1, 'есть «Без группы / Из прежнего реестра»', 'выполните seed');
  // Аннулированные сканы (1.13.12, ADR-0052): не переданы ИКТ; у их узлов есть хотя бы один неаннулированный скан.
  const annulBad = await prisma.$queryRaw<{ handed: bigint; bare: bigint }[]>`
    WITH a AS (SELECT DISTINCT entity_id FROM deletions WHERE entity = 'vuln_scan' AND restored_at IS NULL)
    SELECT
      (SELECT count(*) FROM vuln_scans s JOIN a ON a.entity_id = s.id WHERE s.handed_over_on IS NOT NULL) AS handed,
      (SELECT count(DISTINCT s.node_id) FROM vuln_scans s JOIN a ON a.entity_id = s.id
        WHERE NOT EXISTS (SELECT 1 FROM vuln_scans o WHERE o.node_id = s.node_id AND o.id NOT IN (SELECT entity_id FROM a))) AS bare`;
  check(Number(annulBad[0]?.handed ?? 0) === 0 && Number(annulBad[0]?.bare ?? 0) === 0,
    'аннулированные сканы: не переданы ИКТ, в их узлах есть неаннулированный скан',
    `переданных ИКТ — ${annulBad[0]?.handed ?? 0}, узлов без неаннулированного скана — ${annulBad[0]?.bare ?? 0}`);
  const orphans = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM register_records r JOIN registers g ON g.id = r.register_id
    LEFT JOIN vuln_records v ON v.record_id = r.id WHERE g.system_key = 'vulns' AND v.record_id IS NULL`;
  check(Number(orphans[0]?.n ?? 0) === 0, 'у каждой записи реестра уязвимостей есть узел', `без узла: ${orphans[0]?.n ?? 0} — выполните seed (migrate): они попадут в «Без группы»`);
  const keyDup = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM vuln_records v JOIN register_records r ON r.id = v.record_id WHERE v.key_norm IS NOT NULL AND r.deleted_at IS NOT NULL`;
  check(Number(keyDup[0]?.n ?? 0) === 0, 'удалённые записи не держат ключ в узле', 'vuln_records.key_norm у удалённых записей');
  // Корзина (1.6.1, ADR-0033): у удалённой группы удалены и узлы; восстановленное событие ничего не скрывает.
  const liveNodesOfDeleted = await prisma.vulnNode.count({ where: { deletedAt: null, group: { deletedAt: { not: null } } } });
  check(liveNodesOfDeleted === 0, 'у удалённой группы уязвимостей нет действующих типов систем', `таких узлов: ${liveNodesOfDeleted}`);
  const stillHidden = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT (SELECT count(*) FROM register_records r JOIN deletions d ON d.id = r.deletion_id WHERE d.restored_at IS NOT NULL)
         + (SELECT count(*) FROM registers r JOIN deletions d ON d.id = r.deletion_id WHERE d.restored_at IS NOT NULL)
         + (SELECT count(*) FROM vuln_groups g JOIN deletions d ON d.id = g.deletion_id WHERE d.restored_at IS NOT NULL)
         + (SELECT count(*) FROM vuln_nodes n JOIN deletions d ON d.id = n.deletion_id WHERE d.restored_at IS NOT NULL) AS n`;
  check(Number(stillHidden[0]?.n ?? 0) === 0, 'восстановленные удаления ничего не скрывают (корзина)', `скрыто восстановленными событиями: ${stillHidden[0]?.n ?? 0}`);
  const badTypes = await prisma.vulnNode.count({ where: { systemTypeId: { not: null }, systemType: { catalogCode: { not: 'system_types' } } } });
  check(badTypes === 0, 'тип узла — значение справочника «Типы систем»', 'проверьте vuln_nodes.system_type_id');
  const retiredUsers = await prisma.userRole.count({ where: { role: { code: { in: [...RETIRED_ROLE_CODES] } } } });
  check(retiredUsers === 0, 'в ролях «Юрист» и «Правление» нет пользователей (перенесены в «Читатель документов»)', 'выполните seed');
  // Справочник «Ответственные лица» (1.6.7): значение app_settings по схеме, id уникальны. Нет строки — справочник пуст.
  const dirRow = await prisma.appSetting.findUnique({ where: { key: PARTY_DIRECTORY_KEY } });
  const dir = dirRow ? DirectorySchema.safeParse(dirRow.value) : null;
  const dirIds = dir?.success ? dir.data.items.map((i) => i.id) : [];
  check(!dir || (dir.success && new Set(dirIds).size === dirIds.length), `справочник «Ответственные лица»: ${dir?.success ? `${dirIds.length} записей, значение по схеме` : dir ? 'значение не по схеме' : 'пуст'}`,
    dir && !dir.success ? `app_settings.${PARTY_DIRECTORY_KEY}: ${dir.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} — ${i.message}`).join('; ')}` : `повторяются id записей в app_settings.${PARTY_DIRECTORY_KEY}`);
  // Почты справочника (1.13.6) — отдельный ключ: по схеме; почта без записи справочника — только отчёт (запись не удаляется,
  // так не бывает без ручной правки app_settings).
  const mailRow = await prisma.appSetting.findUnique({ where: { key: PARTY_DIRECTORY_EMAILS_KEY } });
  const mail = mailRow ? DirectoryEmailsSchema.safeParse(mailRow.value) : null;
  const orphanMails = mail?.success ? Object.keys(mail.data.emails).filter((id) => !dirIds.includes(id)).length : 0;
  check(!mail || mail.success, `почты справочника «Ответственные лица»: ${mail?.success ? `${Object.keys(mail.data.emails).length}, значение по схеме${orphanMails ? `; без записи справочника — ${orphanMails}` : ''}` : mail ? 'значение не по схеме' : 'нет'}`,
    mail && !mail.success ? `app_settings.${PARTY_DIRECTORY_EMAILS_KEY}: ${mail.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} — ${i.message}`).join('; ')}` : '');
  // Дубли лиц в одной версии документа (до 1.6.7 не запрещались) — только отчёт: старые записи не трогаем.
  const partyRows = await prisma.documentParty.findMany({ where: { removedAt: null }, select: { versionId: true, fullName: true, department: true, document: { select: { number: true } } } });
  const seenParty = new Map<string, number>();
  const dupDocs = new Set<number>();
  for (const r of partyRows) {
    const k = `${r.versionId}\u0000${personKey(r.fullName, r.department)}`;
    seenParty.set(k, (seenParty.get(k) ?? 0) + 1);
    if ((seenParty.get(k) ?? 0) > 1) dupDocs.add(r.document.number);
  }
  console.log(`ℹ ответственные лица: дублей в одной версии документа — ${dupDocs.size ? `в документах ${[...dupDocs].sort((x, y) => x - y).map((n) => `#${n}`).join(', ')} (добавлены до 1.6.7, не исправляются)` : 'нет'}`);

  // Цепочки задач (1.7.0, ADR-0035): права роли приложения, ключ по названию, удалённая цепочка без задач.
  const chainPrivs = await prisma.$queryRaw<{ ok: boolean; seq: boolean }[]>`
    SELECT bool_and(has_table_privilege('ibportal_app', 'public.task_chains', p)) AS ok,
           has_sequence_privilege('ibportal_app', pg_get_serial_sequence('public.task_chains', 'number'), 'USAGE') AS seq
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p`;
  check(chainPrivs[0]?.ok === true && chainPrivs[0]?.seq === true, 'ibportal_app: SELECT, INSERT, UPDATE на task_chains и USAGE на их последовательность');
  const chains = await prisma.taskChain.findMany({ where: { deletedAt: null }, select: { number: true, title: true, titleKey: true } });
  const badKeys = chains.filter((c) => titleKey(c.title) !== c.titleKey).map((c) => `#${c.number}`);
  check(badKeys.length === 0, `цепочки задач: ключ соответствует названию (${chains.length})`, `цепочки ${badKeys.slice(0, 20).join(', ')} — сохраните название в панели цепочки`);
  const inDeleted = await prisma.task.count({ where: { chain: { deletedAt: { not: null } } } });
  check(inDeleted === 0, 'задачи не ссылаются на удалённые цепочки', `задач: ${inDeleted} — удаление цепочки должно было их отвязать`);

  await checkAwareness();
  // Учебные письма и расписание (1.9.0).
  // warn — законное состояние (роль правила без ib.work): «!», как «файлы без строки в БД», выкладку не останавливает.
  for (const c of await letterIntegrity(prisma)) {
    if (c.level === 'warn' && !c.ok) console.log(`! ${c.label} — ${c.hint}`);
    else check(c.ok, c.label, c.hint);
  }
  await checkServiceRole();

  const admins = await prisma.user.count({
    where: {
      isActive: true,
      roles: { some: { role: { permissions: { some: { permissionCode: 'users.manage' } } } } },
    },
  });
  check(admins > 0, 'есть активный пользователь с users.manage', 'создайте администратора: create-admin');
}

/**
 * «Осведомлённость» (1.8.0, docs/specs/awareness.md, раздел 8): системные поля на месте; ключи попыток уникальны;
 * пороги проходят проверку; «Сопоставление» согласовано со связью («Точно» и «Вручную» — со связью, «Не сопоставлен» — без).
 */
async function checkAwareness() {
  const regs = await prisma.register.findMany({
    where: { systemKey: { in: [AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY] } },
    select: { id: true, name: true, systemKey: true, fields: { where: { deletedAt: null }, select: { id: true, systemKey: true, options: { where: { deletedAt: null }, select: { id: true, systemKey: true } } } } },
  });
  for (const [key, specs] of [[AWARENESS_EMPLOYEES_KEY, EMPLOYEE_FIELDS], [AWARENESS_RESULTS_KEY, RESULT_FIELDS]] as const) {
    const reg = regs.find((r) => r.systemKey === key);
    const missing = specs.map((f) => f.key).filter((k) => !reg?.fields.some((f) => f.systemKey === k));
    check(!!reg && missing.length === 0, `осведомлённость: системные поля реестра «${reg?.name ?? key}»`, reg ? `нет полей: ${missing.join(', ')}` : 'реестра нет — выполните migrate (seed awareness.v1)');
  }
  const grades = await prisma.appSetting.findUnique({ where: { key: AWARENESS_GRADES_KEY } });
  const parsed = grades ? GradesSchema.safeParse(grades.value) : null;
  check(!grades || parsed?.success === true, 'осведомлённость: пороги оценки проходят проверку', parsed && !parsed.success ? parsed.error.issues.map((i) => i.message).join('; ') : '');

  const res = regs.find((r) => r.systemKey === AWARENESS_RESULTS_KEY);
  if (!res) return;
  const dupes = await prisma.$queryRaw<{ k: string; n: bigint }[]>`
    SELECT import_key AS k, count(*) AS n FROM register_records
    WHERE register_id = ${res.id}::uuid AND deleted_at IS NULL AND import_key IS NOT NULL GROUP BY 1 HAVING count(*) > 1 LIMIT 20`;
  check(dupes.length === 0, 'осведомлённость: ключи попыток уникальны', `повторы: ${dupes.map((d) => `«${d.k}» ×${d.n}`).join(', ')}`);
  const employee = res.fields.find((f) => f.systemKey === 'employee');
  const match = res.fields.find((f) => f.systemKey === 'match');
  const none = match?.options.find((o) => o.systemKey === 'none')?.id;
  if (!employee || !match || !none) return;
  const bad = await prisma.$queryRaw<{ number: number }[]>`
    SELECT number FROM register_records r
    WHERE r.register_id = ${res.id}::uuid AND r.deleted_at IS NULL
      AND (r."values" ->> ${match.id} = ${none}) = (jsonb_typeof(r."values" -> ${employee.id}) = 'array' AND jsonb_array_length(r."values" -> ${employee.id}) > 0)
    ORDER BY number LIMIT 20`;
  check(bad.length === 0, 'осведомлённость: «Сопоставление» согласовано со связью «Сотрудник»', `записи ${bad.map((b) => `#${b.number}`).join(', ')} — исправьте «Сотрудника» в карточке`);
}

/** Служебная роль «Администратор портала» (1.8.0, ADR-0036): только settings.manage и users.manage, не совмещается с другими. */
async function checkServiceRole() {
  const role = await prisma.role.findUnique({ where: { code: SERVICE_ROLE_CODE }, select: { id: true, permissions: { select: { permissionCode: true } } } });
  if (!role) return;
  const perms = role.permissions.map((p) => p.permissionCode).sort();
  check(perms.join() === 'settings.manage,users.manage', 'служебная роль «Администратор портала»: только settings.manage и users.manage', `права: ${perms.join(', ')}`);
  const mixed = await prisma.$queryRaw<{ login: string }[]>`
    SELECT u.login FROM users u JOIN user_roles ur ON ur.user_id = u.id
    GROUP BY u.id, u.login HAVING count(*) > 1 AND bool_or(ur.role_id = ${role.id}::uuid) LIMIT 20`;
  check(mixed.length === 0, 'служебная роль не совмещена с другими ролями', `пользователи: ${mixed.map((m) => m.login).join(', ')}`);
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
