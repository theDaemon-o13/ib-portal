import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

/**
 * Многострочное поле: от rows строк (по умолчанию 6), растёт вместе с текстом до 70% высоты окна,
 * дальше — прокрутка. Растянуть вручную тоже можно; при вводе поле только растёт, не сжимается.
 */
export function AutoTextarea({ rows = 6, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight + 2}px`;
  }, [props.value]);
  return <textarea {...props} ref={ref} rows={rows} className={`${props.className ?? 'inp'} auto-grow`} />;
}
