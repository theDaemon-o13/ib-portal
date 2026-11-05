import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from '../../lib/password-policy.js';
import { PERMISSION_CODES, type PermissionCode } from '../../lib/permissions.js';
import type { AuthUser } from '../../types.js';

export const LoginBody = z.object({
  login: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH * 4),
  /** «Запомнить меня» (1.10.0): постоянная сессия; у администраторов не действует. Не передано — нет. */
  remember: z.boolean().optional(),
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH * 4),
  newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH * 4),
});

export const Me = z.object({
  id: z.string(),
  login: z.string(),
  fullName: z.string(),
  mustChangePassword: z.boolean(),
  passwordExpired: z.boolean(),
  roles: z.array(z.string()),
  permissions: z.array(z.enum(PERMISSION_CODES as [PermissionCode, ...PermissionCode[]])),
  /** Настенный монитор: интерфейс показывает только /monitor. */
  kiosk: z.boolean(),
  /** Служебная учётная запись «Администратор портала» (ADR-0036): интерфейс показывает только «Настройки». */
  service: z.boolean(),
});

export const MeResponse = z.object({ user: Me });

/** Ответ входа: пользователь и какая сессия открыта (1.10.0). */
export const LoginResponse = MeResponse.extend({
  session: z.object({
    remember: z.boolean(),
    /** Администратор (users.manage или «Администратор портала»): «Запомнить меня» не действует, срок — adminMaxHours. */
    admin: z.boolean(),
    adminMaxHours: z.number().int().nullable(),
    /** До какого времени живёт сессия; null — бессрочно. */
    expiresAt: z.string().nullable(),
  }),
});

export const SessionItem = z.object({
  id: z.string().uuid(),
  current: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  remember: z.boolean(),
  expiresAt: z.string().nullable(),
});

export function toMe(user: AuthUser): z.infer<typeof Me> {
  return {
    id: user.id,
    login: user.login,
    fullName: user.fullName,
    mustChangePassword: user.mustChangePassword,
    passwordExpired: user.passwordExpired,
    roles: [...user.roleNames],
    permissions: [...user.permissions],
    kiosk: user.kiosk,
    service: user.service,
  };
}
