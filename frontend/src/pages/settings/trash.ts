// Тексты удаления и корзины (1.6.1, ADR-0033): последствия, отказы, сводка события. Чистые функции — под unit-тест.
import type { RegisterDeletePreview } from '../../api/registers';
import type { Deletion } from '../../api/trash';
import type { DeletePreview } from '../../api/vulns';
import { plural } from '../registers/compare';

const recs = (n: number) => plural(n, 'запись', 'записи', 'записей');
const scans = (n: number) => plural(n, 'скан', 'скана', 'сканов');
const types = (n: number) => plural(n, 'тип систем', 'типа систем', 'типов систем');

export function registerDeleteLines(p: RegisterDeletePreview): string[] {
  return [
    `Реестр «${p.name}» пропадёт из списка реестров, дашборда и поиска`,
    `Скроются ${recs(p.counts.records)} и ${plural(p.counts.automations, 'автоматизация', 'автоматизации', 'автоматизаций')}`,
    'Задачи автоматизаций останутся — с пометкой «реестр удалён»',
  ];
}

export function registerDeleteBlock(p: RegisterDeletePreview): string | null {
  if (p.system) return `«${p.name}» — системный реестр: на него опираются разделы портала, удалить его нельзя`;
  if (p.linkedBy.length) {
    return `На реестр ссылаются поля других реестров: ${p.linkedBy.map((l) => `«${l.register}» → «${l.field}»`).join(', ')}. Удалите или переведите эти поля, затем удалите реестр`;
  }
  return null;
}

/** Группа или тип: что скроется. Открытые записи — отказ со списком типов. */
export function vulnDeleteLines(p: DeletePreview, group: boolean): string[] {
  return [
    group ? `Группа «${p.name}» и её ${types(p.counts.nodes)} пропадут из дерева и «Все группы»` : `«${p.name}» пропадёт из группы`,
    `Скроются ${recs(p.counts.records)} (устранённые и архивные) и ${scans(p.counts.scans)}`,
    'Продления сроков останутся в истории',
  ];
}

export function vulnDeleteBlock(p: DeletePreview): string | null {
  if (!p.blocked) return null;
  const list = p.nodes.filter((n) => n.open > 0).map((n) => `«${n.label}» — ${n.open}`).join(', ');
  return `Есть открытые записи (В работе, Просрочена, Не передано ИКТ): ${list}. Перенесите их или закройте, затем удалите`;
}

/** Что скрыто событием: «Группа · 2 типа систем, 90 записей, 1 скан». */
export function deletionCounts(d: Pick<Deletion, 'entity' | 'counts'>): string {
  const c = d.counts;
  const parts: string[] = [];
  if (c.nodes) parts.push(types(c.nodes));
  if (c.records !== undefined) parts.push(recs(c.records));
  if (c.scans) parts.push(scans(c.scans));
  if (c.automations) parts.push(plural(c.automations, 'автоматизация', 'автоматизации', 'автоматизаций'));
  return parts.join(', ');
}

export function deletionReason(d: Pick<Deletion, 'reasonLabel' | 'reason'>): string {
  return [d.reasonLabel, d.reason].filter(Boolean).join(': ') || 'причина не указана';
}
