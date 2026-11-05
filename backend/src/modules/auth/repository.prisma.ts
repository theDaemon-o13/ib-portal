import { withTx, type Db } from '../../lib/db.js';
import { collectPermissions } from '../../lib/permissions.js';
import { SESSION_SETTINGS_KEY, parseSessionSettings } from '../../lib/session-token.js';
import type { AuthRepository, UserRecord } from './repository.js';

const userSelect = {
  id: true,
  login: true,
  fullName: true,
  passwordHash: true,
  mustChangePassword: true,
  passwordChangedAt: true,
  failedLoginCount: true,
  lockedUntil: true,
  isActive: true,
} as const;

export function prismaAuthRepository(prisma: Db): AuthRepository {
  return {
    findUserByLogin: (login): Promise<UserRecord | null> =>
      prisma.user.findUnique({ where: { login }, select: userSelect }),

    findUserById: (id): Promise<UserRecord | null> =>
      prisma.user.findUnique({ where: { id }, select: userSelect }),

    async getAccess(userId) {
      const links = await prisma.userRole.findMany({
        where: { userId },
        select: { role: { select: { name: true, code: true, permissions: { select: { permissionCode: true } } } } },
        orderBy: { role: { name: 'asc' } },
      });
      return {
        permissions: collectPermissions(links.map((l) => ({ permissions: l.role.permissions.map((p) => p.permissionCode) }))),
        roleNames: links.map((l) => l.role.name),
        roleCodes: links.map((l) => l.role.code),
      };
    },

    async saveLockout(userId, state) {
      await prisma.user.update({ where: { id: userId }, data: state });
    },

    async recordSuccessfulLogin(userId, at) {
      await prisma.user.update({
        where: { id: userId },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: at },
      });
    },

    async createSession(s) {
      await prisma.session.create({
        data: {
          id: s.id,
          userId: s.userId,
          createdAt: s.createdAt,
          lastSeenAt: s.createdAt,
          expiresAt: s.expiresAt,
          ip: s.ip,
          userAgent: s.userAgent,
          remember: s.remember,
        },
      });
    },

    findSession: (id) =>
      prisma.session.findUnique({
        where: { id },
        select: { id: true, userId: true, createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true, remember: true },
      }),

    async touchSession(id, at) {
      await prisma.session.update({ where: { id }, data: { lastSeenAt: at } });
    },

    async revokeSession(id, at) {
      await prisma.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } });
    },

    async revokeOtherSessions(userId, keepSessionId, at) {
      const res = await prisma.session.updateMany({
        where: { userId, revokedAt: null, ...(keepSessionId ? { NOT: { id: keepSessionId } } : {}) },
        data: { revokedAt: at },
      });
      return res.count;
    },

    listOpenSessions: (userId) =>
      prisma.session.findMany({
        where: { userId, revokedAt: null },
        select: {
          id: true, publicId: true, userId: true, createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true,
          remember: true, ip: true, userAgent: true,
        },
        orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
      }),

    async revokeSessionByPublicId(userId, publicId, at) {
      const res = await prisma.session.updateMany({ where: { userId, publicId, revokedAt: null }, data: { revokedAt: at } });
      return res.count > 0;
    },

    async getSessionSettings() {
      const row = await prisma.appSetting.findUnique({ where: { key: SESSION_SETTINGS_KEY }, select: { value: true } });
      return parseSessionSettings(row?.value);
    },

    async getPasswordHistory(userId, limit) {
      const rows = await prisma.passwordHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { passwordHash: true },
      });
      return rows.map((r) => r.passwordHash);
    },

    async changePassword(userId, newHash, previousHash, at) {
      await withTx(prisma, async (tx) => {
        await tx.passwordHistory.create({ data: { userId, passwordHash: previousHash, createdAt: at } });
        await tx.user.update({
          where: { id: userId },
          data: { passwordHash: newHash, mustChangePassword: false, passwordChangedAt: at, version: { increment: 1 } },
        });
      });
    },

    async ping() {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
  };
}
