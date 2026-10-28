// Массовые действия с записями (релиз 1.1.0): выбор строк и тексты предпросмотра и итога. Чистые функции.
import type { BulkPreview, BulkResult, BulkSelection, RecordFilterParams } from '../../api/registers';

/** Выбор: отмеченные строки или «все N по фильтру» с исключёнными вручную. */
export type Picked =
  | { kind: 'ids'; ids: ReadonlySet<string> }
  | { kind: 'filter'; excluded: ReadonlySet<string> };

export const NOTHING: Picked = { kind: 'ids', ids: new Set() };

export function isPicked(p: Picked, id: string): boolean {
  return p.kind === 'ids' ? p.ids.has(id) : !p.excluded.has(id);
}

export function togglePicked(p: Picked, id: string): Picked {
  const flip = (s: ReadonlySet<string>) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  return p.kind === 'ids' ? { kind: 'ids', ids: flip(p.ids) } : { kind: 'filter', excluded: flip(p.excluded) };
}

/** Отметить или снять все строки страницы. */
export function pickPage(p: Picked, pageIds: readonly string[], on: boolean): Picked {
  if (p.kind === 'filter') {
    const excluded = new Set(p.excluded);
    for (const id of pageIds) {
      if (on) excluded.delete(id);
      else excluded.add(id);
    }
    return { kind: 'filter', excluded };
  }
  const ids = new Set(p.ids);
  for (const id of pageIds) {
    if (on) ids.add(id);
    else ids.delete(id);
  }
  return { kind: 'ids', ids };
}

export function pickedCount(p: Picked, total: number): number {
  return p.kind === 'ids' ? p.ids.size : Math.max(0, total - p.excluded.size);
}

/** Условия текущего списка — их же сервер применит к «все по фильтру». */
export interface ListConditions {
  q: string;
  includeArchived: boolean;
  archivedOnly: boolean;
  withTasks: boolean;
  filter: RecordFilterParams;
}

export function selectionBody(p: Picked, c: ListConditions): BulkSelection {
  if (p.kind === 'ids') return { ids: [...p.ids] };
  // Значения фильтра из адреса — строки; проверяет их сервер (400 при неизвестном значении).
  type FilterBody = Extract<BulkSelection, { filter: unknown }>['filter'];
  return {
    filter: {
      ...c.filter,
      ...(c.q ? { q: c.q } : {}),
      ...(c.includeArchived ? { includeArchived: true } : {}),
      ...(c.archivedOnly ? { archived: 'only' as const } : {}),
      ...(c.withTasks ? { withTasks: true } : {}),
    } as FilterBody,
    excludeIds: [...p.excluded],
  };
}

const REASONS: [keyof BulkResult['byReason'], string][] = [
  ['tasks', 'открытые задачи'],
  ['links', 'ссылки из других записей'],
  ['decisions', 'решения другого отдела'],
  ['evidence', 'доказательства'],
  ['locked', 'зафиксированные поля'],
];

/** «записей» с правильным окончанием: 1 запись, 2 записи, 5 записей. */
export function records(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'запись' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'записи' : 'записей';
  return `${n} ${word}`;
}

/** Почему записи не удаляются: «открытые задачи — 3, ссылки из других записей — 1». */
export function reasonLines(byReason: BulkResult['byReason']): string[] {
  return REASONS.filter(([k]) => byReason[k] > 0).map(([k, label]) => `${label} — ${byReason[k]}`);
}

/** Строки предпросмотра: что произойдёт. */
export function previewLines(action: 'archive' | 'restore' | 'delete', p: BulkPreview): string[] {
  const out: string[] = [];
  if (action === 'delete') {
    if (p.willDelete) out.push(`Будет удалено: ${records(p.willDelete)}`);
    if (p.willArchive) out.push(`Уйдёт в архив вместо удаления: ${records(p.willArchive)} — у них есть зависимости`);
    if (p.alreadyInState) out.push(`Останется в архиве: ${records(p.alreadyInState)} — у них есть зависимости`);
  } else if (action === 'archive') {
    if (p.willArchive) out.push(`Уйдёт в архив: ${records(p.willArchive)}`);
    if (p.alreadyInState) out.push(`Уже в архиве: ${records(p.alreadyInState)}`);
  } else {
    if (p.willRestore) out.push(`Вернётся из архива: ${records(p.willRestore)}`);
    if (p.alreadyInState) out.push(`Не в архиве: ${records(p.alreadyInState)}`);
  }
  return out.length ? out : ['Менять нечего'];
}

/** Итог: «Удалено 5, в архив 2» и подсказка, если мешают задачи. */
export function resultSummary(r: BulkResult): { title: string; hint: string | null } {
  const parts = [
    r.deleted ? `удалено ${r.deleted}` : '',
    r.archived ? `в архив ${r.archived}` : '',
    r.restored ? `возвращено ${r.restored}` : '',
    r.skipped ? `без изменений ${r.skipped}` : '',
  ].filter(Boolean);
  const title = parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'Ничего не изменилось';
  return { title, hint: r.byReason.tasks > 0 ? 'Сначала закройте или удалите задачи — тогда записи можно будет удалить' : null };
}
