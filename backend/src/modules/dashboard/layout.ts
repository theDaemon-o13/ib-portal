// Раскладка дашборда (релиз 1.1.0, задача 5, ADR-0018): упорядоченный список { key, hidden, size }.
// Чистые функции: слияние сохранённой раскладки с текущим набором элементов и проверка ввода.
//   key  — kpi:<ключ KPI>, tile:<id плитки>, widget:<ключ виджета>;
//   size — s / m / l (в сетке виджетов — треть, половина, вся ширина); KPI — всегда s.
import { badRequest } from '../../lib/errors.js';
import type { PermissionCode } from '../../lib/permissions.js';

export const LAYOUT_SIZES = ['s', 'm', 'l'] as const;
export type LayoutSize = (typeof LAYOUT_SIZES)[number];

export interface LayoutItem {
  key: string;
  hidden: boolean;
  size: LayoutSize;
}

/** Элемент, который сейчас есть на дашборде: размер по умолчанию и право, без которого его не видно. */
export interface LayoutElement {
  key: string;
  defaultSize: LayoutSize;
  /** KPI: размер не меняется. */
  fixedSize: boolean;
  perm: PermissionCode;
}

const isSize = (v: unknown): v is LayoutSize => typeof v === 'string' && (LAYOUT_SIZES as readonly string[]).includes(v);

/**
 * Сохранённая раскладка + текущий набор элементов: порядок и настройки сохранённых, неизвестные ключи
 * (плитку удалили, поле убрали из аналитики) пропускаются, новые элементы — в конец, видимыми.
 */
export function mergeLayout(saved: unknown, elements: readonly LayoutElement[]): LayoutItem[] {
  const byKey = new Map(elements.map((e) => [e.key, e]));
  const out: LayoutItem[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(saved) ? saved : []) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const e = typeof r.key === 'string' ? byKey.get(r.key) : undefined;
    if (!e || seen.has(e.key)) continue;
    seen.add(e.key);
    out.push({ key: e.key, hidden: r.hidden === true, size: e.fixedSize ? e.defaultSize : isSize(r.size) ? r.size : e.defaultSize });
  }
  for (const e of elements) if (!seen.has(e.key)) out.push({ key: e.key, hidden: false, size: e.defaultSize });
  return out;
}

/** Ввод из «Настроить»: только известные ключи без повторов, размеры из списка; KPI — свой размер. */
export function checkLayout(items: readonly { key: string; hidden: boolean; size: string }[], elements: readonly LayoutElement[]): LayoutItem[] {
  const byKey = new Map(elements.map((e) => [e.key, e]));
  const seen = new Set<string>();
  for (const i of items) {
    const e = byKey.get(i.key);
    if (!e) throw badRequest('BAD_LAYOUT', 'В раскладке есть элемент, которого нет на дашборде. Обновите страницу');
    if (seen.has(i.key)) throw badRequest('BAD_LAYOUT', 'Элемент встречается в раскладке дважды');
    if (!isSize(i.size)) throw badRequest('BAD_LAYOUT', 'Размер — S, M или L');
    seen.add(i.key);
  }
  return mergeLayout(items, elements);
}

/** Раскладка «Начальник ИБ» по умолчанию: сначала просроченное и требующее решения, сроки — во всю ширину. */
export const HEAD_FIRST_KPIS = ['vulns_overdue', 'tasks_overdue', 'risks_no_decision', 'docs_review'] as const;
