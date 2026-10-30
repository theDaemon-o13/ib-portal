// Чистая логика раздела «Уязвимости»: подписи, сводки по группам, выбор строк импорта, адрес экрана.
import type { NodeStats, RecordState, ScanSummary, VulnGroup } from '../../api/vulns';

export const STATE_LABELS: Record<RecordState, { label: string; tone: string }> = {
  overdue: { label: 'Просрочена', tone: 'crit' },
  not_handed: { label: 'Не передано ИКТ', tone: 'high' },
  in_work: { label: 'В работе', tone: 'acc' },
  fixed: { label: 'Устранена', tone: 'low' },
  accepted: { label: 'Риск принят', tone: '' },
};

export const CRIT_TONE: Record<string, string> = { critical: 'crit', high: 'high', medium: 'med', low: 'low' };

export const STATE_FILTERS = [
  ['open', 'Открытые'], ['overdue', 'Просроченные'], ['not_handed', 'Не передано ИКТ'], ['fixed', 'Устранённые'], ['all', 'Все'],
] as const;

export interface Totals { open: number; overdue: number; critical: number; notHandedOver: number }

export function sumStats(list: readonly Pick<NodeStats, keyof Totals>[]): Totals {
  return list.reduce<Totals>((a, s) => ({
    open: a.open + s.open, overdue: a.overdue + s.overdue, critical: a.critical + s.critical, notHandedOver: a.notHandedOver + s.notHandedOver,
  }), { open: 0, overdue: 0, critical: 0, notHandedOver: 0 });
}

export const groupStats = (g: VulnGroup, stats: readonly NodeStats[]) => stats.filter((s) => g.nodes.some((n) => n.id === s.nodeId));

/** Последний скан среди узлов группы. */
export function lastScanOf(list: readonly NodeStats[]): NodeStats['lastScan'] {
  return list.map((s) => s.lastScan).filter((s): s is NonNullable<NodeStats['lastScan']> => !!s).sort((a, b) => b.scanDate.localeCompare(a.scanDate))[0] ?? null;
}

export type ImportGroup = 'new' | 'reopened' | 'changed' | 'gone';

export type Selection = Record<ImportGroup, Set<string>>;

/** По умолчанию: новые, повторные и изменившиеся выбраны, пропавшие — нет (процедура: устранение подтверждает сотрудник). */
export function defaultSelection(s: ScanSummary): Selection {
  const keys = (g: ImportGroup) => s.groups[g].map((i) => i.key);
  return { new: new Set(keys('new')), reopened: new Set(keys('reopened')), changed: new Set(keys('changed')), gone: new Set() };
}

export function toggleOne(sel: Selection, group: ImportGroup, key: string): Selection {
  const next = new Set(sel[group]);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return { ...sel, [group]: next };
}

export function toggleAll(sel: Selection, group: ImportGroup, s: ScanSummary): Selection {
  const all = s.groups[group].map((i) => i.key);
  return { ...sel, [group]: sel[group].size === all.length ? new Set<string>() : new Set(all) };
}

export const selectionBody = (sel: Selection) => ({ new: [...sel.new], reopened: [...sel.reopened], changed: [...sel.changed], gone: [...sel.gone] });

/** Строка кнопки применения: что будет сделано. */
export function applyLabel(sel: Selection): string {
  const parts = [
    sel.new.size ? `новых ${sel.new.size}` : '',
    sel.reopened.size ? `повторно ${sel.reopened.size}` : '',
    sel.changed.size ? `обновить ${sel.changed.size}` : '',
    sel.gone.size ? `устранено ${sel.gone.size}` : '',
  ].filter(Boolean);
  return parts.length ? `Загрузить: ${parts.join(', ')}` : 'Сохранить скан без изменений в реестре';
}

export type VulnView =
  | { kind: 'root' }
  | { kind: 'group'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'scan'; id: string };

export function parseView(splat: string): VulnView {
  const [kind, id] = splat.split('/');
  if (id && /^[0-9a-f-]{36}$/i.test(id) && (kind === 'group' || kind === 'node' || kind === 'scan')) return { kind, id };
  return { kind: 'root' };
}

export const viewPath = (v: VulnView) => (v.kind === 'root' ? '/vulns' : `/vulns/${v.kind}/${v.id}`);

export function dueHint(due: string | null, today: string, extended: boolean): { text: string; tone: '' | 'over' | 'ext' } {
  if (!due) return { text: 'не начался', tone: '' };
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
  if (days < 0) return { text: `просрочено на ${-days} дн.`, tone: 'over' };
  const base = days === 0 ? 'сегодня' : `через ${days} дн.`;
  return extended ? { text: `${base} · продлён`, tone: 'ext' } : { text: base, tone: '' };
}
