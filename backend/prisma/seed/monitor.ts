// Релиз 1.1.0, задача 6: слайды экрана мониторинга по умолчанию — повторяют прежний экран (однократно).
// Дальше набор меняет администратор (settings.manage); удалённые или изменённые seed не восстанавливает.
import type { Prisma } from '../../src/generated/prisma/client.js';
import { WALL_KPIS, type SlideFilter, type SlideKind } from '../../src/modules/monitor/slides.service.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

const DEFAULT_SLIDES: { kind: SlideKind; title: string; filter: SlideFilter }[] = [
  { kind: 'kpis', title: 'Ключевые показатели', filter: { kpis: WALL_KPIS } },
  { kind: 'vulns', title: 'Уязвимости: дни до срока устранения', filter: { period: 'all' } },
  { kind: 'tasks', title: 'Задачи: сроки', filter: { period: 'all' } },
  { kind: 'documents', title: 'Документы: срок пересмотра', filter: { period: 'all' } },
  { kind: 'risks', title: 'Решения ОУР: пересмотр', filter: { period: 'all' } },
  { kind: 'evidence', title: 'Доказательства: срок действия', filter: { period: 'all' } },
];

export async function seedMonitorSlides(tx: Tx): Promise<void> {
  await once(tx, 'monitor.slides.v1', async () => {
    if (await tx.monitorSlide.count()) return 'Слайды мониторинга уже есть';
    for (const [i, s] of DEFAULT_SLIDES.entries()) {
      await tx.monitorSlide.create({ data: { kind: s.kind, title: s.title, filter: s.filter as Prisma.InputJsonValue, seconds: 12, sortOrder: i + 1 } });
    }
    return `Экран мониторинга: слайдов по умолчанию — ${DEFAULT_SLIDES.length}`;
  });
}
