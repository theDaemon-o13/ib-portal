import { AppError } from '../../lib/errors.js';
import { isLocked, registerFailure, registerSuccess } from '../../lib/lockout.js';
import {
  PASSWORD_HISTORY_DEPTH,
  checkPasswordStrength,
  isPasswordExpired,
  isRecentlyUsed,
  violationMessage,
} from '../../lib/password-policy.js';
import type { PasswordHasher } from '../../lib/passwords.js';
import {
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  newSessionToken,
  sessionIdFromToken,
} from '../../lib/session-token.js';
import type { AuthUser } from '../../types.js';
import type { AuditWriter } from '../audit/audit.js';
import type { AuthRepository, UserRecord } from './repository.js';

export interface AuthServiceDeps {
  repo: AuthRepository;
  audit: AuditWriter;
  hasher: PasswordHasher;
  now?: () => Date;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль');

export const accountLocked = (lockedUntil: Date) =>
  new AppError(
    423,
    'ACCOUNT_LOCKED',
    'Слишком много неудачных попыток. Вход временно заблокирован',
    { lockedUntil: lockedUntil.toISOString() },
  );

export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function createAuthService({ repo, audit, hasher, now = () => new Date() }: AuthServiceDeps) {
  // Хэш-заглушка: на несуществующий логин тратим столько же времени, сколько на настоящий.
  let dummyHash: Promise<string> | null = null;
  const getDummyHash = () => (dummyHash ??= hasher.hash('dummy-password-for-timing'));

  async function toAuthUser(user: UserRecord): Promise<AuthUser> {
    const access = await repo.getAccess(user.id);
    const passwordExpired = isPasswordExpired(user.passwordChangedAt, now());
    return {
      id: user.id,
      login: user.login,
      fullName: user.fullName,
      mustChangePassword: user.mustChangePassword || passwordExpired,
      passwordExpired,
      permissions: new Set(access.permissions),
      roleNames: access.roleNames,
    };
  }

  async function login(input: { login: string; password: string }, client: ClientInfo) {
    const login = normalizeLogin(input.login);
    const at = now();
    const user = await repo.findUserByLogin(login);

    if (!user) {
      await hasher.verify(await getDummyHash(), input.password);
      await audit.write({ userId: null, action: 'auth.login_failed', diff: { login, reason: 'unknown_user' }, ip: client.ip });
      throw invalidCredentials();
    }

    // Во время блокировки пароль не проверяется.
    if (isLocked(user, at) && user.lockedUntil) {
      await audit.write({
        userId: user.id, action: 'auth.login_failed', entity: 'user', entityId: user.id,
        diff: { login, reason: 'locked' }, ip: client.ip,
      });
      throw accountLocked(user.lockedUntil);
    }

    const passwordOk = await hasher.verify(user.passwordHash, input.password);

    if (!passwordOk) {
      const next = registerFailure(user, at);
      await repo.saveLockout(user.id, { failedLoginCount: next.failedLoginCount, lockedUntil: next.lockedUntil });
      await audit.write({
        userId: user.id, action: 'auth.login_failed', entity: 'user', entityId: user.id,
        diff: { login, reason: 'wrong_password', attempt: next.failedLoginCount }, ip: client.ip,
      });
      if (next.lockedNow && next.lockedUntil) {
        await audit.write({
          userId: user.id, action: 'auth.locked', entity: 'user', entityId: user.id,
          diff: { lockedUntil: next.lockedUntil.toISOString() }, ip: client.ip,
        });
        throw accountLocked(next.lockedUntil);
      }
      throw invalidCredentials();
    }

    if (!user.isActive) {
      await audit.write({
        userId: user.id, action: 'auth.login_failed', entity: 'user', entityId: user.id,
        diff: { login, reason: 'inactive' }, ip: client.ip,
      });
      throw invalidCredentials();
    }

    const reset = registerSuccess();
    await repo.saveLockout(user.id, reset);
    await repo.recordSuccessfulLogin(user.id, at);

    const token = newSessionToken();
    const sessionId = sessionIdFromToken(token);
    await repo.createSession({
      id: sessionId,
      userId: user.id,
      createdAt: at,
      expiresAt: new Date(at.getTime() + SESSION_MAX_AGE_MS),
      ip: client.ip,
      userAgent: client.userAgent,
    });
    await audit.write({ userId: user.id, action: 'auth.login', entity: 'user', entityId: user.id, ip: client.ip });

    return { token, sessionId, user: await toAuthUser(user) };
  }

  /** Проверяет токен из cookie. Неактивную или истёкшую сессию закрывает. */
  async function resolveSession(token: string, client: ClientInfo) {
    const sessionId = sessionIdFromToken(token);
    const session = await repo.findSession(sessionId);
    if (!session || session.revokedAt) return null;

    const at = now();
    const idle = at.getTime() - session.lastSeenAt.getTime() > SESSION_IDLE_MS;
    const expired = at.getTime() >= session.expiresAt.getTime();
    if (idle || expired) {
      await repo.revokeSession(sessionId, at);
      await audit.write({
        userId: session.userId, action: 'auth.session_expired', entity: 'session', entityId: sessionId.slice(0, 12),
        diff: { reason: idle ? 'idle' : 'max_age' }, ip: client.ip,
      });
      return null;
    }

    const user = await repo.findUserById(session.userId);
    if (!user || !user.isActive) {
      await repo.revokeSession(sessionId, at);
      return null;
    }

    if (at.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      await repo.touchSession(sessionId, at);
    }
    return { sessionId, user: await toAuthUser(user) };
  }

  async function logout(sessionId: string, userId: string, client: ClientInfo) {
    await repo.revokeSession(sessionId, now());
    await audit.write({ userId, action: 'auth.logout', entity: 'user', entityId: userId, ip: client.ip });
  }

  async function changePassword(
    input: { userId: string; sessionId: string; currentPassword: string; newPassword: string },
    client: ClientInfo,
  ) {
    const user = await repo.findUserById(input.userId);
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Войдите в систему');

    if (!(await hasher.verify(user.passwordHash, input.currentPassword))) {
      await audit.write({
        userId: user.id, action: 'auth.password_change_failed', entity: 'user', entityId: user.id,
        diff: { reason: 'wrong_current_password' }, ip: client.ip,
      });
      throw new AppError(400, 'WRONG_CURRENT_PASSWORD', 'Текущий пароль указан неверно');
    }

    const violations = checkPasswordStrength(input.newPassword, user.login);
    if (violations.length > 0) {
      throw new AppError(400, 'PASSWORD_POLICY', violations.map(violationMessage).join('. '), { violations });
    }

    const recent = [user.passwordHash, ...(await repo.getPasswordHistory(user.id, PASSWORD_HISTORY_DEPTH - 1))];
    if (await isRecentlyUsed(input.newPassword, recent, hasher.verify)) {
      throw new AppError(
        400,
        'PASSWORD_REUSED',
        `Пароль совпадает с одним из последних ${PASSWORD_HISTORY_DEPTH}. Придумайте новый`,
      );
    }

    const at = now();
    await repo.changePassword(user.id, await hasher.hash(input.newPassword), user.passwordHash, at);
    await repo.revokeOtherSessions(user.id, input.sessionId, at);
    await audit.write({ userId: user.id, action: 'auth.password_changed', entity: 'user', entityId: user.id, ip: client.ip });

    const updated = await repo.findUserById(user.id);
    return toAuthUser(updated ?? { ...user, mustChangePassword: false, passwordChangedAt: at });
  }

  return { login, resolveSession, logout, changePassword };
}

export type AuthService = ReturnType<typeof createAuthService>;
