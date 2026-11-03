// «Настройки → Параметры портала» (релиз 1.6.0): ключи app_settings этого релиза, только супер-администратор.
// У каждого ключа своя схема zod: неверное значение не сохраняется. Нет строки в базе — действует значение по умолчанию;
// «Сбросить к умолчанию» удаляет строку. Изменение — в журнале (было → стало).
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, notFound, versionConflict } from '../../lib/errors.js';
import { assetDefaults, assetSettingsView } from '../assets/service.js';
import { ASSET_SETTINGS_KEY } from '../assets/definition.js';
import { DEFAULT_SCAN_MAX_AGE_DAYS, VULN_SETTINGS_KEY } from '../vulns/profiles.js';
import { SYSTEM_TYPES_CATALOG } from '../vulns/groups.service.js';
import { auditSettings, type Actor } from './common.js';
import { DEFAULT_STAGE_DAYS, DOC_REVIEW_ROLE_KEY, DOC_STAGE_DAYS_KEY } from '../documents/status.js';

const text = (what: string, max = 200) => z.string().trim().min(1, `${what}: пустое значение`).max(max, `${what}: не длиннее ${max} символов`);
const uuid = (what: string) => z.string().uuid(`${what}: неверный идентификатор`);
const validRegex = (s: string) => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
};
const patterns = z.array(text('Шаблон имени').refine(validRegex, 'Шаблон имени: неверное регулярное выражение')).max(50);

const VulnsSchema = z.strictObject({
  scanMaxAgeDays: z.number({ error: 'Порог: нужно число дней' }).int('Порог: целое число дней').min(1, 'Порог: не меньше 1 дня').max(3650, 'Порог: не больше 3650 дней'),
  profileAliases: z.record(uuid('Тип систем'), z.array(text('Синоним', 100)).max(20, 'Синонимов у типа — не больше 20')),
});
const AssetsSchema = z.strictObject({
  significantLevelOptionIds: z.array(uuid('Категория')).max(20),
  dlpRegisterId: uuid('Реестр DLP').nullable(),
});
const MapSchema = z.record(text('Значение'), text('Значение'));
const days = (stage: string) => z.number({ error: `Этап ${stage}: нужно число рабочих дней` }).int(`Этап ${stage}: целое число дней`)
  .min(1, `Этап ${stage}: не меньше 1 дня`).max(60, `Этап ${stage}: не больше 60 дней`);
const StageDaysSchema = z.strictObject({ '11': days('11'), '12': days('12'), '13': days('13'), '15': days('15'), '16': days('16') });
const HostTypeSchema = z.strictObject({
  server: z.strictObject({ products: z.array(text('Продукт')).max(50), groups: z.array(text('Группа KSC')).max(50), namePatterns: patterns }),
  workstation: z.strictObject({ namePatterns: patterns }),
});

/** Написания ОС и типы хостов — общие, данных банка здесь нет. Таблица команд пуста: она заполняется на портале. */
const OS_NORMALIZATION = {
  'Linux Centos 7': 'CentOS 7', 'CentOS Linux 7 (Core)': 'CentOS 7', 'CentOS Linux 7': 'CentOS 7',
  'Linux Debian 11 (Bullseye)': 'Debian 11', 'Debian GNU/Linux 11 (bullseye)': 'Debian 11', 'Linux/Debian 11 (bullseye)': 'Debian 11', 'Linux/Debian 11': 'Debian 11',
  'Linux/Ubuntu 22.04.3 LTS': 'Ubuntu 22.04', 'Linux/Ubuntu': 'Ubuntu',
};
const HOST_TYPE_RULES = {
  server: { products: ['для Windows Server'], groups: ['Servers'], namePatterns: ['SRV', 'SERVER', '^DC\\d'] },
  workstation: { namePatterns: ['(NB|PC|MAC)\\d*$'] },
};

export type ParamForm = 'vulns' | 'assets' | 'lines' | 'text' | 'json' | 'stageDays' | 'reviewRole';

interface ParamDef {
  key: string;
  title: string;
  description: string;
  form: ParamForm;
  schema: z.ZodType;
  defaults: (db: Db) => Promise<unknown>;
  /** Проверка по данным портала: схема этого не видит. */
  check?: (db: Db, value: never) => Promise<void>;
}

