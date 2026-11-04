import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Ряд фильтров-чипов (1.6.5): в одну строку с горизонтальной прокруткой; край, за которым есть ещё чипы, затухает.
 * Текст чипа не обрезается никогда. Колёсико мыши прокручивает ряд по горизонтали.
 */
export function ChipScroller({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setEdges({ start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 });
    };
    // Вертикальное колёсико над рядом — горизонтальная прокрутка, пока есть куда.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0 || (e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    // Чипы и счётчики в них меняются — пересчитать края.
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      el.removeEventListener('scroll', update);
      el.removeEventListener('wheel', onWheel);
      ro?.disconnect();
    };
  }, []);
  // Выбранный чип всегда виден: после перехода по ссылке с фильтром ряд докручивается к нему.
  const pressed = useRef<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    const on = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !on || pressed.current === on.textContent) return;
    pressed.current = on.textContent;
    const left = on.offsetLeft; // .chip-scroll — position: relative, отсчёт от начала ряда
    if (left < el.scrollLeft) el.scrollLeft = left - 24;
    else if (left + on.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = left + on.offsetWidth - el.clientWidth + 24;
  });
  return (
    <div ref={ref} className={`filters chip-scroll${edges.start ? ' fade-start' : ''}${edges.end ? ' fade-end' : ''}${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
      {children}
    </div>
  );
}
