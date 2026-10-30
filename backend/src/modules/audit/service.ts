// Раздел «Журнал» (релиз 1.2.0, ADR-0021): все действия пользователей из audit_log по праву audit.view.
// Журнал только читается — записи не меняются (CLAUDE.md, раздел 3.5). Меняется лишь то, кто его видит.
import ExcelJS from 'exceljs';
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { conflict } from '../../lib/errors.js';
import { appTimeZone, todayIso } from '../../lib/today.js';
import type { Actor } from '../settings/common.js';
import { actionLabel, entityLabel, SETTINGS_ENTITIES } from './labels.js';

export interface AuditFilter {
  /** ISO 8601, включительно. */
  from?: string;
  /** ISO 8601, не включительно. */
  to?: string;
  /** id пользователя или 'system' — действия без пользователя (автоматизации, seed). */
  userId?: string;
  action?: string;
  /** Раздел: один или несколько entity через запятую («user,role,catalog_item»). */
  entity?: string;
  /** Адрес или его начало: «10.0.5.» */
  ip?: string;
  q?: string;
  /**
   * Скрыть записи самооценки (сущности assessment*): их видят только держатели assessment.manage (ADR-0026).
   * Ставит маршрут по правам того, кто смотрит, — не пользователь.
   */
  hideAssessment?: boolean;
}

/** Сущности самооценки в журнале: assessment, assessment_methodology… */
export const ASSESSMENT_ENTITY_PREFIX = 'assessment';
const assessmentHidden = Prisma.sql`(a.entity IS NULL OR a.entity NOT LIKE ${`${ASSESSMENT_ENTITY_PREFIX}%`})`;

