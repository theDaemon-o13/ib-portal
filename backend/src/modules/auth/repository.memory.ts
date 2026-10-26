// Хранилище в памяти: для тестов и экспорта OpenAPI. В продукте не используется.
import type { PermissionCode } from '../../lib/permissions.js';
import type { AuthRepository, NewSession, SessionRecord, UserRecord } from './repository.js';

export class MemoryAuthRepository implements AuthRepository {
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly permissions = new Map<string, PermissionCode[]>();
  readonly history = new Map<string, string[]>();
  healthy = true;

  addUser(user: Partial<UserRecord> & Pick<UserRecord, 'id' | 'login' | 'passwordHash'>, perms: PermissionCode[] = []) {
    this.users.set(user.id, {
      fullName: user.login,
      mustChangePassword: false,
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
  async getPermissions(userId: string) {
    return this.permissions.get(userId) ?? [];
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
    for (const s of this.sessions.values()) {
      if (s.userId === userId && s.id !== keep && !s.revokedAt) s.revokedAt = at;
    }
  }
  async getPasswordHistory(userId: string, limit: number) {
    return (this.history.get(userId) ?? []).slice(0, limit);
  }
  async changePassword(userId: string, newHash: string, previousHash: string) {
    const u = this.users.get(userId);
    if (!u) return;
    this.history.set(userId, [previousHash, ...(this.history.get(userId) ?? [])]);
    u.passwordHash = newHash;
    u.mustChangePassword = false;
  }
  async ping() {
    return this.healthy;
  }
}
