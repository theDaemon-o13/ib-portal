// Однократно: системный «Реестр уязвимостей» и правила п. 7.4 (отметка в seed_markers).
// Удалённое или изменённое администратором seed не восстанавливает.
import type { Prisma } from '../../src/generated/prisma/client.js';
import { compactSettings, readSettings, TEXT_MAX_MULTILINE } from '../../src/lib/field-settings.js';
import { CRIT_KEYS } from '../../src/lib/vuln-score.js';
import { DUE_DAYS, VULN_FIELDS, VULN_REGISTER_KEY, type VulnFieldKey } from '../../src/modules/vulns/definition.js';
import type { Values } from '../../src/lib/register-values.js';
import { loadRegister, loadUsers, searchTextOf, userIdsIn } from '../../src/modules/registers/definition.js';
import { deptKey } from '../../src/modules/vulns/scan-parser.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

const NAME = 'Реестр уязвимостей';

export async function seedVulns(tx: Tx): Promise<void> {
  await once(tx, 'system.register.vulns.v1', async () => {
    if (await tx.register.findUnique({ where: { systemKey: VULN_REGISTER_KEY } })) return 'Реестр уязвимостей уже есть';
    // Имя реестра уникально среди неархивных: если администратор уже завёл свой — системный получает пометку.
    const clash = await tx.register.findFirst({ where: { archivedAt: null, name: { equals: NAME, mode: 'insensitive' } } });
    const reg = await tx.register.create({
      data: {
        name: clash ? `${NAME} (системный)` : NAME,
        description: 'Уязвимости по отчётам сканера: оценка, критичность и сроки по процедуре управления уязвимостями (п. 7.1–7.4)',
        systemKey: VULN_REGISTER_KEY,
      },
    });
    const ids = {} as Record<VulnFieldKey, string>;
    const opts = {} as Record<string, string>;
    for (const [i, f] of VULN_FIELDS.entries()) {
      if (f.type === 'calc') continue; // правила вычисления — ниже, когда известны id полей и значений
      const created = await tx.registerField.create({
        data: {
          registerId: reg.id,
          label: f.label,
          type: f.type,
          systemKey: f.key,
          sortOrder: i + 1,
          isTitle: f.isTitle ?? false,
          isStatus: f.isStatus ?? false,
          analyticsRole: f.analyticsRole ?? null,
          catalogCode: f.catalogCode ?? null,
          options: f.options?.length
            ? { create: f.options.map((o, j) => ({ label: o.label, sortOrder: j + 1, isClosed: o.closed ?? false, systemKey: o.key ?? null })) }
            : undefined,
        },
        include: { options: true },
      });
      ids[f.key] = created.id;
      for (const o of created.options) if (o.systemKey) opts[`${f.key}.${o.systemKey}`] = o.id;
    }
    const sortOf = (key: VulnFieldKey) => VULN_FIELDS.findIndex((f) => f.key === key) + 1;
    const score = await tx.registerField.create({
      data: {
        registerId: reg.id, label: 'Оценка', type: 'calc', systemKey: 'score', sortOrder: sortOf('score'),
        calcRule: { kind: 'vuln_score', cvssFieldId: ids.cvss, exploitFieldId: ids.exploit, fixFieldId: ids.fix },
      },
    });
    const due = await tx.registerField.create({
      data: {
        registerId: reg.id, label: 'Срок устранения', type: 'calc', systemKey: 'due', sortOrder: sortOf('due'), analyticsRole: 'deadline',
        calcRule: {
          fromFieldId: ids.notified,
          byFieldId: ids.crit,
          days: Object.fromEntries(CRIT_KEYS.map((k) => [opts[`crit.${k}`] as string, DUE_DAYS[k]])),
          overrideFieldId: ids.newDue,
          overrideWhenFilledFieldId: ids.measures,
          shiftToWorkday: true,
          baseFieldId: ids.legacyDue,
          addDaysFieldId: ids.extDays,
        },
      },
    });
    ids.score = score.id;
    ids.due = due.id;

    // Метки — по id системных значений «Получателей уведомлений» (их seed создаёт раньше, ADR-0009).
    const label = async (key: string) => {
      const item = await tx.catalogItem.findUnique({ where: { catalogCode_systemKey: { catalogCode: 'notify_recipients', systemKey: key } } });
      if (!item) throw new Error(`нет системной метки ${key}`);
      return { kind: 'label', itemId: item.id };
    };
    const dikt = await label('dikt_head');
    const owner = await label('system_owner');
    const bank = await label('bank_management');
    const ib = await label('ib_head');
    const rules: { key: string; condition: Prisma.InputJsonValue; action: Prisma.InputJsonValue }[] = [
      {
        key: 'vuln.remind_before_due',
        condition: { kind: 'before', fieldId: ids.due, days: 3 },
        action: { eventType: 'remind', recipients: [{ kind: 'field', fieldId: ids.owner }, dikt] },
      },
      {
        key: 'vuln.overdue_notify',
        condition: { kind: 'overdue', fieldId: ids.due },
        action: { eventType: 'notify', recipients: [dikt, owner] },
      },
      {
        key: 'vuln.overdue_escalate',
        condition: { kind: 'overdue', fieldId: ids.due, workdays: 10, unlessFilledFieldId: ids.measures },
        action: { eventType: 'escalate', recipients: [bank, ib] },
      },
    ];
    for (const r of rules) {
      await tx.registerAutomation.create({ data: { registerId: reg.id, systemKey: r.key, condition: r.condition, action: r.action } });
    }
    return `Системный «${reg.name}»: полей ${VULN_FIELDS.length}, правил автоматизации ${rules.length}`;
  });

  // Этап 5: поле «Система» в реестре, созданном на этапе 4 (в новом оно уже есть). Добавляется в конец.
  await once(tx, 'system.register.vulns.v2.system-field', async () => {
    const reg = await tx.register.findUnique({ where: { systemKey: VULN_REGISTER_KEY } });
    if (!reg) return 'Реестра уязвимостей нет — поле «Система» не нужно';
    if (await tx.registerField.findFirst({ where: { registerId: reg.id, systemKey: 'system', deletedAt: null } })) return 'Поле «Система» уже есть';
    const spec = VULN_FIELDS.find((f) => f.key === 'system');
    if (!spec) throw new Error('нет описания поля «Система»');
    const max = await tx.registerField.aggregate({ where: { registerId: reg.id }, _max: { sortOrder: true } });
    // Название свободно? Если администратор уже завёл своё «Система» — системное получает пометку.
    const clash = await tx.registerField.findFirst({ where: { registerId: reg.id, deletedAt: null, label: { equals: spec.label, mode: 'insensitive' } } });
    await tx.registerField.create({
      data: {
        registerId: reg.id, label: clash ? `${spec.label} (справочник)` : spec.label, type: 'catalog', catalogCode: spec.catalogCode ?? null,
        systemKey: 'system', sortOrder: (max._max.sortOrder ?? 0) + 1, analyticsRole: spec.analyticsRole ?? null,
      },
    });
    return `«${reg.name}»: добавлено поле «Система» (справочник «Системы»)`;
  });

  // Релиз 1.1.0: «Комментарий ДИКТ» и «Компенсирующие меры» — многострочный текст (до 20 000 символов).
  // Поля ищутся по системному ключу, не по названию; значения записей не меняются. Снять флаг можно в конструкторе.
  await once(tx, 'system.register.vulns.v3.multiline-text', async () => {
    const reg = await tx.register.findUnique({ where: { systemKey: VULN_REGISTER_KEY } });
    if (!reg) return 'Реестра уязвимостей нет — многострочные поля не нужны';
    const fields = await tx.registerField.findMany({
      where: { registerId: reg.id, systemKey: { in: ['comment', 'measures'] }, type: 'text', deletedAt: null },
    });
    const done: string[] = [];
    for (const f of fields) {
      const before = readSettings(f.settings);
      if (before.text?.multiline) continue;
      const after = compactSettings({ ...before, text: { multiline: true } });
      await tx.registerField.update({ where: { id: f.id }, data: { settings: after as Prisma.InputJsonValue, version: { increment: 1 } } });
      await tx.auditLog.create({
        data: {
          userId: null, action: 'register.field.updated', entity: 'register_field', entityId: f.id,
          diff: {
            summary: `Seed 1.1.0: реестр «${reg.name}», поле «${f.label}»: многострочный текст (до ${TEXT_MAX_MULTILINE} символов)`,
            before: { settings: compactSettings(before) },
            after: { settings: after },
          } as Prisma.InputJsonValue,
        },
      });
      done.push(`«${f.label}»`);
    }
    return done.length ? `«${reg.name}»: многострочный текст — ${done.join(', ')}` : `«${reg.name}»: многострочные поля уже настроены`;
  });

  // Релиз 1.1.0, задача 4: сравнение отчёта сканера с реестром — ключ «CVE / БДУ + Пакет» (не уникален: закрытые
  // записи с той же парой бывают), область — «Система» или «Отчёт сканирования». Поля — по системному ключу.
  await once(tx, 'system.register.vulns.v4.compare', async () => {
    const reg = await tx.register.findUnique({ where: { systemKey: VULN_REGISTER_KEY } });
    if (!reg) return 'Реестра уязвимостей нет — настройки сравнения не нужны';
    if (reg.compareKeyFieldIds.length) return `«${reg.name}»: ключ сравнения уже задан`;
    const fields = await tx.registerField.findMany({ where: { registerId: reg.id, deletedAt: null, archivedAt: null, systemKey: { in: ['cve', 'pkg', 'system', 'report'] } } });
    const id = (key: string) => fields.find((f) => f.systemKey === key)?.id;
    const keyIds = [id('cve'), id('pkg')].filter((x): x is string => !!x);
    const scopeIds = [id('system'), id('report')].filter((x): x is string => !!x);
    if (keyIds.length < 2) return `«${reg.name}»: нет полей «CVE / БДУ» и «Пакет» — ключ сравнения не задан`;
    await tx.register.update({ where: { id: reg.id }, data: { compareKeyFieldIds: keyIds, compareScopeFieldIds: scopeIds, version: { increment: 1 } } });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'register.updated', entity: 'register', entityId: reg.id,
        diff: {
          summary: `Seed 1.1.0: «${reg.name}» — ключ сравнения «CVE / БДУ + Пакет», область — «Система» или «Отчёт сканирования»`,
          before: { compareKeyFieldIds: [], compareScopeFieldIds: [] }, after: { compareKeyFieldIds: keyIds, compareScopeFieldIds: scopeIds },
        },
      },
    });
    return `«${reg.name}»: настройки сравнения с реестром`;
  });

  // Релиз 1.1.0, этап Б.2: поле «Отдел» (из ячейки A1 листа «Хосты»). Дубли отчётов и «Обнаружений» — в пределах
  // отдела, область сравнения по умолчанию — отдел и система. Отдел заполняется у записей, загруженных из отчётов
  // (по названию отчёта в scan_reports); записи без отчёта остаются без отдела. Журнал — по каждой записи и сводный.
  await once(tx, 'system.register.vulns.v5.department', () => seedVulnDepartments(tx));

  // Релиз 1.5.0 (ADR-0030): служебные поля «Срок из прежнего реестра» и «Продлено, дн.» и правило срока с ними.
  await once(tx, 'system.register.vulns.v6.deadline-fields', () => seedVulnDeadlineFields(tx));
}

