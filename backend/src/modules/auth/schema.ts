import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from '../../lib/password-policy.js';
import { PERMISSION_CODES, type PermissionCode } from '../../lib/permissions.js';
import type { AuthUser } from '../../types.js';

export const LoginBody = z.object({
  login: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH * 4),
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
});

export const MeResponse = z.object({ user: Me });

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
  };
}
