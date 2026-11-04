import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Overlay } from './Overlay';

/**
 * Ширина окна, ниже которой «список + детали» не помещаются рядом: панель деталей выезжает справа (sheet).
 * Совпадает с @media (max-width: 1180px) в base.css (.ld).
 */
export const DETAIL_NARROW_QUERY = '(max-width: 1180px)';

function subscribe(query: string) {
  return (onChange: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  };
}

/** Совпадает ли медиазапрос сейчас; перерисовывает компонент при смене. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscribe(query),
    () => (typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches),
    () => false,
  );
}

export interface DetailPanelProps {
  /** Подпись для чтения с экрана (aria-label); e2e находят панель по ней: aside.drawer[aria-label="…"]. */
  label: string;
  /**
   * sheet — всегда выезжающая справа панель поверх страницы (доска задач, таблицы реестров);
   * inline — колонка рядом со списком, прилипает к верху окна при прокрутке; на узком окне становится sheet.
   */
  variant?: 'sheet' | 'inline';
  /** Широкая панель (форма записи в две колонки). */
  wide?: boolean;
  /** Строка над заголовком: что это за объект. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Метки под заголовком: статус, просрочка. */
  badges?: ReactNode;
  /** Закрыть: у sheet — обязательно (Esc, щелчок по затемнению, кнопка). У inline на широком окне кнопки нет. */
  onClose?: () => void;
  /** Главные действия: прилипают к низу панели, видны при любой длине содержимого. */
  footer?: ReactNode;
  /** Сменился ключ (другая запись) — содержимое панели прокручивается к началу; список под ней не трогается. */
  scrollKey?: string | null;
  className?: string;
  /** Элементы без своей обёртки сразу под шапкой (например, вкладки). */
  children: ReactNode;
  testId?: string;
}

/**
 * Панель деталей для экранов «список + детали» (релиз 1.6.5).
 * Одна разметка для всех экранов: шапка, прокручиваемое содержимое, прилипший подвал с действиями.
 * Классы .drawer, .dr-h, .dr-title, .dr-b сохранены: на них опираются e2e и стили карточек.
 */
export function DetailPanel({ label, variant = 'sheet', wide, eyebrow, title, badges, onClose, footer, scrollKey, className, children, testId }: DetailPanelProps) {
  const narrow = useMediaQuery(DETAIL_NARROW_QUERY);
  const asSheet = variant === 'sheet' || (narrow && !!onClose);
  const body = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);

  // Другая запись — к началу панели. Прокручивается только содержимое панели, не страница.
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [scrollKey]);

  // Esc закрывает выезжающую панель. Окно поверх панели (подтверждение, просмотр файла) закрывается своим обработчиком.
  useEffect(() => {
    if (!asSheet || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [asSheet, onClose]);

  // Фокус: при открытии sheet — на панель (если поле внутри не взяло его само), при закрытии — туда, где был.
  useEffect(() => {
    if (!asSheet) return;
    const before = document.activeElement as HTMLElement | null;
    if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus({ preventScroll: true });
    return () => {
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [asSheet]);

  const head = (
    <div className="dr-h panel-h dp-h">
      <div className="min0 dp-head">
        {eyebrow && <div className="dp-eyebrow">{eyebrow}</div>}
        <b className="dr-title">{title}</b>
        {badges && <div className="dp-badges">{badges}</div>}
      </div>
      {onClose && asSheet && (
        <button className="btn sm dp-close" type="button" onClick={onClose}>Закрыть</button>
      )}
    </div>
  );
  const inner = (
    <>
      {head}
      <div className="dr-b dp-b" ref={body}>{children}</div>
      {footer && <div className="dp-f" role="group" aria-label="Действия">{footer}</div>}
    </>
  );

  if (asSheet) {
    return (
      <Overlay>
        <div className="backdrop drawer-backdrop" role="presentation" onClick={onClose} />
        <aside ref={panel} tabIndex={-1} className={`drawer dp dp-sheet${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true"
          aria-label={label} data-testid={testId}>
          {inner}
        </aside>
      </Overlay>
    );
  }
  return (
    <section ref={panel} className={`panel dp dp-inline${className ? ` ${className}` : ''}`} aria-label={label} data-testid={testId}>
      {inner}
    </section>
  );
}
