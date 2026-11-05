import type { PermissionCode } from '../../lib/permissions.js';
import type { SessionSettings } from '../../lib/session-token.js';

export interface UserRecord {
  id: string;
  login: string;
  fullName: string;
  passwordHash: string;
  mustChangePassword: boolean;
  passwordChangedAt: Date;
  failedLoginCount: number;
  lockedUntil: Date | null;
  isActive: boolean;
}

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  /** «Запомнить меня»: постоянная cookie (1.10.0). */
  remember: boolean;
}

/** Открытая сессия для «Моих сессий» и карточки пользователя: id — хэш токена, наружу отдаётся publicId. */
export interface SessionInfo extends SessionRecord {
  publicId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface NewSession {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  remember: boolean;
}

export interface AuthRepository {
  findUserByLogin(login: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  /** Сумма прав всех ролей пользователя, названия и системные коды ролей. */
  getAccess(userId: string): Promise<{ permissions: PermissionCode[]; roleNames: string[]; roleCodes?: (string | null)[] }>;

  saveLockout(userId: string, state: { failedLoginCount: number; lockedUntil: Date | null }): Promise<void>;
  recordSuccessfulLogin(userId: string, at: Date): Promise<void>;

  createSession(session: NewSession): Promise<void>;
  findSession(id: string): Promise<SessionRecord | null>;
  touchSession(id: string, at: Date): Promise<void>;
  revokeSession(id: string, at: Date): Promise<void>;
  /** Закрывает все открытые сессии пользователя, кроме keepSessionId; возвращает число закрытых. */
  revokeOtherSessions(userId: string, keepSessionId: string | null, at: Date): Promise<number>;
  /** Открытые (не закрытые) сессии пользователя, новые сверху. */
  listOpenSessions(userId: string): Promise<SessionInfo[]>;
  /** Закрывает открытую сессию пользователя по publicId; false — такой открытой сессии у него нет. */
  revokeSessionByPublicId(userId: string, publicId: string, at: Date): Promise<boolean>;
  /** Параметр «Параметров портала» auth.session (по умолчанию — если строки нет или она неверна). */
  getSessionSettings(): Promise<SessionSettings>;

  /** Хэши прошлых паролей, от новых к старым. */
  getPasswordHistory(userId: string, limit: number): Promise<string[]>;
  /** Сохраняет новый пароль, старый хэш уходит в историю, снимается признак обязательной смены. */
  changePassword(userId: string, newHash: string, previousHash: string, at: Date): Promise<void>;

  ping(): Promise<boolean>;
}
