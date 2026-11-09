// Выпадающий список в стиле «Океан» (1.13.4, задание docs/tasks/1.13.4-forms.md) вместо нативного <select>:
// раскрытый нативный список на Windows рисуется системным — светлым, с голубым выделением, не по теме портала.
//
// Как устроен: внутри — скрытый нативный <select> со всеми прежними свойствами (value, onChange, required, disabled,
// form, name, data-testid) и теми же <option>. Выбор в своём списке ставит значение нативному и посылает настоящее
// событие change — обработчики, валидация и отправка форм не меняются. Видимая часть — кнопка role="combobox" ПЕРЕД
// нативным (клик по подписи <label> открывает список: первый «подписываемый» элемент — кнопка), список — role="listbox"
// в портале поверх окон. Клавиатура — WAI-ARIA APG (select-only combobox), логика — select-logic.ts.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { filterIndexes, onKey, place, SEARCH_THRESHOLD, typeahead, type SelKey, type SelOption } from './select-logic';

type Props = SelectHTMLAttributes<HTMLSelectElement> & { 'data-testid'?: string };

const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

/** Открыт ли сейчас список Select: окна с Esc в фазе захвата пропускают клавишу — её закрывает список. */
export const selectListOpen = () => typeof document !== 'undefined' && document.querySelector('[data-sel-pop]') !== null;

function readOptions(sel: HTMLSelectElement | null): SelOption[] {
  if (!sel) return [];
  return [...sel.options].filter((x) => !x.hidden).map((x) => ({ value: x.value, label: x.text, disabled: x.disabled }));
}

