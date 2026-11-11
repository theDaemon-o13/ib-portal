// Общее для модулей настроек: автор изменения, журнал, защита от одновременной правки.
import type { FastifyRequest } from 'fastify';
import type { Prisma } from '../../generated/prisma/client.js';
import { createManyChunked } from '../../lib/bulk.js';
import type { Db } from '../../lib/db.js';
import { notFound, unauthorized, versionConflict } from '../../lib/errors.js';

export interface Actor {
  id: string;
  roleNames: readonly string[];
  ip: string | null;
  /** Текущая сессия (хэш токена): при снятии ролей и прав не закрывается у того, кто их снял (1.10.0). */
  sessionId?: string | null;
}

export function actorOf(request: FastifyRequest): Actor {
  if (!request.user) throw unauthorized();
  return { id: request.user.id, roleNames: request.user.roleNames, ip: request.ip ?? null, sessionId: request.sessionId };
}

/** Действия, которые показывает журнал изменений настроек. */
export const SETTINGS_ACTION_PREFIXES = ['catalog.', 'calendar.', 'form_template.', 'user.', 'role.', 'portal_param.', 'party_directory.'] as const;

/** Колонок в строке журнала: user_id, action, entity, entity_id, diff, ip. */
const AUDIT_COLUMNS = 6;

export interface SettingsAuditEntry {
  action: string;
  entity: string;
  entityId: string;
  /** Готовая фраза для журнала: не меняется, даже если объект потом переименуют. */
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Запись в журнал аудита в той же транзакции, что и изменение. Пароли сюда не передаются. */
export async function auditSettings(tx: Db, actor: Actor, e: SettingsAuditEntry): Promise<void> {
  await tx.auditLog.create({ data: auditRow(actor, e) });
}

function auditRow(actor: Actor, e: SettingsAuditEntry): Prisma.AuditLogCreateManyInput {
  const diff: Record<string, unknown> = { summary: e.summary, actorRoles: [...actor.roleNames] };
  if (e.before) diff.before = e.before;
  if (e.after) diff.after = e.after;
  return { userId: actor.id, action: e.action, entity: e.entity, entityId: e.entityId, diff: diff as Prisma.InputJsonValue, ip: actor.ip };
}

/**
 * Те же строки журнала, что у auditSettings, в том же порядке — пачками (1.13.9): массовые операции пишут строку
 * на каждую запись, и число запросов растёт с числом пачек, а не записей.
 */
export async function auditSettingsMany(tx: Db, actor: Actor, entries: readonly SettingsAuditEntry[]): Promise<void> {
  await createManyChunked(entries.map((e) => auditRow(actor, e)), AUDIT_COLUMNS, (data) => tx.auditLog.createMany({ data }));
}

/**
 * Проверка результата updateMany({ where: { id, version } }): 0 строк — запись удалена
 * или изменена другим пользователем.
 */
export async function ensureVersioned(count: number, exists: () => Promise<unknown>, what: string): Promise<void> {
  if (count > 0) return;
  if (await exists()) throw versionConflict();
  throw notFound(what);
}

export const trimmed = (s: string) => s.trim().replace(/\s+/g, ' ');
