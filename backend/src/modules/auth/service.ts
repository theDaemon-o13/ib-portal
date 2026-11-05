import { AppError } from '../../lib/errors.js';
import { isLocked, registerFailure, registerSuccess } from '../../lib/lockout.js';
import {
  PASSWORD_HISTORY_DEPTH,
  checkPasswordStrength,
  isPasswordExpired,
  isRecentlyUsed,
  violationMessage,
} from '../../lib/password-policy.js';
import type { IpList } from '../../lib/ip-list.js';
import type { PasswordHasher } from '../../lib/passwords.js';
import { ADMIN_PERMISSIONS, KIOSK_PERMISSION, type PermissionCode } from '../../lib/permissions.js';
import { hasServiceRole } from '../../lib/work-users.js';

/** Права служебной роли «Администратор портала» (ADR-0036). */
const SERVICE_PERMISSIONS: readonly PermissionCode[] = ['settings.manage', 'users.manage'];
import {
  FAR_FUTURE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  newSessionToken,
  sessionDeadline,
  sessionIdFromToken,
  type SessionSettings,
} from '../../lib/session-token.js';
import type { AuthUser } from '../../types.js';
import type { AuditWriter } from '../audit/audit.js';
import type { AuthRepository, SessionInfo, SessionRecord, UserRecord } from './repository.js';

/**
 * Сессии администратора (1.10.0, решение владельца 05.11.2026): у держателей users.manage и служебной роли
 * «Администратор портала» — без «Запомнить меня», общий срок adminMaxHours (по умолчанию 12 часов).
 */
export const isSessionAdmin = (u: AuthUser) => u.service || u.permissions.has('users.manage');

/** Сессия в «Моих сессиях» и карточке пользователя: id — public_id, хэш токена наружу не отдаётся. */
export interface SessionView {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  remember: boolean;
  /** До какого времени живёт сессия; null — бессрочно. */
  expiresAt: string | null;
}

/** Срок сессии: из параметров (от входа) и, у сессий до 1.10.0, — их собственный expires_at. */
function deadlineOf(s: SessionRecord, admin: boolean, settings: SessionSettings): Date | null {
  const byRules = sessionDeadline(s.createdAt, admin, settings);
  const own = s.expiresAt.getTime() < s.createdAt.getTime() + FAR_FUTURE_MS / 2 ? s.expiresAt : null;
  if (!byRules) return own;
  if (!own) return byRules;
  return byRules.getTime() < own.getTime() ? byRules : own;
}

