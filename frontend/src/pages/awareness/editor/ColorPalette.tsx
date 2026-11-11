// Палитра цвета (1.13.11): одна для цвета текста, фона текста, подчёркивания и заливки ячейки. Кнопка с разделённым
// нажатием, как в Word: основная часть — последний выбранный цвет (полоса на кнопке), стрелка — палитра. В палитре:
// «Избранные», стандартные цвета вида, «Свой цвет» (#RRGGBB), «Без цвета». Клавиатура: стрелки, Enter, Esc, Delete.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CELL_COLORS, HIGHLIGHT_COLORS, MIN_CONTRAST, TEXT_COLORS, TEXT_DEFAULT } from '../../../api/generated/letter-format';
import { FAVORITE_SET, useFavorites, type ColorKind } from './favorites';
import { contrast, strictHex } from './format';

export const STANDARD: Record<ColorKind, readonly { name: string; hex: string }[]> = {
  text: TEXT_COLORS, underline: TEXT_COLORS, highlight: HIGHLIGHT_COLORS, cell: CELL_COLORS,
};
const NONE_LABEL: Record<ColorKind, string> = { text: 'Обычный цвет', underline: 'Цветом текста', highlight: 'Без фона', cell: 'Без заливки' };
const FAV_TITLE: Record<ColorKind, string> = { text: 'Избранные цвета текста', underline: 'Избранные цвета текста', highlight: 'Избранные цвета фона', cell: 'Избранные цвета фона' };
/** Последний цвет при первом открытии: у подчёркивания — цветом текста (как кнопка «Ч» до 1.13.11). */
export const DEFAULT_LAST: Record<ColorKind, string | null> = { text: '#DC2626', underline: null, highlight: '#FEF08A', cell: '#EFF6FF' };
const COLS = 8;

/** Подпись образца для экранного диктора: «Красный, #DC2626, в избранном». */
export function swatchLabel(hex: string, name: string | null, favorite: boolean): string {
  return [name, hex, favorite ? 'в избранном' : null].filter(Boolean).join(', ');
}

/** Предупреждение о контрасте: фон (маркер, заливка) против цвета текста. */
export function contrastWarning(kind: ColorKind, color: string | null, textColor: string | null): string | null {
  if (!color || (kind !== 'highlight' && kind !== 'cell')) return null;
  return contrast(textColor ?? TEXT_DEFAULT, color) < MIN_CONTRAST ? 'Текст будет плохо виден' : null;
}

interface Swatch { hex: string; name: string | null; favorite: boolean; section: 'fav' | 'std' }

export function ColorSplit(p: {
  kind: ColorKind;
  /** Подпись кнопки: «Цвет текста», «Цвет фона текста», «Подчеркнуть цветом», «Заливка ячейки». */
  label: string;
  icon: ReactNode;
  userId: string;
  /** Последний выбранный цвет; null — «без цвета» (у подчёркивания — цветом текста). */
  last: string | null;
  /** null — снять цвет (для подчёркивания — подчеркнуть цветом текста). */
  onApply: (color: string | null) => void;
  /** Основная часть кнопки, если не «применить последний цвет» (подчёркивание: повторное нажатие снимает). */
  onMain?: () => void;
  /** Цвет текста выделения — для предупреждения о контрасте фона. */
  textColor?: string | null;
  onWarning: (text: string) => void;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <span className="aw-split" ref={box}>
      <button type="button" className={`aw-tb aw-split-main${p.active ? ' on' : ''}`} title={`${p.label}: ${p.last ?? NONE_LABEL[p.kind].toLowerCase()}`}
        aria-label={`${p.label}: ${p.last ?? NONE_LABEL[p.kind].toLowerCase()}`} aria-pressed={p.active} data-kind={p.kind}
        onMouseDown={(e) => e.preventDefault()} onClick={() => (p.onMain ? p.onMain() : p.onApply(p.last))}>
        <span className="aw-split-ico">{p.icon}</span>
        <span className="aw-split-bar" style={{ background: p.last ?? 'currentColor' }} aria-hidden="true" />
      </button>
      <button type="button" className="aw-tb aw-split-arrow" data-kind={p.kind} title={`${p.label}: палитра`} aria-label={`${p.label}: палитра`} aria-haspopup="dialog" aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>▾</button>
      {open && (
        <ColorPalette kind={p.kind} label={p.label} userId={p.userId} current={p.last ?? ''} textColor={p.textColor ?? null} onWarning={p.onWarning}
          onPick={(c) => { setOpen(false); p.onApply(c); }} onClose={() => setOpen(false)} />
      )}
    </span>
  );
}

