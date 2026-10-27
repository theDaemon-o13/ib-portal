// Однократно: системный «Реестр рисков ИБ» по прототипу (отметка в seed_markers), без записей.
// Отдельно от рисков банка, связь с реестром ОУР — по номеру; решение ОУР вносится только с документом (этап 7).
// Удалённое или изменённое администратором seed не восстанавливает.
import type { Prisma } from '@prisma/client';
import { RISK_FIELDS, RISK_REGISTER_KEY, type RiskFieldKey } from '../../src/modules/risks/definition.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

const NAME = 'Реестр рисков ИБ';

export async function seedRisks(tx: Tx): Promise<void> {
  await once(tx, 'system.register.risks.v1', async () => {
    if (await tx.register.findUnique({ where: { systemKey: RISK_REGISTER_KEY } })) return 'Реестр рисков ИБ уже есть';
    // Если администратор уже завёл реестр с таким именем, системный получает пометку.
    const clash = await tx.register.findFirst({ where: { archivedAt: null, name: { equals: NAME, mode: 'insensitive' } } });
    const reg = await tx.register.create({
      data: {
        name: clash ? `${NAME} (системный)` : NAME,
        description: 'Риски информационной безопасности — отдельно от реестра операционных рисков банка. '
          + 'С реестром ОУР связаны номером; решение принимает ОУР, ИБ фиксирует его только с документом ОУР',
        systemKey: RISK_REGISTER_KEY,
      },
    });
    const ids = {} as Record<RiskFieldKey, string>;
    for (const [i, f] of RISK_FIELDS.entries()) {
      const created = await tx.registerField.create({
        data: {
          registerId: reg.id,
          label: f.label,
          type: f.type,
          systemKey: f.system ? f.key : null,
          sortOrder: i + 1,
          isTitle: f.isTitle ?? false,
          analyticsRole: f.analyticsRole ?? null,
          catalogCode: f.catalogCode ?? null,
          options: f.options?.length ? { create: f.options.map((label, j) => ({ label, sortOrder: j + 1 })) } : undefined,
        },
      });
      ids[f.key] = created.id;
    }
    const ibHead = await tx.catalogItem.findUnique({ where: { catalogCode_systemKey: { catalogCode: 'notify_recipients', systemKey: 'ib_head' } } });
    if (!ibHead) throw new Error('нет системной метки ib_head');
    // Правила прототипа «вернуть статус» и «напомнить ОУР письмом» движок не выполняет (только события → задачи;
    // письма — этап 9): вместо них напоминание владельцу риска и уведомление начальнику ИБ. Правила обычные — их можно менять.
    const rules: { condition: Prisma.InputJsonValue; action: Prisma.InputJsonValue }[] = [
      {
        condition: { kind: 'before', fieldId: ids.reviewDue, days: 30 },
        action: { eventType: 'remind', recipients: [{ kind: 'field', fieldId: ids.owner }] },
      },
      {
        condition: { kind: 'overdue', fieldId: ids.reviewDue },
        action: { eventType: 'notify', recipients: [{ kind: 'field', fieldId: ids.owner }, { kind: 'label', itemId: ibHead.id, label: ibHead.value }] },
      },
    ];
    for (const r of rules) await tx.registerAutomation.create({ data: { registerId: reg.id, condition: r.condition, action: r.action } });
    return `Системный «${reg.name}»: полей ${RISK_FIELDS.length}, правил автоматизации ${rules.length}`;
  });
}