/** Шаг seed v6: поля добавляются в конец (в новом реестре они уже есть), правило срока получает их id. */
export async function seedVulnDeadlineFields(tx: Tx): Promise<string> {
  const reg = await tx.register.findUnique({ where: { systemKey: VULN_REGISTER_KEY } });
  if (!reg) return 'Реестра уязвимостей нет — поля срока не нужны';
  const ids: Partial<Record<'legacyDue' | 'extDays', string>> = {};
  const added: string[] = [];
  for (const key of ['legacyDue', 'extDays'] as const) {
    const have = await tx.registerField.findFirst({ where: { registerId: reg.id, systemKey: key, deletedAt: null } });
    if (have) {
      ids[key] = have.id;
      continue;
    }
    const spec = VULN_FIELDS.find((f) => f.key === key);
    if (!spec) throw new Error(`нет описания поля ${key}`);
    const max = await tx.registerField.aggregate({ where: { registerId: reg.id }, _max: { sortOrder: true } });
    // Название свободно? Если администратор уже завёл поле с таким названием — системное получает пометку.
    const clash = await tx.registerField.findFirst({ where: { registerId: reg.id, deletedAt: null, label: { equals: spec.label, mode: 'insensitive' } } });
    const f = await tx.registerField.create({
      data: { registerId: reg.id, label: clash ? `${spec.label} (портал)` : spec.label, type: spec.type, systemKey: key, sortOrder: (max._max.sortOrder ?? 0) + 1 },
    });
    ids[key] = f.id;
    added.push(`«${f.label}»`);
  }
  const due = await tx.registerField.findFirst({ where: { registerId: reg.id, systemKey: 'due', deletedAt: null } });
  if (!due?.calcRule) throw new Error('нет системного поля «Срок устранения»');
  const before = due.calcRule as Record<string, unknown>;
  if (before.baseFieldId === ids.legacyDue && before.addDaysFieldId === ids.extDays) {
    return added.length ? `«${reg.name}»: добавлены поля ${added.join(', ')}` : `«${reg.name}»: поля срока уже настроены`;
  }
  const after = { ...before, baseFieldId: ids.legacyDue, addDaysFieldId: ids.extDays };
  await tx.registerField.update({ where: { id: due.id }, data: { calcRule: after as Prisma.InputJsonValue, version: { increment: 1 } } });
  await tx.auditLog.create({
    data: {
      userId: null, action: 'register.field.updated', entity: 'register_field', entityId: due.id,
      diff: {
        summary: `Seed 1.5.0: «${reg.name}», поле «${due.label}»: срок = срок из прежнего реестра или передача ИКТ + дни, плюс продления${added.length ? `; добавлены поля ${added.join(', ')}` : ''}`,
        before: { calcRule: before }, after: { calcRule: after },
      } as Prisma.InputJsonValue,
    },
  });
  return `«${reg.name}»: поля срока ${added.length ? added.join(', ') : 'уже были'}, правило «${due.label}» — с продлениями и сроком из прежнего реестра`;
}

