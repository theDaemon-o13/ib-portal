import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Панели и окна выводятся прямо в <body>. Внутри стеклянной .panel (backdrop-filter)
 * position: fixed отсчитывается от панели, а не от окна: панель открывалась посередине страницы.
 */
export function Overlay({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
