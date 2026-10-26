// Создание первого администратора (CLAUDE.md, раздел 10):
//   docker compose run --rm backend node dist/scripts/create-admin.js
// Логин, ФИО и пароль спрашиваются интерактивно и нигде не сохраняются в открытом виде.
import { createPrisma } from '../src/lib/db.js';
import { checkPasswordStrength, violationMessage } from '../src/lib/password-policy.js';
import { argon2Hasher } from '../src/lib/passwords.js';
import { normalizeLogin } from '../src/modules/auth/service.js';
import { ask, askHidden, closePrompt } from './prompt.js';

const LOGIN_RE = /^[a-z0-9._-]{3,64}$/;

async function main() {
  const prisma = createPrisma();
  try {
    const superAdmin = await prisma.role.findUnique({ where: { code: 'super_admin' } });
    if (!superAdmin) {
      throw new Error('Нет роли «Супер-администратор». Сначала выполните миграции и seed (сервис migrate)');
    }

    const login = normalizeLogin(await ask('Логин: '));
    if (!LOGIN_RE.test(login)) throw new Error('Логин: 3–64 символа, латиница, цифры, точка, дефис, подчёркивание');
    if (await prisma.user.findUnique({ where: { login } })) throw new Error(`Пользователь ${login} уже есть`);

    const fullName = await ask('ФИО (например, И. Иванов): ');
    if (!fullName) throw new Error('ФИО не может быть пустым');

    const password = await askHidden('Пароль: ');
    const violations = checkPasswordStrength(password, login);
    if (violations.length > 0) throw new Error(violations.map(violationMessage).join('. '));
    if ((await askHidden('Повторите пароль: ')) !== password) throw new Error('Пароли не совпадают');

    const passwordHash = await argon2Hasher.hash(password);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          login,
          fullName,
          passwordHash,
          // Пароль задал сам администратор, повторная смена при первом входе не нужна.
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          roles: { create: { roleId: superAdmin.id } },
        },
      });
      await tx.auditLog.create({
        data: {
          userId: null,
          action: 'user.created',
          entity: 'user',
          entityId: created.id,
          diff: {
            summary: `Пользователи: создан ${fullName} (${login}) командой create-admin, роль «${superAdmin.name}»`,
            actorRoles: [],
            login,
            fullName,
            roles: ['super_admin'],
            via: 'create-admin',
          },
        },
      });
      return created;
    });
    console.log(`Администратор ${user.login} создан с ролью «${superAdmin.name}»`);
  } finally {
    closePrompt();
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