export const PORTAL_PARAMS: readonly ParamDef[] = [
  {
    key: VULN_SETTINGS_KEY, title: 'Уязвимости: регулярность и синонимы профилей', form: 'vulns',
    description: 'Порог «Узлов без скана дольше порога» и другие названия профиля в именах файлов отчётов.',
    schema: VulnsSchema,
    defaults: async () => ({ scanMaxAgeDays: DEFAULT_SCAN_MAX_AGE_DAYS, profileAliases: {} }),
    check: async (db, value: z.infer<typeof VulnsSchema>) => {
      const ids = Object.keys(value.profileAliases);
      const found = await db.catalogItem.count({ where: { id: { in: ids }, catalogCode: SYSTEM_TYPES_CATALOG, deletedAt: null } });
      if (found !== ids.length) throw badRequest('BAD_PARAM', 'Синонимы: такого типа нет в справочнике «Типы систем»');
    },
  },
  {
    key: ASSET_SETTINGS_KEY, title: 'Активы: значимые категории и источники сверки', form: 'assets',
    description: 'Какие категории критичности считаются значимыми в сверке и самооценке, где искать агенты DLP.',
    schema: AssetsSchema,
    defaults: assetDefaults,
    check: async (db, value: z.infer<typeof AssetsSchema>) => {
      const view = await assetSettingsView(db);
      const known = (ids: string[], options: { id: string }[]) => ids.every((id) => options.some((o) => o.id === id));
      if (!known(value.significantLevelOptionIds, view.levelOptions)) throw badRequest('BAD_PARAM', 'Такой категории критичности нет');
      if (value.dlpRegisterId && !(await db.register.findFirst({ where: { id: value.dlpRegisterId, archivedAt: null, deletedAt: null }, select: { id: true } }))) {
        throw badRequest('BAD_PARAM', 'Такого реестра нет или он в архиве');
      }
    },
  },
  {
    key: 'assets.teamProducts', title: 'Активы: команды → продукты', form: 'json',
    description: 'Импорт реестра сервисов: имя команды в файле → продукт. Команда без соответствия — продукт с её именем. Формат: { "Команда": "Продукт" }.',
    schema: MapSchema, defaults: async () => ({}),
  },
  {
    key: 'assets.osNormalization', title: 'Активы: нормализация ОС', form: 'json',
    description: 'Написания ОС и ПО → единый вид. Формат: { "Linux Centos 7": "CentOS 7" }.',
    schema: MapSchema, defaults: async () => OS_NORMALIZATION,
  },
  {
    key: 'assets.unsupportedOs', title: 'Активы: неподдерживаемые ОС', form: 'lines',
    description: 'Сверка раздела 8.2. По одной ОС на строку, в нормализованном виде.',
    schema: z.array(text('ОС')).max(200), defaults: async () => ['CentOS 7', 'Debian 11'],
  },
  {
    key: 'assets.hostTypeRules', title: 'Активы: правила типа хоста', form: 'json',
    description: 'Тип нового хоста из отчёта Kaspersky. namePatterns — регулярные выражения по имени без учёта регистра; ни одно правило не подошло — «Другое».',
    schema: HostTypeSchema, defaults: async () => HOST_TYPE_RULES,
  },
  {
    key: 'assets.minProtectionVersion', title: 'Активы: минимальная версия защиты', form: 'text',
    description: 'Например, 12.5. Пусто — проверка показывает «Нет данных».',
    schema: z.string().trim().max(50).regex(/^(\d+(\.\d+)*)?$/, 'Версия — числа через точку, например 12.5'),
    defaults: async () => '',
  },
  {
    key: DOC_STAGE_DAYS_KEY, title: 'Документы: сроки этапов', form: 'stageDays',
    description: 'Срок задачи этапа маршрута в рабочих днях от дня, когда документ пришёл на этап. Этап 14 — ближайший срок ответственного лица, перевод — срок языка (задаются в карточке документа). Новое значение — для новых задач.',
    schema: StageDaysSchema, defaults: async () => ({ ...DEFAULT_STAGE_DAYS }),
  },
  {
    key: DOC_REVIEW_ROLE_KEY, title: 'Документы: роль проверки сотрудниками', form: 'reviewRole',
    description: 'Кто может взять общую задачу «Проверить документ» на этапе «Проверка сотрудниками»: активные пользователи с этой ролью и доступом к разделам ИБ, кроме автора. Роль не выбрана — все сотрудники ИБ. Список открытых задач меняется при следующем действии с документом.',
    schema: z.strictObject({ roleId: uuid('Роль').nullable() }), defaults: async () => ({ roleId: null }),
    check: async (db, value: { roleId: string | null }) => {
      if (value.roleId && !(await db.role.findUnique({ where: { id: value.roleId }, select: { id: true } }))) throw badRequest('BAD_PARAM', 'Такой роли нет');
    },
  },
];

