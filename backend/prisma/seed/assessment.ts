// Самооценка (этап Д, ADR-0025): методика cyber-express-v1 из assessment-methodology.json. Строка (код, версия)
// создаётся один раз и потом не перезаписывается — оценки работают со своим снимком. Активна одна версия на код.
import type { Prisma } from '../../src/generated/prisma/client.js';
// JSON — частью сборки (resolveJsonModule): попадает в dist рядом с seed, в образе исходников нет.
import methodology from './assessment-methodology.json' with { type: 'json' };

type Tx = Prisma.TransactionClient;

export async function seedAssessmentMethodology(tx: Tx): Promise<void> {
  const content = methodology;
  const found = await tx.assessmentMethodology.findUnique({ where: { code_version: { code: content.code, version: content.version } } });
  if (found) return;
  const active = await tx.assessmentMethodology.count({ where: { code: content.code, isActive: true } });
  const m = await tx.assessmentMethodology.create({
    data: { code: content.code, name: content.name, version: content.version, content: content as Prisma.InputJsonValue, isActive: active === 0 },
  });
  await tx.auditLog.create({
    data: {
      userId: null, action: 'assessment.methodology_loaded', entity: 'assessment_methodology', entityId: m.id,
      diff: { summary: `Самооценка: загружена методика «${content.name}», версия ${content.version}` },
    },
  });
  console.log(`Самооценка: методика ${content.code} v${content.version} загружена`);
}
