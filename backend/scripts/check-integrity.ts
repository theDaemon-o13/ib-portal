// Проверка целостности после миграций (CLAUDE.md, раздел 9, п. 4):
//   npm run check:integrity
// Ничего не меняет, только читает. Код выхода 1, если что-то не так.
import { createPrisma } from '../src/lib/db.js';
import { APPROVAL_PERMISSIONS, PERMISSIONS, SUPER_ADMIN_LOCKED, SYSTEM_ROLES } from '../src/lib/permissions.js';
import { VULN_FIELDS, VULN_REGISTER_KEY } from '../src/modules/vulns/definition.js';

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
