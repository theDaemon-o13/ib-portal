// Однократно (отметка system.portal_user.v1_14_0): служебная учётная запись «Портал» — создатель системных цепочек
// задач (1.14.0, ADR-0053). Отключена, без ролей; пароль — argon2id от случайных 64 байт, которые нигде не сохраняются.
// Логин уже занят чужой учётной записью (без отметки) — seed останавливается: такую учётку переименовывают вручную.
import { randomBytes } from 'node:crypto';
import type { Db } from '../../src/lib/db.js';
import { argon2Hasher } from '../../src/lib/passwords.js';
import { SYSTEM_USER_LOGIN, SYSTEM_USER_NAME } from '../../src/lib/system-user.js';

const MARKER = 'system.portal_user.v1_14_0';

export async function seedSystemUser(tx: Db) {
  const marked = await tx.seedMarker.findUnique({ where: { key: MARKER } });
  const existing = await tx.user.findUnique({ where: { login: SYSTEM_USER_LOGIN }, select: { id: true } });
  if (existing) {
    if (marked) return;
    throw new Error(`Логин «${SYSTEM_USER_LOGIN}» занят: он нужен служебной учётной записи портала (1.14.0). Переименуйте этого пользователя и повторите migrate`);
  }
  const passwordHash = await argon2Hasher.hash(randomBytes(64).toString('base64'));
  await tx.user.create({
    data: { login: SYSTEM_USER_LOGIN, fullName: SYSTEM_USER_NAME, position: 'Служебная учётная запись', passwordHash, isActive: false, mustChangePassword: true },
  });
  if (!marked) await tx.seedMarker.create({ data: { key: MARKER } });
}