export interface AuthServiceDeps {
  repo: AuthRepository;
  audit: AuditWriter;
  hasher: PasswordHasher;
  now?: () => Date;
  /** Адреса настенных мониторов (MONITOR_ALLOWED_IPS). Не задано или пусто — вход киоска запрещён. */
  kioskAllowedIps?: IpList;
  /** Адреса рабочих мест администраторов (ADMIN_ALLOWED_IPS). Не задано или пусто — без ограничения (ADR-0015). */
  adminAllowedIps?: IpList;
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

export function createAuthService({ repo, audit, hasher, now = () => new Date(), kioskAllowedIps, adminAllowedIps }: AuthServiceDeps) {
  const kioskIpAllowed = (ip: string | null) => kioskAllowedIps?.has(ip) ?? false;
  const isAdmin = (u: AuthUser) => ADMIN_PERMISSIONS.some((p) => u.permissions.has(p));
  const adminIpAllowed = (ip: string | null) => !adminAllowedIps || adminAllowedIps.empty || adminAllowedIps.has(ip);

  // Хэш-заглушка: на несуществующий логин тратим столько же времени, сколько на настоящий.
  let dummyHash: Promise<string> | null = null;
  const getDummyHash = () => (dummyHash ??= hasher.hash('dummy-password-for-timing'));

  async function toAuthUser(user: UserRecord): Promise<AuthUser> {
    const access = await repo.getAccess(user.id);
    const service = hasServiceRole(access.roleCodes ?? []);
    const passwordExpired = isPasswordExpired(user.passwordChangedAt, now());
    return {
      id: user.id,
      login: user.login,
      fullName: user.fullName,
      mustChangePassword: user.mustChangePassword || passwordExpired,
      passwordExpired,
      // Служебная учётная запись (ADR-0036): только права настройки, даже если состав ролей нарушен.
      permissions: new Set(service ? access.permissions.filter((p) => SERVICE_PERMISSIONS.includes(p)) : access.permissions),
      roleNames: access.roleNames,
      kiosk: access.permissions.includes(KIOSK_PERMISSION),
      service,
    };
  }

  /** remember — галочка «Запомнить меня»; у администраторов не действует (isSessionAdmin). */
  async function login(input: { login: string; password: string; remember?: boolean }, client: ClientInfo) {
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

    // Настенный монитор входит только с разрешённых адресов. Ответ — как на неверный пароль,
    // счётчик неудачных попыток не растёт: пароль верный, и учётную запись это не блокирует.
    const authUser = await toAuthUser(user);
    if (authUser.kiosk && !kioskIpAllowed(client.ip)) {
      await audit.write({
        userId: user.id, action: 'auth.login_failed', entity: 'user', entityId: user.id,
        diff: { login, reason: 'kiosk_ip_denied' }, ip: client.ip,
      });
      throw invalidCredentials();
    }
    // Администратор (settings.manage, users.manage) — только с рабочих мест из ADMIN_ALLOWED_IPS. Ответ тот же,
    // что на неверный пароль: иначе с любого ПК можно проверять, верен ли пароль администратора (ADR-0015).
    if (isAdmin(authUser) && !adminIpAllowed(client.ip)) {
      await audit.write({
        userId: user.id, action: 'auth.login_failed', entity: 'user', entityId: user.id,
        diff: { login, reason: 'admin_ip_denied' }, ip: client.ip,
      });
      throw invalidCredentials();
    }

    const reset = registerSuccess();
    await repo.saveLockout(user.id, reset);
    await repo.recordSuccessfulLogin(user.id, at);

    const admin = isSessionAdmin(authUser);
    const remember = input.remember === true && !admin;
    const settings = await repo.getSessionSettings();
    const token = newSessionToken();
    const sessionId = sessionIdFromToken(token);
    await repo.createSession({
      id: sessionId,
      userId: user.id,
      createdAt: at,
      expiresAt: new Date(at.getTime() + FAR_FUTURE_MS),
      ip: client.ip,
      userAgent: client.userAgent,
      remember,
    });
    await audit.write({ userId: user.id, action: 'auth.login', entity: 'user', entityId: user.id, diff: { remember }, ip: client.ip });

    const deadline = sessionDeadline(at, admin, settings);
    return { token, sessionId, user: authUser, remember, admin, adminMaxHours: admin ? settings.adminMaxHours : null, expiresAt: deadline };
  }

  /**
   * Проверяет токен из cookie. Истёкшую по сроку сессию закрывает; по бездействию сессия не завершается (1.10.0).
   * background — фоновый запрос страницы (опрос по таймеру, X-Background: 1): «последнюю активность» не обновляет —
   * в «Моих сессиях» это время действий человека. Монитор обновляется всегда (его страница — только фоновая).
   * refreshCookie — активность обновлена у сессии «Запомнить меня»: cookie выдаётся заново, Max-Age — от этого запроса.
   */
  async function resolveSession(token: string, client: ClientInfo, opts: { background?: boolean } = {}) {
    const sessionId = sessionIdFromToken(token);
    const session = await repo.findSession(sessionId);
    if (!session || session.revokedAt) return null;

    const at = now();
    const expire = async (reason: 'max_age' | 'admin_max_age') => {
      await repo.revokeSession(sessionId, at);
      await audit.write({
        userId: session.userId, action: 'auth.session_expired', entity: 'session', entityId: sessionId.slice(0, 12),
        diff: { reason }, ip: client.ip,
      });
      return null;
    };
    // Сессия до 1.10.0: свой срок (вход + 12 часов).
    if (at.getTime() >= session.expiresAt.getTime()) return expire('max_age');

    const user = await repo.findUserById(session.userId);
    if (!user || !user.isActive) {
      await repo.revokeSession(sessionId, at);
      return null;
    }
    const authUser = await toAuthUser(user);
    // Срок — по текущим правам: выданное посреди сессии право администратора сразу ограничивает её срок.
    const admin = isSessionAdmin(authUser);
    const deadline = sessionDeadline(session.createdAt, admin, await repo.getSessionSettings());
    if (deadline && at.getTime() >= deadline.getTime()) return expire(admin ? 'admin_max_age' : 'max_age');
    // Монитор работает только с разрешённого адреса: перенесённая на другой ПК сессия закрывается.
    if (authUser.kiosk && !kioskIpAllowed(client.ip)) {
      await repo.revokeSession(sessionId, at);
      await audit.write({
        userId: session.userId, action: 'auth.kiosk_ip_denied', entity: 'session', entityId: sessionId.slice(0, 12),
        diff: { reason: 'ip_not_allowed' }, ip: client.ip,
      });
      return null;
    }
    // Права читаются на каждом запросе: выданная уже вошедшему пользователю роль администратора с чужого адреса
    // не открывает администрирование — сессия закрывается.
    // ADR-0015: settings.manage и users.manage — шире, чем «администратор» для срока сессии (без settings.manage).
    if (isAdmin(authUser) && !adminIpAllowed(client.ip)) {
      await repo.revokeSession(sessionId, at);
      await audit.write({
        userId: session.userId, action: 'auth.admin_ip_denied', entity: 'session', entityId: sessionId.slice(0, 12),
        diff: { reason: 'ip_not_allowed' }, ip: client.ip,
      });
      return null;
    }

    let touched = false;
    if ((authUser.kiosk || !opts.background) && at.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      await repo.touchSession(sessionId, at);
      touched = true;
    }
    // Администратор после выдачи права посреди сессии: постоянную cookie больше не продлеваем.
    const remember = session.remember && !admin;
    return { sessionId, user: authUser, remember, refreshCookie: touched && remember };
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
    const closed = await repo.revokeOtherSessions(user.id, input.sessionId, at);
    await audit.write({ userId: user.id, action: 'auth.password_changed', entity: 'user', entityId: user.id, diff: { sessionsClosed: closed }, ip: client.ip });

    const updated = await repo.findUserById(user.id);
    return toAuthUser(updated ?? { ...user, mustChangePassword: false, passwordChangedAt: at });
  }

  // ---------------------------------------------------------------- «Мои сессии» и сессии пользователя (1.10.0)

  /** Открытые и не истёкшие сессии пользователя; истёкшие, но ещё не закрытые, не показываются (закроются при обращении). */
  async function openSessionsOf(user: UserRecord, currentSessionId: string | null): Promise<SessionView[]> {
    const admin = isSessionAdmin(await toAuthUser(user));
    const settings = await repo.getSessionSettings();
    const at = now().getTime();
    const out: SessionView[] = [];
    for (const s of await repo.listOpenSessions(user.id)) {
      const deadline = deadlineOf(s, admin, settings);
      if (deadline && deadline.getTime() <= at) continue;
      out.push(viewOf(s, s.id === currentSessionId, admin, deadline));
    }
    return out;
  }
  const viewOf = (s: SessionInfo, current: boolean, admin: boolean, deadline: Date | null): SessionView => ({
    id: s.publicId, current, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(),
    ip: s.ip, userAgent: s.userAgent, remember: s.remember && !admin, expiresAt: deadline?.toISOString() ?? null,
  });

  async function userOrNotFound(userId: string): Promise<UserRecord> {
    const user = await repo.findUserById(userId);
    if (!user) throw new AppError(404, 'NOT_FOUND', 'Пользователь не найден');
    return user;
  }

  /** «Мои сессии»: текущая отмечена. */
  async function mySessions(userId: string, currentSessionId: string) {
    const user = await userOrNotFound(userId);
    const settings = await repo.getSessionSettings();
    const admin = isSessionAdmin(await toAuthUser(user));
    return { items: await openSessionsOf(user, currentSessionId), admin, adminMaxHours: settings.adminMaxHours, maxDays: settings.maxDays };
  }

  /** Завершить свою сессию (не текущую: для неё — «Выйти»). Чужая или закрытая — 404. */
  async function revokeMySession(userId: string, currentSessionId: string, publicId: string, client: ClientInfo) {
    const open = await repo.listOpenSessions(userId);
    const target = open.find((s) => s.publicId === publicId);
    if (!target) throw new AppError(404, 'NOT_FOUND', 'Сессия не найдена или уже завершена');
    if (target.id === currentSessionId) throw new AppError(409, 'CURRENT_SESSION', 'Это текущая сессия: чтобы её завершить, нажмите «Выйти»');
    await repo.revokeSessionByPublicId(userId, publicId, now());
    await audit.write({
      userId, action: 'auth.session_revoked', entity: 'session', entityId: publicId,
      diff: { summary: 'Своя сессия завершена', userAgent: target.userAgent, ip: target.ip }, ip: client.ip,
    });
  }

  /** «Завершить все, кроме текущей». */
  async function revokeMyOtherSessions(userId: string, currentSessionId: string, client: ClientInfo) {
    const closed = await repo.revokeOtherSessions(userId, currentSessionId, now());
    await audit.write({
      userId, action: 'auth.sessions_revoked_others', entity: 'user', entityId: userId,
      diff: { summary: `Завершены остальные сессии: ${closed}`, count: closed }, ip: client.ip,
    });
    return { revoked: closed };
  }

  /** Сессии другого пользователя (users.manage проверяет маршрут). */
  async function userSessions(userId: string) {
    const user = await userOrNotFound(userId);
    return { items: await openSessionsOf(user, null) };
  }

  /** Администратор завершает одну сессию пользователя или все (publicId = null). */
  async function revokeUserSessions(actor: { id: string; sessionId: string | null }, userId: string, publicId: string | null, client: ClientInfo) {
    const user = await userOrNotFound(userId);
    const at = now();
    let closed: number;
    if (publicId) {
      if (!(await repo.revokeSessionByPublicId(userId, publicId, at))) throw new AppError(404, 'NOT_FOUND', 'Сессия не найдена или уже завершена');
      closed = 1;
    } else {
      // Свою текущую сессию администратор этим не закрывает: для неё — «Выйти».
      closed = await repo.revokeOtherSessions(userId, userId === actor.id ? actor.sessionId : null, at);
    }
    await audit.write({
      userId: actor.id, action: 'user.sessions_revoked', entity: 'user', entityId: userId,
      diff: {
        summary: `Пользователи: ${user.fullName} (${user.login}) — завершено сессий: ${closed}`,
        count: closed, ...(publicId ? { sessionId: publicId } : { all: true }),
      },
      ip: client.ip,
    });
    return { revoked: closed };
  }

  return {
    login, resolveSession, logout, changePassword,
    mySessions, revokeMySession, revokeMyOtherSessions, userSessions, revokeUserSessions,
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
