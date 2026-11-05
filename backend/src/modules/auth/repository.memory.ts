// Хранилище в памяти: для тестов и экспорта OpenAPI. В продукте не используется.
import { randomUUID } from 'node:crypto';
import type { PermissionCode } from '../../lib/permissions.js';
import { DEFAULT_SESSION_SETTINGS, type SessionSettings } from '../../lib/session-token.js';
import type { AuthRepository, NewSession, SessionInfo, UserRecord } from './repository.js';

export class MemoryAuthRepository implements AuthRepository {
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionInfo>();
  readonly permissions = new Map<string, PermissionCode[]>();
  readonly roleNames = new Map<string, string[]>();
  readonly history = new Map<string, string[]>();
  /** Роли пользователя по коду (служебная роль «Администратор портала» — portal_admin). */
  readonly roleCodes = new Map<string, string[]>();
  sessionSettings: SessionSettings = { ...DEFAULT_SESSION_SETTINGS };
  healthy = true;

  addUser(user: Partial<UserRecord> & Pick<UserRecord, 'id' | 'login' | 'passwordHash'>, perms: PermissionCode[] = []) {
    this.users.set(user.id, {
      fullName: user.login,
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
      isActive: true,
      ...user,
    });
    this.permissions.set(user.id, perms);
  }

  async findUserByLogin(login: string) {
    return [...this.users.values()].find((u) => u.login === login) ?? null;
  }
  async findUserById(id: string) {
    return this.users.get(id) ?? null;
  }
  async getAccess(userId: string) {
    return { permissions: this.permissions.get(userId) ?? [], roleNames: this.roleNames.get(userId) ?? [], roleCodes: this.roleCodes.get(userId) ?? [] };
  }
  async saveLockout(userId: string, state: { failedLoginCount: number; lockedUntil: Date | null }) {
    const u = this.users.get(userId);
    if (u) Object.assign(u, state);
  }
  async recordSuccessfulLogin(userId: string) {
    const u = this.users.get(userId);
    if (u) Object.assign(u, { failedLoginCount: 0, lockedUntil: null });
  }
  async createSession(s: NewSession) {
    this.sessions.set(s.id, {
      id: s.id,
      userId: s.userId,
      createdAt: s.createdAt,
      lastSeenAt: s.createdAt,
      expiresAt: s.expiresAt,
      revokedAt: null,
      remember: s.remember,
      publicId: randomUUID(),
      ip: s.ip,
      userAgent: s.userAgent,
    });
  }
  async findSession(id: string) {
    return this.sessions.get(id) ?? null;
  }
  async touchSession(id: string, at: Date) {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = at;
  }
  async revokeSession(id: string, at: Date) {
    const s = this.sessions.get(id);
    if (s && !s.revokedAt) s.revokedAt = at;
  }
  async revokeOtherSessions(userId: string, keep: string | null, at: Date) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.userId === userId && s.id !== keep && !s.revokedAt) {
        s.revokedAt = at;
        n++;
      }
    }
    return n;
  }
  async listOpenSessions(userId: string) {
    return [...this.sessions.values()].filter((s) => s.userId === userId && !s.revokedAt)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  }
  async revokeSessionByPublicId(userId: string, publicId: string, at: Date) {
    const s = [...this.sessions.values()].find((x) => x.userId === userId && x.publicId === publicId && !x.revokedAt);
    if (!s) return false;
    s.revokedAt = at;
    return true;
  }
  async getSessionSettings() {
    return { ...this.sessionSettings };
  }
  async getPasswordHistory(userId: string, limit: number) {
    return (this.history.get(userId) ?? []).slice(0, limit);
  }
  async changePassword(userId: string, newHash: string, previousHash: string, at: Date) {
    const u = this.users.get(userId);
    if (!u) return;
    this.history.set(userId, [previousHash, ...(this.history.get(userId) ?? [])]);
    u.passwordHash = newHash;
    u.mustChangePassword = false;
    u.passwordChangedAt = at;
  }
  async ping() {
    return this.healthy;
  }
}