export function Select({ className, style, id, title, autoFocus, children, disabled, 'aria-label': ariaLabel, ...rest }: Props) {
  const native = useRef<HTMLSelectElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [shown, setShown] = useState({ label: '', value: '' });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState('');
  const [opts, setOpts] = useState<SelOption[]>([]);
  const [pos, setPos] = useState<CSSProperties>({});
  const typed = useRef({ text: '', at: 0 });

  // Подпись текущего значения — из нативного после каждой отрисовки (значение, варианты и их текст могут меняться).
  // Без списка зависимостей намеренно: состояние меняется только при отличии — цикла нет.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const s = native.current;
    if (!s) return;
    const cur = s.selectedOptions[0];
    const next = { label: cur?.text ?? '', value: s.value };
    if (next.label !== shown.label || next.value !== shown.value) setShown(next);
  });

  const selectedIndex = (list: SelOption[]) => list.findIndex((o) => o.value === native.current?.value);
  const searchable = opts.length > SEARCH_THRESHOLD;
  const visible = searchable ? filterIndexes(opts, query) : opts.map((_, i) => i);

  const reposition = useCallback(() => {
    const b = btn.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const want = (pop.current?.scrollHeight ?? 260) + 2;
    const p = place(r, { width: window.innerWidth, height: window.innerHeight }, want);
    setPos({ left: p.left, width: p.width, maxHeight: p.maxHeight, ...(p.up ? { bottom: p.bottom } : { top: p.top }) });
  }, []);

  const openList = (at?: number) => {
    if (disabled) return;
    const list = readOptions(native.current);
    setOpts(list);
    setQuery('');
    setActive(at ?? selectedIndex(list));
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    setQuery('');
    if (focus) btn.current?.focus();
  };
  const pick = (index: number) => {
    const o = opts[index];
    const s = native.current;
    if (!o || o.disabled || !s) return;
    close();
    if (s.value === o.value) return;
    valueSetter?.call(s, o.value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
  };

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
    if (searchable) search.current?.focus();
    return () => {
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Активный пункт — в видимой части списка.
  useEffect(() => {
    if (open && active >= 0) pop.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const keyOf = (e: KeyboardEvent): SelKey | null => {
    if (e.altKey && e.key === 'ArrowDown') return 'AltArrowDown';
    return (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp', 'Enter', ' ', 'Escape', 'Tab'] as string[]).includes(e.key) ? e.key as SelKey : null;
  };

  const handle = (e: KeyboardEvent, fromSearch: boolean) => {
    const key = keyOf(e);
    // Буквы: поиск по началу подписи (в поле поиска длинного списка буквы идут в поле).
    if (!key && !fromSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key, at: now };
      const list = open ? opts : readOptions(native.current);
      const base = open ? active : selectedIndex(list);
      const i = typeahead(list, typed.current.text, base < 0 ? 0 : base);
      if (!open) openList(i);
      else setActive(i);
      e.preventDefault();
      return;
    }
    if (!key || (fromSearch && key === ' ')) return;
    // В длинном списке ↑ ↓ ходят по найденному.
    const list = searchable ? visible.map((i) => opts[i] as SelOption) : open ? opts : readOptions(native.current);
    const toLocal = (i: number) => (searchable ? visible.indexOf(i) : i);
    const toGlobal = (i: number) => (searchable ? visible[i] ?? -1 : i);
    const sel = selectedIndex(open ? opts : list);
    const r = onKey(list, { open, active: toLocal(active) }, key, toLocal(sel));
    if (key !== 'Tab') e.preventDefault();
    // Открытый список: Esc и Enter — только ему, не окну вокруг (окно закрывается по Esc, форма отправляется по Enter).
    if (open && (key === 'Escape' || key === 'Enter' || key === ' ')) e.stopPropagation();
    if (!open && r.state.open) { openList(toGlobal(r.state.active)); return; }
    if (r.effect.kind === 'pick') { pick(toGlobal(r.effect.index)); return; }
    if (r.effect.kind === 'close') { close(key !== 'Tab'); return; }
    setActive(toGlobal(r.state.active));
  };

  const optionId = (i: number) => `${listId}-o${i}`;
  return (
    <span className={`sel${open ? ' open' : ''}`} style={style}>
      <button
        ref={btn} id={id} type="button" className={`${className ?? ''} sel-btn`} title={title ?? (shown.label || undefined)} autoFocus={autoFocus} disabled={disabled}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={ariaLabel}
        aria-activedescendant={open && !searchable && active >= 0 ? optionId(active) : undefined}
        aria-invalid={rest['aria-invalid']} data-value={shown.value}
        onClick={() => (open ? close() : openList())} onKeyDown={(e) => handle(e, false)}
      >
        <span className="sel-v">{shown.label || ' '}</span>
        <svg className="sel-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <select
        ref={native} {...rest} disabled={disabled} aria-label={ariaLabel} className="sel-native" tabIndex={-1} aria-hidden="true"
        // Браузер фокусирует невалидное поле при отправке формы — фокус на видимую кнопку.
        onFocus={() => btn.current?.focus()}
      >
        {children}
      </select>
      {open && createPortal(
        <div ref={pop} className="sel-pop" style={pos} data-sel-pop="">
          {searchable && (
            <input
              ref={search} className="sel-search" type="search" placeholder="Поиск…" aria-label="Поиск в списке" value={query}
              role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={active >= 0 && visible.includes(active) ? optionId(active) : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                const f = filterIndexes(opts, e.target.value);
                setActive(f.find((i) => !opts[i]?.disabled) ?? -1);
              }}
              onKeyDown={(e) => handle(e, true)}
            />
          )}
          <ul className="sel-list" role="listbox" id={listId} aria-label={ariaLabel ?? (btn.current?.closest('label')?.firstChild?.textContent?.trim() || undefined)}>
            {visible.map((i) => {
              const o = opts[i] as SelOption;
              return (
                <li
                  key={`${i}:${o.value}`} id={optionId(i)} data-index={i} data-value={o.value} role="option" aria-selected={o.value === shown.value} aria-disabled={o.disabled || undefined}
                  className={`sel-o${i === active ? ' active' : ''}${o.value === shown.value ? ' cur' : ''}`}
                  onPointerMove={() => { if (!o.disabled && i !== active) setActive(i); }}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                >
                  <span className="sel-ol">{o.label || ' '}</span>
                  {o.value === shown.value && (
                    <svg className="sel-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
                  )}
                </li>
              );
            })}
            {visible.length === 0 && <li className="sel-empty" role="presentation">Ничего не найдено</li>}
          </ul>
        </div>,
        document.body,
      )}
    </span>
  );
}
