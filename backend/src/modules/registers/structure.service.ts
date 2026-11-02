// Структура реестров (право registers.manage): реестры, поля, варианты списков, смена типа поля.
import { Prisma } from '../../generated/prisma/client.js';
import { RECIPIENTS_CATALOG } from '../../lib/catalogs.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import {
  ALLOWED_ROLES,
  displayValue,
  fromText,
  toText,
  isDueRule,
  isScoreRule,
  typeChangeKind,
  type AnalyticsRole,
  type CalcRule,
  type DueDateRule,
  type FieldType,
  type StoredValue,
  type Values,
} from '../../lib/register-values.js';
import { compactSettings, HINT_MAX, LOCK_MODES, TEXT_MAX, TEXT_MAX_MULTILINE, type FieldSettings } from '../../lib/field-settings.js';
import { isBasisRule, type BasisRule } from '../../lib/link-basis.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';
import {
  assertNotArchived,
  calcDependents,
  fieldHasData,
  loadRegister,
  loadUsers,
  optionUsage,
  recomputeSearch,
  userIdsIn,
  type FieldMeta,
  type RegisterDef,
  importKeyDuplicates,
} from './definition.js';

const TYPE_NAMES: Record<FieldType, string> = {
  text: 'Текст', select: 'Список', number: 'Число', date: 'Дата', user: 'Сотрудник', calc: 'Вычисляемое', decision: 'Решение другого отдела',
  catalog: 'Значение справочника', file: 'Файл', link: 'Связь с записью',
};

/** Справочники для поля «Значение справочника»: обычные списки значений (не статусы, правила почты и метки). */
async function assertFieldCatalog(db: Db, code: string | undefined) {
  if (!code) throw badRequest('NO_CATALOG', 'Выберите справочник, из которого берутся значения');
  const c = await db.catalog.findUnique({ where: { code } });
  if (!c || c.kind !== 'values' || code === RECIPIENTS_CATALOG) throw badRequest('NO_CATALOG', 'Этот справочник нельзя выбрать для поля');
  return c;
}

/** Системное поле (реестр уязвимостей): на нём держатся формулы, импорт сканера и автоматизации. */
function assertNotSystemField(field: FieldMeta, what: string) {
  if (field.systemKey) throw conflict('SYSTEM_FIELD', `«${field.label}» — системное поле: его нельзя ${what}. Переименовать можно`);
}

function assertNotSystemOption(option: { label: string; systemKey: string | null }, what: string) {
  if (option.systemKey) throw conflict('SYSTEM_OPTION', `«${option.label}» — системное значение: его нельзя ${what}. Переименовать можно`);
}

// ---------------------------------------------------------------- реестры

export async function listRegisters(db: Db, opts: { includeArchived: boolean }) {
  const rows = await db.register.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    include: { owner: { select: { id: true, fullName: true } } },
    orderBy: { name: 'asc' },
  });
  const fieldCounts = await db.registerField.groupBy({ by: ['registerId'], where: { deletedAt: null, archivedAt: null }, _count: { _all: true } });
  const recordCounts = await db.registerRecord.groupBy({ by: ['registerId'], where: { deletedAt: null, archivedAt: null }, _count: { _all: true } });
  const count = (rows: { registerId: string; _count: { _all: number } }[], id: string) => rows.find((r) => r.registerId === id)?._count._all ?? 0;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    owner: r.owner,
    archived: r.archivedAt !== null,
    version: r.version,
    fieldCount: count(fieldCounts, r.id),
    recordCount: count(recordCounts, r.id),
  }));
}

