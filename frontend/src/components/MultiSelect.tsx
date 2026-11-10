// Список с множественным выбором в стиле «Океан» (1.13.5, задание docs/tasks/1.13.5-responsible-multi.md): на стилях
// и размещении Select 1.13.4 (.sel-btn, .sel-pop — стекло в портале поверх окон, place()). Выбранные — чипами над
// кнопкой, у чипа «×». Панель: поиск, «Выбрать всех найденных» (только при непустом поиске), список
// role="listbox" aria-multiselectable с отметками, «Готово». Недоступные пункты видны с пометкой (note) и не отмечаются.
// Клавиатура и отметки — multi-select-logic.ts.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { msKey, removeValue, selectAllFound, selectableFound, toggleValue, type MsKey, type MsZone } from './multi-select-logic';
import { filterIndexes, place, type SelOption } from './select-logic';

export interface MsOption extends SelOption {
  /** Вторая строка пункта и подсказка чипа: должность. */
  hint?: string;
  /** Почему недоступен: «уже добавлен». */
  note?: string;
}

interface Props {
  options: MsOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Текст кнопки, открывающей список. */
  label: string;
  /** Имя списка для чтения с экрана. */
  listLabel: string;
  /** Подпись чипов («Выбраны»). */
  chipsLabel?: string;
  /** Сколько можно отметить всего. */
  max?: number;
  /** Фильтр по вводу; по умолчанию — подстрока подписи. */
  match?: (o: MsOption, query: string) => boolean;
  disabled?: boolean;
  /** Атрибут data-testid кнопки. */
  testId?: string;
}

const KEYS: readonly string[] = ['ArrowDown', 'ArrowUp', 'Home', 'End', ' ', 'Enter', 'Escape'];

