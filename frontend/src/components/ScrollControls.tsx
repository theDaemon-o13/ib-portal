// Кнопки «Обновить», «В самый верх», «В самый низ» на страницах-списках (1.13.3): задачи, реестры, уязвимости, активы,
// документы, доказательства, осведомлённость, журнал, настройки, поиск. Прокручивают окно и колонки доски задач
// (у колонки своя прокрутка). «Обновить» перечитывает данные открытой страницы без перезагрузки — фильтры и прокрутка
// остаются. «Вверх» и «Вниз» видны, только когда есть куда прокручивать.
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

const LIST_PAGES = /^\/(dashboard|tasks|registers|vulns|assets|documents|evidence|awareness|audit|settings|search)(\/|$)/;
/** Внутренние списки, которые прокручиваются сами: колонки доски задач. */
const INNER = '.board .col';

export const isListPage = (path: string) => LIST_PAGES.test(path);

type Room = { up: boolean; down: boolean };

function measure(): Room {
  const doc = document.scrollingElement ?? document.documentElement;
  let up = doc.scrollTop > 120;
  let down = doc.scrollTop + window.innerHeight < doc.scrollHeight - 120;
  for (const el of document.querySelectorAll<HTMLElement>(INNER)) {
    if (el.scrollHeight <= el.clientHeight + 4) continue;
    up ||= el.scrollTop > 40;
    down ||= el.scrollTop + el.clientHeight < el.scrollHeight - 40;
  }
  return { up, down };
}

function scrollAll(to: 'top' | 'bottom') {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';
  const doc = document.scrollingElement ?? document.documentElement;
  window.scrollTo({ top: to === 'top' ? 0 : doc.scrollHeight, behavior });
  for (const el of document.querySelectorAll<HTMLElement>(INNER)) el.scrollTo({ top: to === 'top' ? 0 : el.scrollHeight, behavior });
}

export function ScrollControls() {
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const fetching = useIsFetching() > 0;
  const [room, setRoom] = useState<Room>({ up: false, down: false });
  const [refreshing, setRefreshing] = useState(false);
  const show = isListPage(pathname);

  const update = useCallback(() => setRoom(measure()), []);
  useEffect(() => {
    if (!show) return undefined;
    update();
    // Таймер, а не requestAnimationFrame: в фоновой вкладке кадры не рисуются, а пересчитать нужно.
    let timer = 0;
    const onScroll = () => { window.clearTimeout(timer); timer = window.setTimeout(update, 60); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // Колонки доски прокручиваются сами: scroll не всплывает — ловим на захвате.
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    // Высота страницы меняется после загрузки данных — перемерить. У body высота 100% (base.css) и не растёт вместе
    // со списком — растёт #root (до 1.13.5 наблюдался только body, и «Вниз» не появлялась ни на одной странице,
    // если данные пришли после первого замера).
    const ro = new ResizeObserver(onScroll);
    ro.observe(document.body);
    const root = document.getElementById('root');
    if (root) ro.observe(root);
    // Колонки доски — своя высота и своя прокрутка: карточки, пришедшие после первого замера, не меняют ни размер
    // body, ни размер колонки (1.13.3: «Вниз» не появлялась). Поэтому — размер каждой колонки (ResizeObserver,
    // колонки появляются и пропадают — список сверяется) и изменение содержимого (MutationObserver).
    const inner = new Set<Element>();
    const syncInner = () => {
      const now = new Set(document.querySelectorAll(INNER));
      for (const el of inner) if (!now.has(el)) { ro.unobserve(el); inner.delete(el); }
      for (const el of now) if (!inner.has(el)) { ro.observe(el); inner.add(el); }
    };
    syncInner();
    const mo = new MutationObserver(() => { syncInner(); onScroll(); });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, { capture: true });
      ro.disconnect();
      mo.disconnect();
    };
  }, [show, update, pathname]);

  // Данные перечитаны («Обновить», фоновое обновление) — перемерить после отрисовки.
  useEffect(() => { if (show && !fetching) update(); }, [show, fetching, update]);

  if (!show) return null;
  const refresh = async () => {
    setRefreshing(true);
    try {
      // Только активные запросы открытой страницы; кэш остального перечитается при переходе.
      await qc.invalidateQueries({ refetchType: 'active' });
    } finally {
      setRefreshing(false);
    }
  };
  const busy = refreshing || fetching;
  return (
    <div className="scroll-ctl" role="group" aria-label="Список: обновить и прокрутить" data-testid="scroll-controls">
      <button type="button" className="scroll-btn" onClick={refresh} disabled={refreshing} aria-busy={busy} title="Обновить данные страницы" aria-label="Обновить">
        <svg className={busy ? 'spin' : undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
        </svg>
      </button>
      {room.up && (
        <button type="button" className="scroll-btn" onClick={() => scrollAll('top')} title="В самый верх" aria-label="В самый верх">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 11l7-7 7 7" /><path d="M12 4v16" /></svg>
        </button>
      )}
      {room.down && (
        <button type="button" className="scroll-btn" onClick={() => scrollAll('bottom')} title="В самый низ" aria-label="В самый низ">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 13l-7 7-7-7" /><path d="M12 20V4" /></svg>
        </button>
      )}
    </div>
  );
}
