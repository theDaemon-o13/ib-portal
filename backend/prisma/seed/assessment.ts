// Самооценка (этап Д, ADR-0025; 1.13.8, ADR-0050): методики из JSON рядом — cyber-express-v1 и cyber-express-v2
// (v1 + домен 11 «Контроль ИИ» вне итога). Каждая строка (код, версия) создаётся один раз и потом не перезаписывается —
// оценки работают со своим снимком. Активна одна: последняя версия списка; seed при каждом прогоне следит, чтобы
// активной была именно она (после отката на 1.13.7 и ручного возврата v1 повторное обновление снова включит v2).
import type { Prisma } from '../../src/generated/prisma/client.js';
import { SIGNATURE_DEFAULT, SIGNATURE_KEY } from '../../src/modules/assessments/presentation.js';
// JSON — частью сборки (resolveJsonModule): попадает в dist рядом с seed, в образе исходников нет.
import methodologyV1 from './assessment-methodology.json' with { type: 'json' };
import methodologyV2 from './assessment-methodology-v2.json' with { type: 'json' };

type Tx = Prisma.TransactionClient;

/** Версии по порядку; активной назначается последняя. */
export const METHODOLOGIES = [methodologyV1, methodologyV2] as const;
export const ACTIVE_METHODOLOGY = METHODOLOGIES[METHODOLOGIES.length - 1] as (typeof METHODOLOGIES)[number];

export async function seedAssessmentMethodology(tx: Tx): Promise<void> {
  // Подпись «Спроектировано» в презентации — один раз: изменённую в «Настройки → Презентация» seed не трогает.
  await tx.appSetting.upsert({ where: { key: SIGNATURE_KEY }, create: { key: SIGNATURE_KEY, value: SIGNATURE_DEFAULT }, update: {} });
  for (const content of METHODOLOGIES) {
    const found = await tx.assessmentMethodology.findUnique({ where: { code_version: { code: content.code, version: content.version } } });
    if (found) continue;
    const m = await tx.assessmentMethodology.create({
      data: { code: content.code, name: content.name, version: content.version, content: content as Prisma.InputJsonValue, isActive: false },
    });
    await tx.auditLog.create({
      data: {
        userId: null, action: 'assessment.methodology_loaded', entity: 'assessment_methodology', entityId: m.id,
        diff: { summary: `Самооценка: загружена методика «${content.name}», версия ${content.version} (${content.code})` },
      },
    });
    console.log(`Самооценка: методика ${content.code} v${content.version} загружена`);
  }
  await activateMethodology(tx);
}

/** Активной — последняя версия из seed; остальные выключаются. Повторный прогон ничего не меняет. */
async function activateMethodology(tx: Tx): Promise<void> {
  const target = await tx.assessmentMethodology.findUniqueOrThrow({
    where: { code_version: { code: ACTIVE_METHODOLOGY.code, version: ACTIVE_METHODOLOGY.version } },
  });
  const others = await tx.assessmentMethodology.findMany({ where: { isActive: true, id: { not: target.id } }, select: { id: true, code: true, version: true } });
  if (target.isActive && !others.length) return;
  // Сначала снять прежнюю: частичный уникальный индекс допускает одну активную на код.
  if (others.length) await tx.assessmentMethodology.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isActive: false } });
  await tx.assessmentMethodology.update({ where: { id: target.id }, data: { isActive: true } });
  const from = others.map((o) => `${o.code} v${o.version}`).join(', ') || '—';
  await tx.auditLog.create({
    data: {
      userId: null, action: 'assessment.methodology_activated', entity: 'assessment_methodology', entityId: target.id,
      diff: { summary: `Самооценка: активная методика — ${target.code} v${target.version} (была: ${from})`, from, to: `${target.code} v${target.version}` },
    },
  });
  console.log(`Самооценка: активная методика — ${target.code} v${target.version}`);
}
