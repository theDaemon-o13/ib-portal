// Экран мониторинга по слайдам (релиз 1.1.0, задача 6): шаги листания и тексты пустых слайдов. Чистые функции.
import type { MonitorSlide } from '../../api/dashboard';

export interface Step {
  /** Номер слайда в наборе. */
  slide: number;
  /** Страница слайда (длинный список делится на страницы, каждая — время слайда). */
  page: number;
}

/** Сколько страниц у слайда при per строках на странице. */
export function pagesOf(s: Pick<MonitorSlide, 'data' | 'empty'>, per: number): number {
  if (s.empty) return 1;
  const n = s.data.kind === 'vulns' ? s.data.vulns?.items.length ?? 0 : s.data.kind === 'items' ? s.data.items.length : 0;
  return Math.max(1, Math.ceil(n / per));
}

/** Все шаги набора по порядку; пустые слайды с «пропускать пустой» не показываются. */
export function stepsOf(slides: readonly Pick<MonitorSlide, 'data' | 'empty' | 'skipEmpty'>[], per: number): Step[] {
  const out: Step[] = [];
  slides.forEach((s, slide) => {
    if (s.empty && s.skipEmpty) return;
    for (let page = 0; page < pagesOf(s, per); page++) out.push({ slide, page });
  });
  return out;
}

/** Текст пустого слайда: что именно не найдено — с учётом фильтра срока. */
export function emptyText(s: Pick<MonitorSlide, 'kind' | 'filter'>): string {
  const p = s.filter.period ?? 'all';
  const soon = `со сроком в ближайшие ${s.filter.days ?? 7} дн.`;
  const by = (what: string, overdue: string) => (p === 'overdue' ? `Нет ${overdue}` : p === 'within' ? `Нет ${what} ${soon}` : `Нет ${what} со сроком`);
  switch (s.kind) {
    case 'vulns': return p === 'all' ? 'Открытых уязвимостей нет' : by('уязвимостей', 'просроченных уязвимостей');
    case 'tasks': return by('задач', 'просроченных задач');
    case 'documents': return p === 'overdue' ? 'Нет документов с просроченным пересмотром' : p === 'within' ? `Нет документов с пересмотром в ближайшие ${s.filter.days ?? 7} дн.` : 'Нет документов со сроком пересмотра';
    case 'risks': return p === 'overdue' ? 'Нет решений ОУР с просроченным пересмотром' : 'Нет решений ОУР к пересмотру';
    case 'evidence': return p === 'overdue' ? 'Нет доказательств с истёкшим сроком' : 'Нет доказательств со сроком действия';
    case 'dlp': return 'Доступов без основания нет';
    default: return 'Нет данных';
  }
}
