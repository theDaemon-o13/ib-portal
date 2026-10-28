// Однократно: системный «Реестр уязвимостей» и правила п. 7.4 (отметка в seed_markers).
// Удалённое или изменённое администратором seed не восстанавливает.
import type { Prisma } from '../../src/generated/prisma/client.js';
import { compactSettings, readSettings, TEXT_MAX_MULTILINE } from '../../src/lib/field-settings.js';
import { CRIT_KEYS } from '../../src/lib/vuln-score.js';
import { DUE_DAYS, VULN_FIELDS, VULN_REGISTER_KEY, type VulnFieldKey } from '../../src/modules/vulns/definition.js';
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
}