export function MultiSelect({ options, selected, onChange, label, listLabel, chipsLabel = 'Выбраны', max = Infinity, match, disabled, testId }: Props) {
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<CSSProperties>({});

  const visible: MsOption[] = match
    ? options.filter((o) => match(o, query))
    : filterIndexes(options, query).map((i) => options[i] as MsOption);
  const byValue = new Map(options.map((o) => [o.value, o]));
  const chips = selected.map((v) => byValue.get(v)).filter((o): o is MsOption => !!o);
  const full = selected.length >= max;
  const canAll = query.trim() !== '' && selectableFound(visible, selected).length > 0 && !full;

  const reposition = useCallback(() => {
    const b = btn.current;
    if (!b) return;
    const want = (pop.current?.scrollHeight ?? 320) + 2;
    const r = b.getBoundingClientRect();
    // Панель не уже 320 px: ФИО и должность в две строки; place() держит её в пределах экрана (375 px — во всю ширину).
    const p = place({ top: r.top, bottom: r.bottom, left: r.left, width: Math.max(r.width, 320) }, { width: window.innerWidth, height: window.innerHeight }, want);
    setPos({ left: p.left, width: p.width, maxHeight: p.maxHeight, ...(p.up ? { bottom: p.bottom } : { top: p.top }) });
  }, []);

  const openList = () => {
    if (disabled) return;
    setQuery('');
    setActive(-1);
    setOpen(true);
  };
  const close = (focusButton = true) => {
    setOpen(false);
    setQuery('');
    if (focusButton) btn.current?.focus();
  };
  const toggle = (o: MsOption | undefined) => onChange(toggleValue(selected, o, max));

  useLayoutEffect(() => {
    if (!open) return undefined;
    reposition();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    document.addEventListener('pointerdown', onDown, true);
    search.current?.focus();
    return () => {
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && active >= 0) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const focusZone = (z: MsZone) => (z === 'list' ? list.current : search.current)?.focus();

  const handle = (e: KeyboardEvent, zone: MsZone) => {
    // Буква в списке — в поиск: продолжить ввод.
    if (zone === 'list' && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setQuery((q) => q + e.key);
      setActive(-1);
      focusZone('search');
      return;
    }
    if (!KEYS.includes(e.key)) return;
    if (zone === 'search' && e.key === ' ') return;
    const r = msKey(visible, zone, active, e.key as MsKey);
    e.preventDefault();
    // Esc и Enter — только списку, не окну вокруг (окно закрывается по Esc, форма отправляется по Enter).
    e.stopPropagation();
    setActive(r.active);
    if (r.effect.kind === 'toggle') toggle(visible[r.effect.index]);
    else if (r.effect.kind === 'confirm' || r.effect.kind === 'close') close();
    else if (r.effect.kind === 'focus') focusZone(r.effect.zone);
  };

  const optionId = (i: number) => `${listId}-o${i}`;
  return (
    <div className={`ms${open ? ' open' : ''}`}>
      {chips.length > 0 && (
        <ul className="ms-chips" aria-label={chipsLabel}>
          {chips.map((o) => (
            <li key={o.value} className="chip acc ms-chip" title={o.hint ? `${o.label} · ${o.hint}` : o.label} data-chip={o.label}>
              <span className="ms-chip-t">{o.label}</span>
              <button type="button" className="chip-x" aria-label={`Снять: ${o.label}`} disabled={disabled} onClick={() => onChange(removeValue(selected, o.value))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <button
        ref={btn} type="button" className="inp sel-btn ms-btn" disabled={disabled} data-testid={testId}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || (e.altKey && e.key === 'ArrowDown'))) { e.preventDefault(); openList(); } }}
      >
        <span className="sel-v">{label}{selected.length ? ` · выбрано ${selected.length}` : ''}</span>
        <svg className="sel-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && createPortal(
        <div ref={pop} className="sel-pop ms-pop" style={pos} data-sel-pop="" data-ms-pop="">
          <input
            ref={search} className="sel-search" type="search" placeholder="Поиск по ФИО и должности…" aria-label={`Поиск: ${listLabel}`} value={query}
            aria-controls={listId} onChange={(e) => { setQuery(e.target.value); setActive(-1); }} onKeyDown={(e) => handle(e, 'search')}
          />
          {canAll && (
            <button type="button" className="ms-all" onClick={() => onChange(selectAllFound(selected, visible, max))}>
              Выбрать всех найденных ({Math.min(selectableFound(visible, selected).length, max - selected.length)})
            </button>
          )}
          <ul
            ref={list} className="sel-list" role="listbox" id={listId} aria-label={listLabel} aria-multiselectable="true" tabIndex={-1}
            aria-activedescendant={active >= 0 && visible[active] ? optionId(active) : undefined} onKeyDown={(e) => handle(e, 'list')}
          >
            {visible.map((o, i) => {
              const on = selected.includes(o.value);
              const off = o.disabled || (!on && full);
              return (
                <li
                  key={o.value} id={optionId(i)} data-index={i} data-value={o.value} role="option" aria-selected={on} aria-disabled={off || undefined}
                  className={`sel-o ms-o${i === active ? ' active' : ''}${on ? ' cur' : ''}`}
                  onPointerMove={() => { if (!off && i !== active) setActive(i); }}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => { if (!off) { setActive(i); toggle(o); } }}
                >
                  <span className={`ms-box${on ? ' on' : ''}`} aria-hidden="true" />
                  <span className="ms-txt">
                    <span className="sel-ol">{o.label}</span>
                    {(o.hint || (o.disabled && o.note)) && <span className="ms-hint">{[o.hint, o.disabled ? o.note : ''].filter(Boolean).join(' · ')}</span>}
                  </span>
                </li>
              );
            })}
            {visible.length === 0 && <li className="sel-empty" role="presentation">{options.length ? 'Ничего не найдено' : 'Список пуст'}</li>}
          </ul>
          <div className="ms-foot">
            <span className="hint">{full ? `Выбрано ${selected.length} — больше нельзя` : selected.length ? `Выбрано ${selected.length}` : 'Пробел — отметить, Enter — готово'}</span>
            <button type="button" className="btn sm primary" onClick={() => close()}>Готово</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
