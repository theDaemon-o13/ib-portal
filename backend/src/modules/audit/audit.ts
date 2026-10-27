import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';

export interface AuditEntry {
  userId: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  diff?: Record<string, unknown>;
  ip?: string | null;
}

/** Журнал аудита только пополняется: у писателя нет методов правки и удаления. */
export interface AuditWriter {
  write(entry: AuditEntry): Promise<void>;
}

export function prismaAuditWriter(prisma: Db): AuditWriter {
  return {
    async write(entry) {
      await prisma.auditLog.create({
        data: {
          userId: entry.userId,
          action: entry.action,
          entity: entry.entity ?? null,
          entityId: entry.entityId ?? null,
          diff: (entry.diff ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: entry.ip ?? null,
        },
      });
    },
  };
}

export class MemoryAuditWriter implements AuditWriter {
  readonly entries: (AuditEntry & { at: Date })[] = [];
  async write(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry, at: new Date() });
  }
  actions(): string[] {
    return this.entries.map((e) => e.action);
  }
}
