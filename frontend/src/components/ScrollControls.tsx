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
    // Высота меняется после загрузки данных — перемерить.
    const ro = new ResizeObserver(onScroll);
    ro.observe(document.body);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, { capture: true });
      ro.disconnect();
    };
  }, [show, update, pathname]);

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