export function ColorPalette(p: {
  kind: ColorKind;
  label: string;
  userId: string;
  current: string;
  textColor: string | null;
  onPick: (color: string | null) => void;
  onClose: () => void;
  onWarning: (text: string) => void;
}) {
  const fav = useFavorites(p.userId, FAVORITE_SET[p.kind]);
  const std = STANDARD[p.kind];
  const swatches: Swatch[] = [
    ...fav.list.map((hex) => ({ hex, name: std.find((s) => s.hex === hex)?.name ?? null, favorite: true, section: 'fav' as const })),
    ...std.map((s) => ({ hex: s.hex, name: s.name, favorite: fav.list.includes(s.hex), section: 'std' as const })),
  ];
  const [focus, setFocus] = useState(() => Math.max(0, swatches.findIndex((s) => s.hex === p.current)));
  const [custom, setCustom] = useState(p.current || '#');
  const [error, setError] = useState<string | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const hold = useRef<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const id = useId();
  useEffect(() => {
    refs.current[Math.min(focus, swatches.length - 1)]?.focus();
    // Палитра должна поместиться в окно: у правого края сдвигается влево, но не дальше левого края окна.
    const r = root.current?.getBoundingClientRect();
    if (r) {
      let dx = 0;
      if (r.right > window.innerWidth - 8) dx = window.innerWidth - 8 - r.right;
      if (r.left + dx < 8) dx = 8 - r.left;
      setShift(dx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const customHex = strictHex(custom.startsWith('#') ? custom : `#${custom}`);
  const focused = swatches[focus]?.hex ?? null;
  const warning = contrastWarning(p.kind, focused, p.textColor) ?? contrastWarning(p.kind, customHex, p.textColor);

  const addFav = (hex: string) => {
    const err = fav.add(hex);
    setError(err);
    if (err) p.onWarning(err);
  };
  const move = (i: number) => {
    const n = Math.max(0, Math.min(swatches.length - 1, i));
    setFocus(n);
    refs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const s = swatches[i];
    if (e.key === 'ArrowRight') move(i + 1);
    else if (e.key === 'ArrowLeft') move(i - 1);
    else if (e.key === 'ArrowDown') move(i + COLS);
    else if (e.key === 'ArrowUp') move(i - COLS);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(swatches.length - 1);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && s?.favorite) {
      fav.remove(s.hex);
      setError(null);
    } else if (e.key === 'Escape') p.onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const startHold = (hex: string) => {
    hold.current = window.setTimeout(() => {
      hold.current = null;
      fav.remove(hex);
    }, 600);
  };
  const stopHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };

  const render = (s: Swatch, i: number) => (
    <span key={`${s.section}-${s.hex}`} className="aw-sw-wrap">
      <button type="button" ref={(el) => { refs.current[i] = el; }} className={`aw-sw${s.hex === p.current ? ' on' : ''}`} style={{ background: s.hex }}
        aria-label={swatchLabel(s.hex, s.name, s.favorite)} title={swatchLabel(s.hex, s.name, s.favorite)} tabIndex={i === focus ? 0 : -1}
        data-hex={s.hex} data-section={s.section}
        onFocus={() => setFocus(i)} onKeyDown={(e) => onKey(e, i)} onClick={() => p.onPick(s.hex)}
        onPointerDown={(e) => { if (s.section === 'fav' && e.pointerType === 'touch') startHold(s.hex); }} onPointerUp={stopHold} onPointerLeave={stopHold} />
      {s.section === 'fav'
        ? <button type="button" className="aw-sw-x" tabIndex={-1} aria-label={`Убрать из избранного ${s.hex}`} title="Убрать из избранного" onClick={() => fav.remove(s.hex)}>×</button>
        : !s.favorite && <button type="button" className="aw-sw-star" tabIndex={-1} aria-label={`В избранное ${s.hex}`} title="В избранное" onClick={() => addFav(s.hex)}>☆</button>}
    </span>
  );

  return (
    <div ref={root} className="aw-palette" style={shift ? { left: shift } : undefined} role="dialog" aria-label={`${p.label}: палитра`} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); p.onClose(); } }}>
      <div className="aw-pal-sec" role="group" aria-labelledby={`${id}-fav`}>
        <div className="aw-pal-h" id={`${id}-fav`}>{FAV_TITLE[p.kind]}</div>
        {fav.list.length
          ? <div className="aw-sw-grid" data-testid="palette-favorites">{swatches.filter((s) => s.section === 'fav').map((s) => render(s, swatches.indexOf(s)))}</div>
          : <div className="hint">Пусто. Звёздочка у цвета — добавить.</div>}
      </div>
      <div className="aw-pal-sec" role="group" aria-labelledby={`${id}-std`}>
        <div className="aw-pal-h" id={`${id}-std`}>Стандартные</div>
        <div className="aw-sw-grid" data-testid="palette-standard">{swatches.filter((s) => s.section === 'std').map((s) => render(s, swatches.indexOf(s)))}</div>
      </div>
      <form className="aw-pal-sec aw-pal-custom" onSubmit={(e) => { e.preventDefault(); if (customHex) p.onPick(customHex); }}>
        <label className="aw-pal-h" htmlFor={`${id}-hex`}>Свой цвет</label>
        <span className="aw-sw aw-sw-preview" style={{ background: customHex ?? 'transparent' }} aria-hidden="true" />
        <input id={`${id}-hex`} className="inp sm" value={custom} maxLength={7} placeholder="#RRGGBB" aria-invalid={!customHex} aria-label="Свой цвет, #RRGGBB"
          onChange={(e) => setCustom(e.target.value.trim())} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); p.onClose(); } }} />
        <button type="button" className="aw-tb" disabled={!customHex} aria-label="Свой цвет — в избранное" title="В избранное" onClick={() => customHex && addFav(customHex)}>☆</button>
        <button type="submit" className="btn sm" disabled={!customHex}>Применить</button>
      </form>
      {warning && <p className="aw-pal-warn" role="status">{warning}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="button" className="btn sm aw-pal-none" onClick={() => p.onPick(null)}>{NONE_LABEL[p.kind]}</button>
    </div>
  );
}
