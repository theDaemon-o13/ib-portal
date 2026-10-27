// Однократно: системный «Реестр уязвимостей» и правила п. 7.4 (отметка в seed_markers).
// Удалённое или изменённое администратором seed не восстанавливает.
import type { Prisma } from '@prisma/client';
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

    const rules: { key: string; condition: Prisma.InputJsonValue; action: Prisma.InputJsonValue }[] = [
      {
        key: 'vuln.remind_before_due',
        condition: { kind: 'before', fieldId: ids.due, days: 3 },
        action: { eventType: 'remind', recipients: [{ kind: 'field', fieldId: ids.owner }, { kind: 'label', label: 'Руководитель ДИКТ' }] },
      },
      {
        key: 'vuln.overdue_notify',
        condition: { kind: 'overdue', fieldId: ids.due },
        action: { eventType: 'notify', recipients: [{ kind: 'label', label: 'Руководитель ДИКТ' }, { kind: 'label', label: 'Владелец системы' }] },
      },
      {
        key: 'vuln.overdue_escalate',
        condition: { kind: 'overdue', fieldId: ids.due, workdays: 10, unlessFilledFieldId: ids.measures },
        action: { eventType: 'escalate', recipients: [{ kind: 'label', label: 'Руководство Банка' }, { kind: 'label', label: 'Начальник ИБ' }] },
      },
    ];
    for (const r of rules) {
      await tx.registerAutomation.create({ data: { registerId: reg.id, systemKey: r.key, condition: r.condition, action: r.action } });
    }
    return `Системный «${reg.name}»: полей ${VULN_FIELDS.length}, правил автоматизации ${rules.length}`;
  });
}
