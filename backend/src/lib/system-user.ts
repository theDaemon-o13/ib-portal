// Служебная учётная запись «Портал» (1.14.0, ADR-0053, решение владельца 13.11.2026): создатель системных цепочек задач.
// Нужна, потому что task_chains.created_by — NOT NULL, а 1.13.12 отдаёт создателя цепочки строгой схемой: без неё откат
// без отката базы ломал бы список цепочек. Создаёт seed (system.portal_user.v1_14_0). Отключена, без ролей, пароль —
// argon2id от случайных байт, которые сразу забываются: войти нельзя. В «Пользователях и ролях» её нет, менять нельзя.
import type { Prisma } from '../generated/prisma/client.js';
import type { Db } from './db.js';
import { conflict, notFound } from './errors.js';

export const SYSTEM_USER_LOGIN = 'portal-system';
export const SYSTEM_USER_NAME = 'Портал';

/** Условие Prisma «не служебная учётная запись портала» — для списков пользователей. */
export const NOT_SYSTEM_USER: Prisma.UserWhereInput = { login: { not: SYSTEM_USER_LOGIN } };

export const isSystemUserLogin = (login: string) => login === SYSTEM_USER_LOGIN;

/** Правка, включение, сброс пароля, роли — 409: учётку ведёт портал. */
export function assertNotSystemUser(u: { login: string }) {
  if (isSystemUserLogin(u.login)) throw conflict('SYSTEM_USER', 'Служебную учётную запись портала не меняют');
}

/** id «Портала». Нет строки — seed не выполнен (migrate): ошибка, а не тихий пропуск. */
export async function systemUserId(db: Db): Promise<string> {
  const u = await db.user.findUnique({ where: { login: SYSTEM_USER_LOGIN }, select: { id: true } });
  if (!u) throw notFound('Служебная учётная запись портала (выполните migrate)');
  return u.id;
}