/**
 * Значение параметра для кода: строка в базе, если она проходит схему, иначе значение по умолчанию.
 * Неверное значение сохранить нельзя, но строка могла остаться от прежней версии портала.
 */
export async function readPortalParam<T>(db: Db, key: string): Promise<T> {
  const def = paramOf(key);
  const row = await db.appSetting.findUnique({ where: { key } });
  const parsed = row ? def.schema.safeParse(row.value) : null;
  return (parsed?.success ? parsed.data : await def.defaults(db)) as T;
}

/** Своё сообщение схемы — как есть; стандартное у zod английское. */
function issueText(i: z.core.$ZodIssue): string {
  if (i.code === 'unrecognized_keys') return `лишнее поле ${i.keys.join(', ')}`;
  if (/[а-яё]/i.test(i.message)) return i.message;
  return i.path.length ? `поле ${i.path.join('.')}: неверное значение` : 'неверный формат значения';
}

function paramOf(key: string): ParamDef {
  const def = PORTAL_PARAMS.find((p) => p.key === key);
  if (!def) throw notFound('Параметр');
  return def;
}

async function view(db: Db, def: ParamDef) {
  const [row, defaults] = [await db.appSetting.findUnique({ where: { key: def.key } }), await def.defaults(db)];
  return {
    key: def.key, title: def.title, description: def.description, form: def.form,
    value: row ? row.value : defaults, defaultValue: defaults, isDefault: !row, version: row?.version ?? 0,
  };
}

export async function listPortalParams(db: Db) {
  const assets = await assetSettingsView(db);
  const types = await db.catalogItem.findMany({ where: { catalogCode: SYSTEM_TYPES_CATALOG, deletedAt: null, archivedAt: null }, orderBy: { sortOrder: 'asc' }, select: { id: true, value: true } });
  const registers = await db.register.findMany({ where: { archivedAt: null, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  const roles = await db.role.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
  const items = [];
  for (const def of PORTAL_PARAMS) items.push(await view(db, def));
  return {
    items,
    options: {
      levels: assets.levelOptions,
      systemTypes: types.map((t) => ({ id: t.id, label: t.value })), registers: registers.map((r) => ({ id: r.id, label: r.name })),
      roles: roles.map((r) => ({ id: r.id, label: r.name })),
    },
  };
}

export async function updatePortalParam(db: Db, actor: Actor, key: string, input: { value: unknown; version: number }) {
  const def = paramOf(key);
  const parsed = def.schema.safeParse(input.value);
  if (!parsed.success) throw badRequest('BAD_PARAM', `«${def.title}»: ${parsed.error.issues.map(issueText).join('; ')}`);
  return withTx(db, async (tx) => {
    const before = await view(tx, def);
    if (before.version !== input.version) throw versionConflict();
    await def.check?.(tx, parsed.data as never);
    const value = parsed.data as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value, version: { increment: 1 } } });
    await auditSettings(tx, actor, {
      action: 'portal_param.updated', entity: 'app_setting', entityId: key, summary: `Параметры портала: изменено «${def.title}»`,
      before: { value: before.value, isDefault: before.isDefault }, after: { value },
    });
    return view(tx, def);
  });
}

export async function resetPortalParam(db: Db, actor: Actor, key: string, input: { version: number }) {
  const def = paramOf(key);
  return withTx(db, async (tx) => {
    const before = await view(tx, def);
    if (before.version !== input.version) throw versionConflict();
    if (before.isDefault) return before;
    await tx.appSetting.delete({ where: { key } });
    await auditSettings(tx, actor, {
      action: 'portal_param.reset', entity: 'app_setting', entityId: key, summary: `Параметры портала: «${def.title}» сброшено к значению по умолчанию`,
      before: { value: before.value, isDefault: false }, after: { value: before.defaultValue as Prisma.InputJsonValue, isDefault: true },
    });
    return view(tx, def);
  });
}