/** Шаг seed v5 (отдельно — для теста заполнения у записей, загруженных до 1.1.0). Повторный вызов ничего не меняет. */
export async function seedVulnDepartments(tx: Tx): Promise<string> {
  const row = await tx.register.findUnique({ where: { systemKey: VULN_REGISTER_KEY } });
  if (!row) return 'Реестра уязвимостей нет — поле «Отдел» не нужно';
  let field = await tx.registerField.findFirst({ where: { registerId: row.id, systemKey: 'department', deletedAt: null } });
  if (!field) {
    const spec = VULN_FIELDS.find((f) => f.key === 'department');
    if (!spec) throw new Error('нет описания поля «Отдел»');
    const max = await tx.registerField.aggregate({ where: { registerId: row.id }, _max: { sortOrder: true } });
    const clash = await tx.registerField.findFirst({ where: { registerId: row.id, deletedAt: null, label: { equals: spec.label, mode: 'insensitive' } } });
    field = await tx.registerField.create({
      data: {
        registerId: row.id, label: clash ? `${spec.label} (отчёт)` : spec.label, type: 'select', systemKey: 'department',
        sortOrder: (max._max.sortOrder ?? 0) + 1, analyticsRole: spec.analyticsRole ?? null,
      },
    });
  }
  // Значения — отделы загруженных отчётов: одно на отдел (без регистра, пробелов, «ё»), подпись — как в отчёте.
  const reports = await tx.scanReport.findMany({ where: { registerId: row.id }, select: { label: true, department: true }, orderBy: { createdAt: 'asc' } });
  const existing = await tx.registerFieldOption.findMany({ where: { fieldId: field.id, deletedAt: null } });
  const byKey = new Map(existing.map((o) => [deptKey(o.label), o.id]));
  let options = 0;
  for (const r of reports) {
    const k = deptKey(r.department);
    if (!k || byKey.has(k)) continue;
    const o = await tx.registerFieldOption.create({ data: { fieldId: field.id, label: r.department.trim().slice(0, 200), sortOrder: byKey.size + 1 } });
    byKey.set(k, o.id);
    options++;
  }
  const deptOfReport = new Map(reports.map((r) => [r.label, byKey.get(deptKey(r.department)) ?? null]));

  const reg = await loadRegister(tx, row.id);
  const reportField = reg.fields.find((f) => f.systemKey === 'report');
  const deptField = reg.fields.find((f) => f.id === field.id);
  if (!reportField || !deptField) throw new Error('нет полей «Отчёт сканирования» или «Отдел»');
  const rows = await tx.registerRecord.findMany({ where: { registerId: row.id, deletedAt: null }, select: { id: true, number: true, values: true }, orderBy: { number: 'asc' } });
  let filled = 0;
  for (const r of rows) {
    const values = r.values as Values;
    if (values[deptField.id] !== undefined) continue;
    const reportLabel = reportField.options.find((o) => o.id === values[reportField.id])?.label;
    const deptId = reportLabel ? deptOfReport.get(reportLabel) : null;
    if (!deptId) continue;
    const after: Values = { ...values, [deptField.id]: deptId };
    const users = await loadUsers(tx, userIdsIn(reg, [after]));
    await tx.registerRecord.update({
      where: { id: r.id },
      data: { values: after as Prisma.InputJsonValue, searchText: searchTextOf(reg, r.number, after, users), version: { increment: 1 } },
    });
    const deptLabel = deptField.options.find((o) => o.id === deptId)?.label ?? '';
    await tx.auditLog.create({
      data: {
        userId: null, action: 'register_record.updated', entity: 'register_record', entityId: r.id,
        diff: {
          summary: `«${reg.name}», запись #${r.number}: «${deptField.label}» — «${deptLabel}» по отчёту «${reportLabel}» (обновление 1.1.0)`,
          after: { changes: [{ fieldId: deptField.id, label: deptField.label, from: '', to: deptLabel }], via: 'seed' },
        } as Prisma.InputJsonValue,
      },
    });
    filled++;
  }

  const system = reg.fields.find((f) => f.systemKey === 'system' && !f.archived);
  const scope = [deptField.id, ...(system ? [system.id] : []), reportField.id];
  await tx.register.update({ where: { id: row.id }, data: { compareScopeFieldIds: scope, version: { increment: 1 } } });
  await tx.auditLog.create({
    data: {
      userId: null, action: 'register.updated', entity: 'register', entityId: row.id,
      diff: {
        summary: `Seed 1.1.0: «${reg.name}» — поле «${deptField.label}»: значений ${options}, заполнено у записей ${filled}; область сравнения — отдел, система, отчёт`,
        before: { compareScopeFieldIds: reg.compareScopeFieldIds }, after: { fieldId: deptField.id, options, filled, compareScopeFieldIds: scope },
      } as Prisma.InputJsonValue,
    },
  });
  return `«${reg.name}»: поле «${deptField.label}» — значений ${options}, заполнено у записей ${filled}`;
}