/** Больше — выгрузка не делается: пользователь сужает период (решение владельца, без молчаливой обрезки). */
export const EXPORT_LIMIT = 100_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function whereSql(f: AuditFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (f.hideAssessment) parts.push(assessmentHidden);
  if (f.from) parts.push(Prisma.sql`a.at >= ${new Date(f.from)}`);
  if (f.to) parts.push(Prisma.sql`a.at < ${new Date(f.to)}`);
  if (f.userId === 'system') parts.push(Prisma.sql`a.user_id IS NULL`);
  else if (f.userId) parts.push(Prisma.sql`a.user_id = ${f.userId}::uuid`);
  if (f.action) parts.push(Prisma.sql`a.action = ${f.action}`);
  const entities = (f.entity ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  if (entities.length) parts.push(Prisma.sql`a.entity IN (${Prisma.join(entities)})`);
  if (f.ip) parts.push(Prisma.sql`a.ip LIKE ${`${f.ip.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`);
  const q = f.q?.trim();
  if (q) {
    const p = like(q);
    parts.push(Prisma.sql`(a.diff->>'summary' ILIKE ${p} OR u.login ILIKE ${p} OR u.full_name ILIKE ${p}
      OR a.action ILIKE ${p} OR a.entity_id = ${q})`);
  }
  return Prisma.join(parts, ' AND ');
}

interface Row {
  id: string;
  at: Date;
  user_id: string | null;
  login: string | null;
  full_name: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  diff: unknown;
  ip: string | null;
}

async function selectRows(db: Db, f: AuditFilter, opts: { before?: bigint; take: number }): Promise<Row[]> {
  return db.$queryRaw<Row[]>`
    SELECT a.id::text AS id, a.at, a.user_id::text AS user_id, u.login, u.full_name, a.action, a.entity, a.entity_id, a.diff, a.ip
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE ${whereSql(f)} ${opts.before !== undefined ? Prisma.sql`AND a.id < ${opts.before}` : Prisma.empty}
    ORDER BY a.id DESC
    LIMIT ${opts.take}`;
}

/** Защита в глубину: ключи с паролями, хешами и токенами не выдаются, даже если когда-нибудь попадут в журнал. */
const SECRET_KEY = /pass(word)?|hash|token|secret/i;

export function sanitizeDiff(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDiff);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = sanitizeDiff(v);
    }
    return out;
  }
  return value;
}

interface Link { href: string | null; deleted: boolean }

/** Ссылки на объекты записей: одна выборка на вид объекта. Удалённый объект — без ссылки, с пометкой. */
async function resolveLinks(db: Db, rows: readonly { entity: string | null; entity_id: string | null }[]): Promise<Map<string, Link>> {
  const ids = (entity: string) => [...new Set(rows.filter((r) => r.entity === entity && r.entity_id && UUID_RE.test(r.entity_id)).map((r) => r.entity_id as string))];
  const out = new Map<string, Link>();
  const put = (entity: string, id: string, href: string | null, deleted = false) => out.set(`${entity}:${id}`, { href: deleted ? null : href, deleted });
  const reg = (registerId: string, tab: string) => `/registers#${registerId}/${tab}`;

  const tasks = ids('task');
  if (tasks.length) for (const t of await db.task.findMany({ where: { id: { in: tasks } }, select: { id: true, deletedAt: true } })) {
    put('task', t.id, `/tasks?task=${t.id}`, t.deletedAt !== null);
  }
  const records = ids('register_record');
  if (records.length) for (const r of await db.registerRecord.findMany({ where: { id: { in: records } }, select: { id: true, registerId: true, deletedAt: true } })) {
    put('register_record', r.id, `/registers?record=${r.id}#${r.registerId}/records`, r.deletedAt !== null);
  }
  const docs = ids('document');
  if (docs.length) for (const d of await db.document.findMany({ where: { id: { in: docs } }, select: { id: true } })) {
    put('document', d.id, `/documents?doc=${d.id}`);
  }
  const ev = ids('evidence');
  if (ev.length) for (const e of await db.evidence.findMany({ where: { id: { in: ev } }, select: { id: true, deletedAt: true } })) {
    put('evidence', e.id, `/evidence?ev=${e.id}`, e.deletedAt !== null);
  }
  const regs = ids('register');
  if (regs.length) for (const r of await db.register.findMany({ where: { id: { in: regs } }, select: { id: true } })) put('register', r.id, reg(r.id, 'records'));
  const fields = ids('register_field');
  if (fields.length) for (const f of await db.registerField.findMany({ where: { id: { in: fields } }, select: { id: true, registerId: true, deletedAt: true } })) {
    put('register_field', f.id, reg(f.registerId, 'fields'), f.deletedAt !== null);
  }
  const options = ids('register_option');
  if (options.length) for (const o of await db.registerFieldOption.findMany({ where: { id: { in: options } }, select: { id: true, deletedAt: true, field: { select: { registerId: true } } } })) {
    put('register_option', o.id, reg(o.field.registerId, 'fields'), o.deletedAt !== null);
  }
  const autos = ids('register_automation');
  if (autos.length) for (const a of await db.registerAutomation.findMany({ where: { id: { in: autos } }, select: { id: true, registerId: true, deletedAt: true } })) {
    put('register_automation', a.id, reg(a.registerId, 'automation'), a.deletedAt !== null);
  }
  const imports = ids('register_import');
  if (imports.length) for (const i of await db.registerImport.findMany({ where: { id: { in: imports } }, select: { id: true, registerId: true } })) {
    put('register_import', i.id, reg(i.registerId, 'records'));
  }
  const scans = ids('scan_report');
  if (scans.length) for (const s of await db.scanReport.findMany({ where: { id: { in: scans } }, select: { id: true, registerId: true } })) {
    put('scan_report', s.id, reg(s.registerId, 'records'));
  }
  const items = ids('catalog_item');
  if (items.length) for (const c of await db.catalogItem.findMany({ where: { id: { in: items } }, select: { id: true, catalogCode: true, deletedAt: true } })) {
    put('catalog_item', c.id, `/settings/catalogs?c=${c.catalogCode}`, c.deletedAt !== null);
  }
  return out;
}

/** Разделы без отдельной карточки объекта: ссылка на страницу раздела. */
const SECTION_HREF: Record<string, string> = {
  user: '/settings/users',
  role: '/settings/users',
  calendar_day: '/settings/catalogs?c=work_calendar',
  work_week: '/settings/catalogs?c=work_calendar',
  form_template: '/settings/catalogs?c=form_templates',
  form_template_field: '/settings/catalogs?c=form_templates',
  monitor_slide: '/settings/monitor',
  dashboard_tile: '/dashboard',
  dashboard_layout: '/dashboard',
};

function toEntry(r: Row, links: Map<string, Link>) {
  const diff = (r.diff ?? {}) as Record<string, unknown>;
  const link = r.entity && r.entity_id ? links.get(`${r.entity}:${r.entity_id}`) : undefined;
  return {
    id: r.id,
    at: r.at.toISOString(),
    actor: r.user_id ? { id: r.user_id, login: r.login ?? '', fullName: r.full_name ?? '' } : null,
    actorRoles: Array.isArray(diff.actorRoles) ? diff.actorRoles.map(String) : [],
    action: r.action,
    actionLabel: actionLabel(r.action),
    entity: r.entity,
    entityLabel: entityLabel(r.entity),
    entityId: r.entity_id,
    summary: typeof diff.summary === 'string' ? diff.summary : '',
    ip: r.ip,
    href: link ? link.href : (r.entity ? SECTION_HREF[r.entity] ?? null : null),
    objectDeleted: link?.deleted ?? false,
    diff: sanitizeDiff(r.diff ?? null),
  };
}

export async function listAudit(db: Db, f: AuditFilter & { limit: number; cursor?: string }) {
  const before = f.cursor && /^\d+$/.test(f.cursor) ? BigInt(f.cursor) : undefined;
  const rows = await selectRows(db, f, { before, take: f.limit + 1 });
  const page = rows.slice(0, f.limit);
  const links = await resolveLinks(db, page);
  return {
    items: page.map((r) => toEntry(r, links)),
    nextCursor: rows.length > f.limit ? page[page.length - 1]?.id ?? null : null,
  };
}

/** Для фильтров: виды действий, которые есть в журнале, и разделы — с русскими названиями. */
export async function auditFacets(db: Db, opts: { hideAssessment?: boolean } = {}) {
  const hide = opts.hideAssessment ? Prisma.sql`AND ${assessmentHidden}` : Prisma.empty;
  const [actions, entities, users] = await Promise.all([
    db.$queryRaw<{ action: string }[]>`SELECT DISTINCT action FROM audit_log a WHERE TRUE ${hide}`,
    db.$queryRaw<{ entity: string }[]>`SELECT DISTINCT entity FROM audit_log a WHERE entity IS NOT NULL ${hide}`,
    // Пользователи, у которых есть записи (в том числе отключённые): список не зависит от права ib.work.
    db.$queryRaw<{ id: string; login: string; full_name: string; is_active: boolean }[]>`
      SELECT u.id::text, u.login, u.full_name, u.is_active FROM users u
      WHERE EXISTS (SELECT 1 FROM audit_log a WHERE a.user_id = u.id ${hide}) ORDER BY u.full_name, u.login`,
  ]);
  // Разделы с одинаковым названием (например, календарь: дни и рабочая неделя) — один пункт фильтра.
  const sections = new Map<string, string[]>();
  for (const { entity } of entities) {
    const label = entityLabel(entity);
    sections.set(label, [...(sections.get(label) ?? []), entity].sort());
  }
  const present = new Set(entities.map((e) => e.entity));
  const settings = SETTINGS_ENTITIES.filter((e) => present.has(e));
  return {
    users: users.map((u) => ({ id: u.id, login: u.login, fullName: u.full_name, isActive: u.is_active })),
    actions: actions.map((a) => ({ code: a.action, label: actionLabel(a.action) })).sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    entities: [
      ...(settings.length ? [{ code: settings.join(','), label: 'Настройки — всё' }] : []),
      ...[...sections].map(([label, codes]) => ({ code: codes.join(','), label })).sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    ],
  };
}

export async function countAudit(db: Db, f: AuditFilter): Promise<number> {
  const [r] = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${whereSql(f)}`;
  return Number(r?.n ?? 0);
}

/** «29.10.2026 15:43:21» в часовом поясе банка: Excel показывает время так же, как портал. */
function localDateTime(d: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: appTimeZone(), day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(d).replace(',', '');
}

/** Выгрузка в Excel: те же фильтры, что в списке; больше EXPORT_LIMIT строк — отказ с числом. Выгрузка — в журнал. */
export async function exportAudit(
  db: Db, actor: Actor, f: AuditFilter, limit = EXPORT_LIMIT,
): Promise<{ fileName: string; buffer: Buffer }> {
  const total = await countAudit(db, f);
  if (total > limit) {
    throw conflict(
      'TOO_MANY_ROWS',
      `По фильтру ${total.toLocaleString('ru-RU')} записей — выгрузка не больше ${limit.toLocaleString('ru-RU')}. Сузьте период`,
    );
  }
  const rows = await selectRows(db, f, { take: limit });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Журнал');
  ws.columns = [
    { header: 'Когда', key: 'at', width: 20 },
    { header: 'Пользователь', key: 'user', width: 28 },
    { header: 'Логин', key: 'login', width: 18 },
    { header: 'Роли', key: 'roles', width: 26 },
    { header: 'Действие', key: 'action', width: 34 },
    { header: 'Раздел', key: 'entity', width: 24 },
    { header: 'Что сделано', key: 'summary', width: 80 },
    { header: 'IP', key: 'ip', width: 16 },
    { header: 'Код действия', key: 'code', width: 26 },
    { header: 'ID объекта', key: 'entityId', width: 38 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) {
    const diff = (r.diff ?? {}) as Record<string, unknown>;
    ws.addRow({
      at: localDateTime(r.at),
      user: r.user_id ? r.full_name : 'Система',
      login: r.login ?? '',
      roles: Array.isArray(diff.actorRoles) ? diff.actorRoles.map(String).join(', ') : '',
      action: actionLabel(r.action),
      entity: entityLabel(r.entity),
      summary: typeof diff.summary === 'string' ? diff.summary : '',
      ip: r.ip ?? '',
      code: r.action,
      entityId: r.entity_id ?? '',
    });
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  await db.auditLog.create({
    data: {
      userId: actor.id, action: 'audit.exported', entity: 'audit', ip: actor.ip,
      diff: { summary: `Журнал выгружен в Excel: ${rows.length} записей`, actorRoles: [...actor.roleNames], filter: { ...f }, rows: rows.length },
    },
  });
  return { fileName: `Журнал ${todayIso()}.xlsx`, buffer };
}