async function assertRegisterNameFree(db: Db, name: string, exceptId?: string) {
  const clash = await db.register.findFirst({
    where: { archivedAt: null, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (clash) throw conflict('DUPLICATE', `Реестр «${name}» уже есть`);
}

export async function createRegister(db: Db, actor: Actor, input: { name: string; description?: string; ownerUserId?: string | null }) {
  const name = trimmed(input.name);
  if (!name) throw badRequest('EMPTY_NAME', 'Укажите название реестра');
  return withTx(db, async (tx) => {
    await assertRegisterNameFree(tx, name);
    // Как в прототипе: новый реестр сразу с заголовком и статусом.
    const r = await tx.register.create({
      data: {
        name,
        description: trimmed(input.description ?? ''),
        ownerUserId: input.ownerUserId ?? actor.id,
        fields: {
          create: [
            { label: 'Наименование', type: 'text', isTitle: true, sortOrder: 1 },
            {
              label: 'Статус', type: 'select', isStatus: true, analyticsRole: 'dimension', sortOrder: 2,
              options: { create: [{ label: 'Новый', sortOrder: 1 }, { label: 'В работе', sortOrder: 2 }, { label: 'Закрыт', sortOrder: 3, isClosed: true }] },
            },
          ],
        },
      },
    });
    await auditSettings(tx, actor, {
      action: 'register.created', entity: 'register', entityId: r.id,
      summary: `Реестры: создан «${name}»`, after: { name },
    });
    return loadRegister(tx, r.id);
  });
}

/** Типы полей ключа сравнения и поля области (релиз 1.1.0). */
export const COMPARE_KEY_TYPES: readonly FieldType[] = ['text', 'number', 'date', 'select', 'catalog', 'user'];
export const COMPARE_SCOPE_TYPES: readonly FieldType[] = ['select', 'catalog'];

function checkCompareFields(reg: RegisterDef, ids: string[], types: readonly FieldType[], max: number, what: string): string[] {
  const uniq = [...new Set(ids)];
  if (uniq.length > max) throw badRequest('BAD_COMPARE', `${what}: не больше ${max} полей`);
  for (const id of uniq) {
    const f = reg.fields.find((x) => x.id === id);
    if (!f || f.archived) throw badRequest('BAD_COMPARE', `${what}: поле не найдено или в архиве. Обновите страницу`);
    if (!types.includes(f.type)) throw badRequest('BAD_COMPARE', `${what}: поле «${f.label}» (${TYPE_NAMES[f.type]}) не подходит`);
  }
  return uniq;
}

export async function updateRegister(db: Db, actor: Actor, id: string, input: {
  version: number; name?: string; description?: string; ownerUserId?: string | null;
  compareKeyFieldIds?: string[]; compareScopeFieldIds?: string[];
}) {
  return withTx(db, async (tx) => {
    const reg = await loadRegister(tx, id);
    const data: Prisma.RegisterUncheckedUpdateManyInput = {};
    const changes: string[] = [];
    if (input.name !== undefined && trimmed(input.name) !== reg.name) {
      if (!trimmed(input.name)) throw badRequest('EMPTY_NAME', 'Укажите название реестра');
      if (!reg.archived) await assertRegisterNameFree(tx, trimmed(input.name), id);
      data.name = trimmed(input.name);
      changes.push(`переименован в «${data.name}»`);
    }
    if (input.description !== undefined && trimmed(input.description) !== reg.description) {
      data.description = trimmed(input.description);
      changes.push('описание');
    }
    if (input.ownerUserId !== undefined && input.ownerUserId !== reg.ownerUserId) {
      data.ownerUserId = input.ownerUserId;
      changes.push('владелец');
    }
    const label = (ids: string[]) => ids.map((fid) => `«${reg.fields.find((f) => f.id === fid)?.label ?? '?'}»`).join(' + ');
    if (input.compareKeyFieldIds !== undefined) {
      const ids = checkCompareFields(reg, input.compareKeyFieldIds, COMPARE_KEY_TYPES, 3, 'Ключ сравнения');
      if (ids.join() !== reg.compareKeyFieldIds.join()) {
        data.compareKeyFieldIds = ids;
        changes.push(`ключ сравнения: ${ids.length ? label(ids) : 'по ID'}`);
      }
    }
    if (input.compareScopeFieldIds !== undefined) {
      const ids = checkCompareFields(reg, input.compareScopeFieldIds, COMPARE_SCOPE_TYPES, 5, 'Область сравнения');
      if (ids.join() !== reg.compareScopeFieldIds.join()) {
        data.compareScopeFieldIds = ids;
        changes.push(`область сравнения: ${ids.length ? label(ids) : 'только весь реестр'}`);
      }
    }
    if (!changes.length) {
      if (input.version !== reg.version) throw versionConflict();
      return reg;
    }
    const res = await tx.register.updateMany({ where: { id, version: input.version }, data: { ...data, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.register.findUnique({ where: { id } }), 'Реестр');
    await auditSettings(tx, actor, {
      action: 'register.updated', entity: 'register', entityId: id,
      summary: `Реестр «${reg.name}»: ${changes.join(', ')}`,
      before: { name: reg.name, description: reg.description, ownerUserId: reg.ownerUserId, compareKeyFieldIds: reg.compareKeyFieldIds, compareScopeFieldIds: reg.compareScopeFieldIds },
      after: { ...data },
    });
    return loadRegister(tx, id);
  });
}

export async function setRegisterArchived(db: Db, actor: Actor, id: string, version: number, archived: boolean) {
  return withTx(db, async (tx) => {
    const reg = await loadRegister(tx, id);
    if (archived && reg.systemKey) throw conflict('SYSTEM_REGISTER', `«${reg.name}» — системный реестр: его нельзя отправить в архив`);
    if (reg.archived === archived) {
      if (reg.version !== version) throw versionConflict();
      return reg;
    }
    if (!archived) await assertRegisterNameFree(tx, reg.name, id);
    const res = await tx.register.updateMany({ where: { id, version }, data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.register.findUnique({ where: { id } }), 'Реестр');
    await auditSettings(tx, actor, {
      action: archived ? 'register.archived' : 'register.restored', entity: 'register', entityId: id,
      summary: `Реестр «${reg.name}» ${archived ? 'отправлен в архив' : 'возвращён из архива'}`,
    });
    return loadRegister(tx, id);
  });
}

// ---------------------------------------------------------------- поля

async function getField(db: Db, fieldId: string): Promise<{ reg: RegisterDef; field: FieldMeta }> {
  const f = await db.registerField.findFirst({ where: { id: fieldId, deletedAt: null }, select: { registerId: true } });
  if (!f) throw notFound('Поле');
  const reg = await loadRegister(db, f.registerId);
  const field = reg.fields.find((x) => x.id === fieldId);
  if (!field) throw notFound('Поле');
  return { reg, field };
}

async function assertLabelFree(db: Db, registerId: string, label: string, exceptId?: string) {
  const clash = await db.registerField.findFirst({
    where: { registerId, deletedAt: null, label: { equals: label, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (clash) throw conflict('DUPLICATE', `Поле «${label}» уже есть в реестре`);
}

function assertRole(type: FieldType, role: string | null | undefined) {
  if (role && !(ALLOWED_ROLES[type] as readonly string[]).includes(role)) {
    throw badRequest('BAD_ANALYTICS_ROLE', `Для поля типа «${TYPE_NAMES[type]}» эта роль аналитики недоступна`);
  }
}

/**
 * Правило вычисляемого поля: дата «от» + дни по варианту списка; переопределение — дата
 * (по желанию — только при заполненном поле-условии) и перенос срока на рабочий день.
 * Оценка уязвимости — только у системного поля, через интерфейс не задаётся.
 */
function validateCalcRule(reg: RegisterDef, rule: DueDateRule, selfId?: string): DueDateRule {
  const live = (id: string | null) => (id ? reg.fields.find((f) => f.id === id && !f.archived && f.id !== selfId) : undefined);
  const from = live(rule.fromFieldId);
  if (!from || from.type !== 'date') throw badRequest('BAD_CALC_RULE', 'Выберите поле-дату, от которой считается срок');
  const by = live(rule.byFieldId);
  if (!by || by.type !== 'select') throw badRequest('BAD_CALC_RULE', 'Выберите поле-список, от значения которого зависит срок');
  const days: Record<string, number> = {};
  for (const [optionId, n] of Object.entries(rule.days)) {
    if (!by.options.some((o) => o.id === optionId)) throw badRequest('BAD_CALC_RULE', 'Срок задан для варианта, которого нет в списке');
    if (!Number.isInteger(n) || n < 0 || n > 3650) throw badRequest('BAD_CALC_RULE', 'Срок — целое число дней от 0 до 3650');
    days[optionId] = n;
  }
  if (Object.keys(days).length === 0) throw badRequest('BAD_CALC_RULE', 'Задайте срок хотя бы для одного значения списка');
  let overrideFieldId: string | null = null;
  if (rule.overrideFieldId) {
    const o = live(rule.overrideFieldId);
    if (!o || o.type !== 'date') throw badRequest('BAD_CALC_RULE', 'Переопределять срок может только поле-дата');
    overrideFieldId = o.id;
  }
  const out: DueDateRule = { fromFieldId: from.id, byFieldId: by.id, days, overrideFieldId };
  if (rule.overrideWhenFilledFieldId) {
    if (!overrideFieldId) throw badRequest('BAD_CALC_RULE', 'Условие замены срока задаётся вместе с полем-датой замены');
    const w = live(rule.overrideWhenFilledFieldId);
    if (!w || w.type === 'calc' || w.type === 'decision') throw badRequest('BAD_CALC_RULE', 'Условием замены срока может быть только заполняемое поле');
    out.overrideWhenFilledFieldId = w.id;
  }
  if (rule.shiftToWorkday) out.shiftToWorkday = true;
  return out;
}

/**
 * Статус основания (сверка с DLP): канал этой записи и разрешения из другого реестра, которые ссылаются на неё
 * полем «Связь с записью». Все поля источника — живые поля нужных типов.
 */
async function validateBasisRule(db: Db, reg: RegisterDef, rule: BasisRule, selfId?: string): Promise<BasisRule> {
  const bad = (m: string) => badRequest('BAD_CALC_RULE', m);
  const channel = reg.fields.find((f) => f.id === rule.channelFieldId && !f.archived && f.id !== selfId);
  if (!channel || channel.type !== 'select') throw bad('Выберите поле-список канала доступа');
  const closed = [...new Set(rule.closedOptionIds)];
  if (closed.some((id) => !channel.options.some((o) => o.id === id))) throw bad('«Закрыто» — значения поля канала');
  if (rule.sourceRegisterId === reg.id) throw bad('Разрешения берутся из другого реестра');
  const src = await loadRegister(db, rule.sourceRegisterId).catch(() => null);
  if (!src || src.archived) throw bad('Реестр разрешений не найден или в архиве');
  const live = (id: string | null, types: readonly string[]) => (id ? src.fields.find((f) => f.id === id && !f.archived && types.includes(f.type)) : undefined);
  const link = live(rule.linkFieldId, ['link']);
  if (!link || link.linkRegisterId !== reg.id) throw bad(`В реестре «${src.name}» выберите поле «Связь с записью», которое ссылается на этот реестр`);
  const kind = live(rule.kindFieldId, ['select']);
  if (rule.kindFieldId && !kind) throw bad('Поле вида разрешения — список реестра разрешений');
  const kindOptionIds = kind ? [...new Set(rule.kindOptionIds)] : [];
  if (kind && (!kindOptionIds.length || kindOptionIds.some((id) => !kind.options.some((o) => o.id === id)))) throw bad('Выберите виды разрешений для канала');
  const status = src.fields.find((f) => f.isStatus && !f.archived);
  if (!status || status.id !== rule.statusFieldId) throw bad('Статус разрешения — поле статуса реестра разрешений');
  const active = [...new Set(rule.activeOptionIds)];
  if (!active.length || active.some((id) => !status.options.some((o) => o.id === id))) throw bad('Выберите «действующие» значения статуса');
  const until = live(rule.untilFieldId, ['date']);
  if (rule.untilFieldId && !until) throw bad('«Действует до» — поле-дата реестра разрешений');
  const num = live(rule.numberFieldId, ['text']);
  if (rule.numberFieldId && !num) throw bad('Номер документа — текстовое поле реестра разрешений');
  return {
    kind: 'link_basis', channelFieldId: channel.id, closedOptionIds: closed, sourceRegisterId: src.id, linkFieldId: link.id,
    kindFieldId: kind?.id ?? null, kindOptionIds, statusFieldId: status.id, activeOptionIds: active,
    untilFieldId: until?.id ?? null, numberFieldId: num?.id ?? null,
  };
}

/** Правило из запроса: срок (без kind или due_date) или статус основания (link_basis). */
export type CalcRuleInput = DueDateRule | BasisRule;

async function validateAnyRule(db: Db, reg: RegisterDef, rule: CalcRuleInput, selfId?: string): Promise<DueDateRule | BasisRule> {
  return isBasisRule(rule) ? validateBasisRule(db, reg, rule, selfId) : validateCalcRule(reg, rule, selfId);
}

/** Правила статуса основания в других реестрах, которые ссылаются на поле (поле нельзя удалить или убрать в архив). */
async function basisDependents(db: Db, fieldId: string) {
  return db.$queryRaw<{ label: string; register: string }[]>`
    SELECT f.label, r.name AS register FROM register_fields f JOIN registers r ON r.id = f.register_id
    WHERE f.deleted_at IS NULL AND f.calc_rule ->> 'kind' = 'link_basis' AND strpos(f.calc_rule::text, ${fieldId}) > 0`;
}

function describeRule(reg: RegisterDef, rule: CalcRule): string {
  const name = (id: string | null | undefined) => reg.fields.find((f) => f.id === id)?.label ?? '?';
  if (isScoreRule(rule)) return `«${name(rule.cvssFieldId)}» × Кэ по «${name(rule.exploitFieldId)}» × Ки по «${name(rule.fixFieldId)}»`;
  if (isBasisRule(rule)) return `статус основания по каналу «${name(rule.channelFieldId)}»`;
  const by = reg.fields.find((f) => f.id === rule.byFieldId);
  const days = Object.entries(rule.days).map(([o, n]) => `${by?.options.find((x) => x.id === o)?.label ?? '?'} ${n} дн.`).join(', ');
  const override = rule.overrideFieldId
    ? `; если задано «${name(rule.overrideFieldId)}»${rule.overrideWhenFilledFieldId ? ` и «${name(rule.overrideWhenFilledFieldId)}»` : ''} — оно`
    : '';
  return `«${name(rule.fromFieldId)}» + срок по «${name(rule.byFieldId)}» (${days})${override}${rule.shiftToWorkday ? '; нерабочий день — перенос на рабочий' : ''}`;
}

const STATUS_NAME = (reg: RegisterDef, id: string) => reg.fields.find((f) => f.isStatus)?.options.find((o) => o.id === id)?.label ?? '?';

/**
 * Настройки поля (lib/field-settings.ts): фиксация — значения поля статуса; режим «с причиной»; ограничение даты —
 * другое поле-дата этого реестра. Снять фиксацию со статуса, который уже есть у записей, нельзя:
 * зафиксированное меняется только новой записью.
 */
async function validateSettings(db: Db, reg: RegisterDef, field: { id: string | null; type: FieldType; isStatus?: boolean; settings?: FieldSettings }, input: FieldSettings) {
  const out: FieldSettings = {};
  if (input.lock && input.lock.statusOptionIds.length) {
    if (field.type === 'calc' || field.type === 'decision') throw badRequest('BAD_SETTINGS', 'Вычисляемое поле и решение не фиксируются: они не вводятся');
    if (field.isStatus) throw badRequest('BAD_SETTINGS', 'Поле статуса не фиксируется — смену статуса ограничивают фиксирующие значения');
    const status = reg.fields.find((f) => f.isStatus && !f.archived);
    if (!status) throw badRequest('BAD_SETTINGS', 'В реестре нет поля статуса — фиксировать не по чему');
    for (const id of input.lock.statusOptionIds) {
      if (!status.options.some((o) => o.id === id)) throw badRequest('BAD_SETTINGS', 'Фиксация — по значениям поля статуса. Обновите страницу');
    }
    if (!(LOCK_MODES as readonly string[]).includes(input.lock.mode)) throw badRequest('BAD_SETTINGS', 'Неизвестный режим фиксации');
    out.lock = { statusOptionIds: [...new Set(input.lock.statusOptionIds)], mode: input.lock.mode };
  }
  if (input.date && (input.date.notAfterYearEndOfFieldId || input.date.defaultEndOfYear)) {
    if (field.type !== 'date') throw badRequest('BAD_SETTINGS', 'Ограничение даты — только у поля-даты');
    const anchorId = input.date.notAfterYearEndOfFieldId;
    if (anchorId) {
      const anchor = reg.fields.find((f) => f.id === anchorId && !f.archived);
      if (!anchor || anchor.type !== 'date' || anchor.id === field.id) throw badRequest('BAD_SETTINGS', '«Не позже 31.12 года поля» — другое поле-дата этого реестра');
    }
    out.date = { notAfterYearEndOfFieldId: anchorId ?? null, defaultEndOfYear: !!input.date.defaultEndOfYear };
  }
  if (input.text?.multiline) {
    if (field.type !== 'text') throw badRequest('BAD_SETTINGS', 'Многострочным бывает только текстовое поле');
    out.text = { multiline: true };
  }
  if (input.hint?.trim()) {
    if (input.hint.trim().length > HINT_MAX) throw badRequest('BAD_SETTINGS', `Подсказка — не длиннее ${HINT_MAX} символов`);
    out.hint = input.hint.trim();
  }
  // Снять «Многострочный текст» нельзя, пока есть значения длиннее обычного лимита: они бы не прошли проверку.
  if (field.id && field.settings?.text?.multiline && !out.text) {
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM register_records
      WHERE register_id = ${reg.id}::uuid AND deleted_at IS NULL AND char_length("values" ->> ${field.id}) > ${TEXT_MAX}`;
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) throw conflict('TEXT_TOO_LONG', `Записей с текстом длиннее ${TEXT_MAX} символов: ${n}. Сократите их или оставьте поле многострочным`);
  }
  // Ослабление фиксации: статусы, которые больше не фиксируют (или фиксируют только «с причиной»).
  const before = field.settings?.lock;
  if (before && field.id) {
    const still = (id: string) => out.lock?.statusOptionIds.includes(id) && (before.mode === 'reason' || out.lock.mode === 'locked');
    const loosened = before.statusOptionIds.filter((id) => !still(id));
    const status = reg.fields.find((f) => f.isStatus);
    if (loosened.length && status) {
      const rows = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM register_records
        WHERE register_id = ${reg.id}::uuid AND deleted_at IS NULL AND "values" ->> ${status.id} = ANY(${loosened}::text[])`;
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) {
        throw conflict('LOCK_IN_USE', `Записей со статусом ${loosened.map((id) => `«${STATUS_NAME(reg, id)}»`).join(', ')}: ${n}. Их зафиксированные значения меняются только новой записью — фиксацию не ослабить`);
      }
    }
  }
  return compactSettings(out);
}

function describeSettings(reg: RegisterDef, s: FieldSettings | null): string {
  if (!s) return 'без фиксации и ограничений';
  const parts: string[] = [];
  if (s.lock) parts.push(`${s.lock.mode === 'reason' ? 'изменение с причиной' : 'фиксируется'} при статусах ${s.lock.statusOptionIds.map((id) => `«${STATUS_NAME(reg, id)}»`).join(', ')}`);
  if (s.date?.notAfterYearEndOfFieldId) parts.push(`не позже 31.12 года «${reg.fields.find((f) => f.id === s.date?.notAfterYearEndOfFieldId)?.label ?? '?'}»`);
  if (s.date?.defaultEndOfYear) parts.push('по умолчанию 31.12 текущего года');
  if (s.text?.multiline) parts.push(`многострочный текст (до ${TEXT_MAX_MULTILINE} символов)`);
  if (s.hint) parts.push(`подсказка «${s.hint}»`);
  return parts.join('; ');
}

export interface NewFieldInput {
  label: string;
  type: FieldType;
  options?: string[];
  analyticsRole?: AnalyticsRole | null;
  calcRule?: CalcRuleInput;
  /** Только для «Значения справочника». */
  catalogCode?: string;
  /** Только для «Связи с записью»: реестр, на записи которого ссылается поле. */
  linkRegisterId?: string;
  settings?: FieldSettings;
}

export async function addField(db: Db, actor: Actor, registerId: string, input: NewFieldInput) {
  return withTx(db, async (tx) => {
    const reg = await loadRegister(tx, registerId);
    assertNotArchived(reg);
    const label = trimmed(input.label);
    if (!label) throw badRequest('EMPTY_LABEL', 'Укажите название поля');
    await assertLabelFree(tx, registerId, label);
    assertRole(input.type, input.analyticsRole);
    let calcRule: DueDateRule | BasisRule | null = null;
    if (input.type === 'calc') {
      if (!input.calcRule) throw badRequest('BAD_CALC_RULE', 'Для вычисляемого поля задайте правило');
      calcRule = await validateAnyRule(tx, reg, input.calcRule);
      if (isBasisRule(calcRule) && input.analyticsRole) throw badRequest('BAD_ANALYTICS_ROLE', 'Статус основания не бывает датой или сроком');
    } else if (input.calcRule) {
      throw badRequest('BAD_CALC_RULE', 'Правило вычисления бывает только у вычисляемого поля');
    }
    const catalog = input.type === 'catalog' ? await assertFieldCatalog(tx, input.catalogCode) : null;
    if (!catalog && input.catalogCode) throw badRequest('NO_CATALOG', 'Справочник выбирается только у поля «Значение справочника»');
    let linkRegister: { id: string; name: string } | null = null;
    if (input.type === 'link') {
      if (!input.linkRegisterId) throw badRequest('NO_LINK_REGISTER', 'Выберите реестр, на записи которого ссылается поле');
      linkRegister = await tx.register.findFirst({ where: { id: input.linkRegisterId, archivedAt: null }, select: { id: true, name: true } });
      if (!linkRegister) throw badRequest('NO_LINK_REGISTER', 'Реестр для связи не найден или в архиве');
    } else if (input.linkRegisterId) {
      throw badRequest('NO_LINK_REGISTER', 'Реестр выбирается только у поля «Связь с записью»');
    }
    const settings = input.settings ? await validateSettings(tx, reg, { id: null, type: input.type }, input.settings) : null;
    const options = [...new Set((input.options ?? []).map(trimmed).filter(Boolean))];
    if (options.length && input.type !== 'select' && input.type !== 'decision') {
      throw badRequest('NO_OPTIONS', 'Значения списка бывают только у списка и решения другого отдела');
    }
    if (input.type === 'decision' && options.length < 2) {
      throw badRequest('NO_OPTIONS', 'У решения другого отдела нужно минимум два значения; первое — «ожидает решения»');
    }
    const max = await tx.registerField.aggregate({ where: { registerId }, _max: { sortOrder: true } });
    const f = await tx.registerField.create({
      data: {
        registerId,
        label,
        type: input.type,
        analyticsRole: input.analyticsRole ?? null,
        calcRule: (calcRule ?? undefined) as Prisma.InputJsonValue | undefined,
        catalogCode: catalog?.code ?? null,
        linkRegisterId: linkRegister?.id ?? null,
        settings: (settings ?? undefined) as Prisma.InputJsonValue | undefined,
        sortOrder: (max._max.sortOrder ?? 0) + 1,
        options: options.length ? { create: options.map((l, i) => ({ label: l, sortOrder: i + 1 })) } : undefined,
      },
    });
    await auditSettings(tx, actor, {
      action: 'register.field.created', entity: 'register_field', entityId: f.id,
      summary: `Реестр «${reg.name}»: добавлено поле «${label}» (${TYPE_NAMES[input.type]}${catalog ? ` «${catalog.name}»` : ''}${linkRegister ? ` → «${linkRegister.name}»` : ''})${calcRule ? `, ${describeRule(await loadRegister(tx, registerId), calcRule)}` : ''}${settings ? `; ${describeSettings(reg, settings)}` : ''}`,
      after: { label, type: input.type, options, analyticsRole: input.analyticsRole ?? null, catalogCode: catalog?.code ?? null, linkRegisterId: linkRegister?.id ?? null, settings },
    });
    return loadRegister(tx, registerId);
  });
}

export interface FieldUpdate {
  version: number;
  label?: string;
  analyticsRole?: AnalyticsRole | null;
  isTitle?: boolean;
  isStatus?: boolean;
  isImportKey?: boolean;
  calcRule?: CalcRuleInput;
  /** Фиксация при статусах, ограничения даты; null — снять всё. */
  settings?: FieldSettings | null;
}

export async function updateField(db: Db, actor: Actor, fieldId: string, input: FieldUpdate) {
  return withTx(db, async (tx) => {
    const { reg, field } = await getField(tx, fieldId);
    assertNotArchived(reg);
    if (input.version !== field.version) throw versionConflict();
    const data: Prisma.RegisterFieldUncheckedUpdateManyInput = {};
    const changes: string[] = [];
    if (input.label !== undefined && trimmed(input.label) !== field.label) {
      if (!trimmed(input.label)) throw badRequest('EMPTY_LABEL', 'Укажите название поля');
      await assertLabelFree(tx, reg.id, trimmed(input.label), fieldId);
      data.label = trimmed(input.label);
      changes.push(`переименовано в «${data.label}»`);
    }
    if (input.analyticsRole !== undefined && input.analyticsRole !== field.analyticsRole) {
      assertRole(field.type, input.analyticsRole);
      data.analyticsRole = input.analyticsRole;
      changes.push('роль для аналитики');
    }
    const systemTitle = reg.fields.find((f) => f.isTitle && f.systemKey);
    const systemStatus = reg.fields.find((f) => f.isStatus && f.systemKey);
    if (input.isTitle !== undefined && input.isTitle !== field.isTitle) {
      if (systemTitle) throw conflict('SYSTEM_FIELD', `Заголовок записи — системное поле «${systemTitle.label}», он не меняется`);
      if (!input.isTitle) throw badRequest('TITLE_REQUIRED', 'Назначьте заголовком другое поле — оно заменит это');
      if (field.type !== 'text') throw badRequest('TITLE_TEXT', 'Заголовком записи может быть только текстовое поле');
      if (field.archived) throw badRequest('ARCHIVED_FIELD', 'Архивное поле не может быть заголовком');
      await tx.registerField.updateMany({ where: { registerId: reg.id, isTitle: true }, data: { isTitle: false, version: { increment: 1 } } });
      data.isTitle = true;
      changes.push('назначено заголовком записи');
    }
    if (input.isStatus !== undefined && input.isStatus !== field.isStatus) {
      if (systemStatus) throw conflict('SYSTEM_FIELD', `Статус записи — системное поле «${systemStatus.label}», он не меняется`);
      if (input.isStatus && field.type !== 'select') throw badRequest('STATUS_SELECT', 'Статусом может быть только поле-список');
      if (input.isStatus && field.archived) throw badRequest('ARCHIVED_FIELD', 'Архивное поле не может быть статусом');
      // Фиксация полей считается по значениям статуса: сменить поле статуса — снять её у всех записей.
      const locking = reg.fields.filter((f) => f.settings.lock);
      if (locking.length) throw conflict('LOCK_DEPENDENCY', `Фиксация полей ${locking.map((f) => `«${f.label}»`).join(', ')} задана по статусу — сначала снимите её`);
      if (input.isStatus) await tx.registerField.updateMany({ where: { registerId: reg.id, isStatus: true }, data: { isStatus: false, version: { increment: 1 } } });
      data.isStatus = input.isStatus;
      changes.push(input.isStatus ? 'назначено полем статуса' : 'больше не поле статуса');
    }
    let rekey = false;
    if (input.isImportKey !== undefined && input.isImportKey !== field.isImportKey) {
      if (input.isImportKey) {
        if (field.type !== 'text') throw badRequest('IMPORT_KEY_TEXT', 'Ключом импорта может быть только текстовое поле');
        if (field.archived) throw badRequest('ARCHIVED_FIELD', 'Архивное поле не может быть ключом импорта');
        const dups = await importKeyDuplicates(tx, reg.id, field.id);
        if (dups.length) {
          const list = dups.slice(0, 5).map((d) => `«${d.value}» — записи ${d.numbers.map((n) => `#${n}`).join(', ')}`).join('; ');
          throw new AppError(409, 'IMPORT_KEY_DUPLICATES', `Значения «${field.label}» повторяются: ${list}${dups.length > 5 ? '…' : ''}. Исправьте их, затем назначьте ключ`, {
            duplicates: dups.map((d) => ({ value: d.value, numbers: d.numbers })),
          });
        }
        await tx.registerField.updateMany({ where: { registerId: reg.id, isImportKey: true }, data: { isImportKey: false, version: { increment: 1 } } });
      }
      data.isImportKey = input.isImportKey;
      changes.push(input.isImportKey ? 'назначено ключом импорта' : 'больше не ключ импорта');
      rekey = true;
    }
    if (input.calcRule !== undefined) {
      if (field.type !== 'calc') throw badRequest('BAD_CALC_RULE', 'Правило вычисления бывает только у вычисляемого поля');
      // Сроки и оценка системного реестра заданы процедурой (п. 7.1–7.3) и меняются только выпуском портала.
      assertNotSystemField(field, 'менять правило вычисления');
      if (isBasisRule(field.calcRule) !== isBasisRule(input.calcRule)) throw badRequest('BAD_CALC_RULE', 'Вид правила не меняется — добавьте новое вычисляемое поле');
      const rule = await validateAnyRule(tx, reg, input.calcRule, fieldId);
      data.calcRule = rule as unknown as Prisma.InputJsonValue;
      changes.push(`правило: ${describeRule(reg, rule)}`);
    }
    let settingsChanged = false;
    if (input.settings !== undefined) {
      const next = await validateSettings(tx, reg, field, input.settings ?? {});
      if (JSON.stringify(next) !== JSON.stringify(compactSettings(field.settings))) {
        data.settings = (next ?? Prisma.DbNull) as Prisma.InputJsonValue;
        changes.push(describeSettings(reg, next));
        settingsChanged = true;
      }
    }
    if (!changes.length) return reg;
    const res = await tx.registerField.updateMany({ where: { id: fieldId, version: input.version }, data: { ...data, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerField.findFirst({ where: { id: fieldId, deletedAt: null } }), 'Поле');
    // Ключ импорта пересчитывает триггер (register_records_import_key) по новому полю-ключу.
    if (rekey) await tx.$executeRaw`UPDATE register_records SET import_key = NULL WHERE register_id = ${reg.id}::uuid`;
    await auditSettings(tx, actor, {
      action: 'register.field.updated', entity: 'register_field', entityId: fieldId,
      summary: `Реестр «${reg.name}», поле «${field.label}»: ${changes.join(', ')}`,
      before: {
        label: field.label, analyticsRole: field.analyticsRole, isTitle: field.isTitle, isStatus: field.isStatus, isImportKey: field.isImportKey, calcRule: field.calcRule,
        ...(settingsChanged ? { settings: compactSettings(field.settings) } : {}),
      },
      after: { ...data, ...(settingsChanged ? { settings: data.settings === Prisma.DbNull ? null : data.settings } : {}) },
    });
    return loadRegister(tx, reg.id);
  });
}

export async function moveField(db: Db, actor: Actor, fieldId: string, direction: 'up' | 'down') {
  return withTx(db, async (tx) => {
    const { reg, field } = await getField(tx, fieldId);
    assertNotArchived(reg);
    const list = reg.fields;
    const i = list.findIndex((f) => f.id === fieldId);
    const j = direction === 'up' ? i - 1 : i + 1;
    const other = list[j];
    if (!other) return reg;
    const order = list.map((f) => f.id);
    [order[i], order[j]] = [other.id, fieldId];
    for (const [k, id] of order.entries()) await tx.registerField.update({ where: { id }, data: { sortOrder: k + 1 } });
    await auditSettings(tx, actor, {
      action: 'register.field.moved', entity: 'register_field', entityId: fieldId,
      summary: `Реестр «${reg.name}»: поле «${field.label}» перемещено ${direction === 'up' ? 'выше' : 'ниже'}`,
    });
    return loadRegister(tx, reg.id);
  });
}

/** Поле из настроек сравнения (ключ или область) не уходит в архив, не удаляется и не меняет тип. */
function assertNotCompareField(reg: RegisterDef, field: FieldMeta, what: string) {
  if (reg.compareKeyFieldIds.includes(field.id) || reg.compareScopeFieldIds.includes(field.id)) {
    throw conflict('COMPARE_FIELD', `Поле «${field.label}» используется в сравнении с реестром — нельзя ${what}: сначала уберите его из сравнения`);
  }
}

/** Ограничения на архив и удаление: заголовок, статус, ссылки из правил вычисления. */
async function assertDetachable(db: Db, reg: RegisterDef, field: FieldMeta, what: string) {
  assertNotSystemField(field, what);
  if (field.isTitle) throw conflict('TITLE_FIELD', `Поле-заголовок нельзя ${what}: сначала назначьте заголовком другое текстовое поле`);
  if (field.isStatus) throw conflict('STATUS_FIELD', `Поле статуса нельзя ${what}: сначала снимите признак статуса`);
  if (field.isImportKey) throw conflict('IMPORT_KEY_FIELD', `Ключ импорта нельзя ${what}: сначала снимите признак ключа`);
  assertNotCompareField(reg, field, what);
  const deps = calcDependents(reg, field.id).filter((d) => d.id !== field.id);
  if (deps.length) throw conflict('CALC_DEPENDENCY', `Поле используется в правиле вычисления «${deps.map((d) => d.label).join('», «')}» — сначала измените правило`);
  const anchors = reg.fields.filter((f) => f.settings.date?.notAfterYearEndOfFieldId === field.id);
  if (anchors.length) throw conflict('DATE_DEPENDENCY', `По полю проверяется дата «${anchors.map((d) => d.label).join('», «')}» — сначала снимите ограничение`);
  const basis = (await basisDependents(db, field.id)).filter((b) => b.label !== field.label || b.register !== reg.name);
  if (basis.length) throw conflict('CALC_DEPENDENCY', `Поле используется в статусе основания «${basis.map((b) => `${b.register}: ${b.label}`).join('», «')}» — сначала измените правило`);
}

export async function setFieldArchived(db: Db, actor: Actor, fieldId: string, version: number, archived: boolean) {
  return withTx(db, async (tx) => {
    const { reg, field } = await getField(tx, fieldId);
    assertNotArchived(reg);
    if (archived) await assertDetachable(tx, reg, field, 'отправить в архив');
    if (field.archived === archived) {
      if (field.version !== version) throw versionConflict();
      return reg;
    }
    const res = await tx.registerField.updateMany({ where: { id: fieldId, version }, data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerField.findFirst({ where: { id: fieldId, deletedAt: null } }), 'Поле');
    await recomputeSearch(tx, await loadRegister(tx, reg.id));
    await auditSettings(tx, actor, {
      action: archived ? 'register.field.archived' : 'register.field.restored', entity: 'register_field', entityId: fieldId,
      summary: `Реестр «${reg.name}»: поле «${field.label}» ${archived ? 'отправлено в архив — значения сохранены' : 'возвращено из архива'}`,
    });
    return loadRegister(tx, reg.id);
  });
}

/** Удалить можно только поле без данных; поле с данными — только в архив. */
export async function deleteField(db: Db, actor: Actor, fieldId: string, version: number) {
  return withTx(db, async (tx) => {
    const { reg, field } = await getField(tx, fieldId);
    assertNotArchived(reg);
    await assertDetachable(tx, reg, field, 'удалить');
    const n = await fieldHasData(tx, field);
    if (n > 0) throw conflict('HAS_DATA', `В поле «${field.label}» есть данные (${n}). Отправьте его в архив: значения сохранятся`);
    const res = await tx.registerField.updateMany({ where: { id: fieldId, version }, data: { deletedAt: new Date(), isTitle: false, isStatus: false, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerField.findFirst({ where: { id: fieldId, deletedAt: null } }), 'Поле');
    await tx.registerFieldOption.updateMany({ where: { fieldId, deletedAt: null }, data: { deletedAt: new Date() } });
    await auditSettings(tx, actor, {
      action: 'register.field.deleted', entity: 'register_field', entityId: fieldId,
      summary: `Реестр «${reg.name}»: удалено поле «${field.label}» (без данных)`,
      before: { label: field.label, type: field.type, options: field.options.map((o) => o.label) },
    });
    return loadRegister(tx, reg.id);
  });
}

// ---------------------------------------------------------------- смена типа

export interface TypeChangePreview {
  kind: 'empty' | 'to_text' | 'from_text';
  /** Сколько записей изменится. */
  affected: number;
  /** Записи, значение которых не распознано (вариант В): смена типа невозможна. */
  errors: { number: number; value: string }[];
  /** Для перевода в список: какие варианты будут созданы. */
  newOptions: string[];
  /** Примеры: было → станет. */
  samples: { number: number; from: string; to: string }[];
}

async function planTypeChange(tx: Db, reg: RegisterDef, field: FieldMeta, to: FieldType) {
  assertNotSystemField(field, 'менять тип');
  if (field.isTitle) throw conflict('TITLE_FIELD', 'Тип поля-заголовка не меняется: заголовок всегда текстовый');
  if (field.isStatus) throw conflict('STATUS_FIELD', 'Тип поля статуса не меняется: сначала снимите признак статуса');
  if (field.isImportKey) throw conflict('IMPORT_KEY_FIELD', 'Тип ключа импорта не меняется: сначала снимите признак ключа');
  assertNotCompareField(reg, field, 'менять тип');
  if (field.settings.lock || field.settings.date) throw conflict('FIELD_SETTINGS', 'У поля задана фиксация или ограничение даты — сначала снимите их');
  if (field.settings.text) throw conflict('FIELD_SETTINGS', 'Поле многострочное — сначала снимите признак «Многострочный текст»');
  if (reg.fields.some((f) => f.settings.date?.notAfterYearEndOfFieldId === field.id)) throw conflict('DATE_DEPENDENCY', 'По полю проверяется другая дата — сначала снимите ограничение');
  if ((await basisDependents(tx, field.id)).length) throw conflict('CALC_DEPENDENCY', 'Поле используется в статусе основания — сначала измените правило');
  if (calcDependents(reg, field.id).some((d) => d.id !== field.id)) {
    throw conflict('CALC_DEPENDENCY', 'Поле используется в правиле вычисляемого поля — сначала измените правило');
  }
  // Записи, где у поля есть значение (ключ есть в values).
  const withData = await tx.$queryRaw<{ id: string; number: number; values: Values; version: number }[]>`
    SELECT id, number, "values", version FROM register_records
    WHERE register_id = ${reg.id}::uuid AND deleted_at IS NULL AND "values" ? ${field.id}
    ORDER BY number`;
  const kind = typeChangeKind(field.type, to, withData.length > 0);
  if (!kind.ok) throw conflict('TYPE_CHANGE_FORBIDDEN', kind.error);
  const users = await loadUsers(tx, userIdsIn(reg, withData.map((r) => r.values as Values)));
  const converted = new Map<string, StoredValue>();
  const errors: TypeChangePreview['errors'] = [];
  const samples: TypeChangePreview['samples'] = [];
  const labels: string[] = [];
  for (const r of withData) {
    const v = (r.values as Values)[field.id] as StoredValue;
    const before = displayValue(field, v, { users });
    if (kind.value === 'to_text') {
      converted.set(r.id, toText(field, v, { users }));
    } else if (kind.value === 'from_text') {
      const x = fromText(to as 'number' | 'date' | 'select', v);
      if (x === null) {
        errors.push({ number: r.number, value: String(v) });
        continue;
      }
      if (to === 'select' && typeof x === 'string' && !labels.some((l) => l.toLowerCase() === x.toLowerCase())) labels.push(x);
      converted.set(r.id, x);
    }
    if (samples.length < 5 && converted.has(r.id)) {
      const after = converted.get(r.id);
      samples.push({ number: r.number, from: before, to: to === 'date' && typeof after === 'string' ? after.split('-').reverse().join('.') : String(after) });
    }
  }
  return { kind: kind.value, records: withData, converted, errors, newOptions: labels, samples };
}

export async function previewTypeChange(db: Db, fieldId: string, to: FieldType): Promise<TypeChangePreview> {
  const { reg, field } = await getField(db, fieldId);
  assertNotArchived(reg);
  const plan = await planTypeChange(db, reg, field, to);
  return { kind: plan.kind, affected: plan.converted.size, errors: plan.errors, newOptions: plan.newOptions, samples: plan.samples };
}

export async function applyTypeChange(db: Db, actor: Actor, fieldId: string, input: { version: number; to: FieldType }) {
  return withTx(db, async (tx) => {
    const { reg, field } = await getField(tx, fieldId);
    assertNotArchived(reg);
    if (field.version !== input.version) throw versionConflict();
    const plan = await planTypeChange(tx, reg, field, input.to);
    if (plan.errors.length) {
      throw conflict('TYPE_CHANGE_VALUES', `Не распознаны значения в ${plan.errors.length} записях — смена типа невозможна. Исправьте их и повторите`);
    }
    const to = input.to;
    // Варианты нового списка из найденных значений.
    const optionIdByLabel = new Map<string, string>();
    if (to === 'select') {
      for (const [i, label] of plan.newOptions.entries()) {
        const o = await tx.registerFieldOption.create({ data: { fieldId, label, sortOrder: i + 1 } });
        optionIdByLabel.set(label.toLowerCase(), o.id);
      }
    }
    // Старые варианты списка больше не нужны (значения переведены в текст).
    if (field.type === 'select' && to !== 'select') {
      await tx.registerFieldOption.updateMany({ where: { fieldId, deletedAt: null }, data: { deletedAt: new Date() } });
    }
    const keepRole = field.analyticsRole && (ALLOWED_ROLES[to] as readonly string[]).includes(field.analyticsRole);
    const res = await tx.registerField.updateMany({
      where: { id: fieldId, version: input.version },
      data: { type: to, analyticsRole: keepRole ? field.analyticsRole : null, isStatus: false, catalogCode: null, version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.registerField.findFirst({ where: { id: fieldId, deletedAt: null } }), 'Поле');
    const after = await loadRegister(tx, reg.id);
    const newField = after.fields.find((f) => f.id === fieldId);
    for (const r of plan.records) {
      let v = plan.converted.get(r.id);
      if (v === undefined) continue;
      if (to === 'select') v = optionIdByLabel.get(String(v).toLowerCase()) ?? v;
      const values = { ...(r.values as Values), [fieldId]: v };
      await tx.registerRecord.update({ where: { id: r.id }, data: { values, version: { increment: 1 } } });
      const before = displayValue(field, (r.values as Values)[fieldId], { users: await loadUsers(tx, userIdsIn(reg, [r.values as Values])) });
      await auditSettings(tx, actor, {
        action: 'register_record.updated', entity: 'register_record', entityId: r.id,
        summary: `Тип поля «${field.label}» изменён: ${TYPE_NAMES[field.type]} → ${TYPE_NAMES[to]}`,
        after: {
          changes: [{ fieldId, label: field.label, from: before, to: newField ? displayValue(newField, v, { users: new Map() }) || String(v) : String(v) }],
          via: 'type_change',
        },
      });
    }
    await recomputeSearch(tx, after);
    await auditSettings(tx, actor, {
      action: 'register.field.type_changed', entity: 'register_field', entityId: fieldId,
      summary: `Реестр «${reg.name}», поле «${field.label}»: тип ${TYPE_NAMES[field.type]} → ${TYPE_NAMES[to]}, изменено записей: ${plan.converted.size}`,
      before: { type: field.type }, after: { type: to, affected: plan.converted.size, newOptions: plan.newOptions },
    });
    return after;
  });
}

// ---------------------------------------------------------------- варианты списков

async function getOption(db: Db, optionId: string) {
  const o = await db.registerFieldOption.findFirst({ where: { id: optionId, deletedAt: null }, select: { fieldId: true } });
  if (!o) throw notFound('Значение списка');
  const { reg, field } = await getField(db, o.fieldId);
  const option = field.options.find((x) => x.id === optionId);
  if (!option) throw notFound('Значение списка');
  return { reg, field, option };
}

async function assertOptionFree(db: Db, fieldId: string, label: string, exceptId?: string) {
  const clash = await db.registerFieldOption.findFirst({
    where: { fieldId, deletedAt: null, label: { equals: label, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (clash) throw conflict('DUPLICATE', `«${label}» уже есть в списке`);
}

export async function addOption(db: Db, actor: Actor, fieldId: string, input: { label: string }) {
  return withTx(db, async (tx) => {
    const { reg, field } = await getField(tx, fieldId);
    assertNotArchived(reg);
    if (field.type === 'catalog') throw badRequest('NO_OPTIONS', 'Значения поля «Значение справочника» правятся в настройках справочника');
    if (field.type !== 'select' && field.type !== 'decision') throw badRequest('NO_OPTIONS', 'Значения списка бывают только у списка и решения');
    const label = trimmed(input.label);
    if (!label) throw badRequest('EMPTY_LABEL', 'Укажите значение');
    await assertOptionFree(tx, fieldId, label);
    const max = await tx.registerFieldOption.aggregate({ where: { fieldId }, _max: { sortOrder: true } });
    const o = await tx.registerFieldOption.create({ data: { fieldId, label, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
    await auditSettings(tx, actor, {
      action: 'register.option.created', entity: 'register_option', entityId: o.id,
      summary: `Реестр «${reg.name}», поле «${field.label}»: добавлено значение «${label}»`,
    });
    return loadRegister(tx, reg.id);
  });
}

export async function updateOption(db: Db, actor: Actor, optionId: string, input: { version: number; label?: string; isClosed?: boolean }) {
  return withTx(db, async (tx) => {
    const { reg, field, option } = await getOption(tx, optionId);
    assertNotArchived(reg);
    if (input.version !== option.version) throw versionConflict();
    const data: Prisma.RegisterFieldOptionUpdateManyMutationInput = {};
    const changes: string[] = [];
    if (input.label !== undefined && trimmed(input.label) !== option.label) {
      if (!trimmed(input.label)) throw badRequest('EMPTY_LABEL', 'Укажите значение');
      await assertOptionFree(tx, field.id, trimmed(input.label), optionId);
      data.label = trimmed(input.label);
      changes.push(`«${option.label}» → «${data.label}»`);
    }
    if (input.isClosed !== undefined && input.isClosed !== option.isClosed) {
      assertNotSystemOption(option, 'сделать открытым или закрытым');
      if (!field.isStatus) throw badRequest('NOT_STATUS', 'Признак закрытого статуса есть только у поля статуса');
      data.isClosed = input.isClosed;
      changes.push(`«${option.label}» ${input.isClosed ? 'закрывает запись' : 'больше не закрывает запись'}`);
    }
    if (!changes.length) return reg;
    const res = await tx.registerFieldOption.updateMany({ where: { id: optionId, version: input.version }, data: { ...data, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerFieldOption.findFirst({ where: { id: optionId, deletedAt: null } }), 'Значение списка');
    const after = await loadRegister(tx, reg.id);
    // Переименование: ссылки по id не меняются, обновляется только поиск.
    if (data.label) await recomputeSearch(tx, after, { values: { path: [field.id], equals: optionId } });
    await auditSettings(tx, actor, {
      action: 'register.option.updated', entity: 'register_option', entityId: optionId,
      summary: `Реестр «${reg.name}», поле «${field.label}»: ${changes.join(', ')}`,
    });
    return after;
  });
}

export async function moveOption(db: Db, actor: Actor, optionId: string, direction: 'up' | 'down') {
  return withTx(db, async (tx) => {
    const { reg, field, option } = await getOption(tx, optionId);
    assertNotArchived(reg);
    const list = field.options;
    const i = list.findIndex((o) => o.id === optionId);
    const j = direction === 'up' ? i - 1 : i + 1;
    const other = list[j];
    if (!other) return reg;
    const order = list.map((o) => o.id);
    [order[i], order[j]] = [other.id, optionId];
    for (const [k, id] of order.entries()) await tx.registerFieldOption.update({ where: { id }, data: { sortOrder: k + 1 } });
    await auditSettings(tx, actor, {
      action: 'register.option.moved', entity: 'register_option', entityId: optionId,
      summary: `Реестр «${reg.name}», поле «${field.label}»: «${option.label}» перемещено ${direction === 'up' ? 'выше' : 'ниже'}`,
    });
    return loadRegister(tx, reg.id);
  });
}

export async function setOptionArchived(db: Db, actor: Actor, optionId: string, version: number, archived: boolean) {
  return withTx(db, async (tx) => {
    const { reg, field, option } = await getOption(tx, optionId);
    assertNotArchived(reg);
    if (option.archived === archived) {
      if (option.version !== version) throw versionConflict();
      return reg;
    }
    if (archived) assertNotSystemOption(option, 'отправить в архив');
    if (archived && field.options.filter((o) => !o.archived).length <= 1) {
      throw conflict('LAST_OPTION', 'В списке должно остаться хотя бы одно активное значение');
    }
    const res = await tx.registerFieldOption.updateMany({ where: { id: optionId, version }, data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerFieldOption.findFirst({ where: { id: optionId, deletedAt: null } }), 'Значение списка');
    await auditSettings(tx, actor, {
      action: archived ? 'register.option.archived' : 'register.option.restored', entity: 'register_option', entityId: optionId,
      summary: `Реестр «${reg.name}», поле «${field.label}»: «${option.label}» ${archived ? 'в архиве — записи его сохранят' : 'снова доступно для выбора'}`,
    });
    return loadRegister(tx, reg.id);
  });
}

/** Удалить можно только значение, которое ни в одной записи, решении и правиле не используется. */
export async function deleteOption(db: Db, actor: Actor, optionId: string, version: number) {
  return withTx(db, async (tx) => {
    const { reg, field, option } = await getOption(tx, optionId);
    assertNotArchived(reg);
    assertNotSystemOption(option, 'удалить');
    const used = await optionUsage(tx, field.id, optionId);
    if (used > 0) throw conflict('IN_USE', `«${option.label}» используется (${used}). Отправьте значение в архив`);
    if (reg.fields.some((f) => isDueRule(f.calcRule) && f.calcRule.byFieldId === field.id && optionId in f.calcRule.days)) {
      throw conflict('CALC_DEPENDENCY', `Для «${option.label}» задан срок в правиле вычисляемого поля — сначала измените правило`);
    }
    if (field.options.filter((o) => !o.archived && o.id !== optionId).length === 0) {
      throw conflict('LAST_OPTION', 'В списке должно остаться хотя бы одно активное значение');
    }
    const res = await tx.registerFieldOption.updateMany({ where: { id: optionId, version }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.registerFieldOption.findFirst({ where: { id: optionId, deletedAt: null } }), 'Значение списка');
    await auditSettings(tx, actor, {
      action: 'register.option.deleted', entity: 'register_option', entityId: optionId,
      summary: `Реестр «${reg.name}», поле «${field.label}»: удалено значение «${option.label}»`,
    });
    return loadRegister(tx, reg.id);
  });
}
