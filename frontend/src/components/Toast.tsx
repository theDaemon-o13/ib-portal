import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** warn — действие выполнено, но есть на что обратить внимание (запись не создана, правило без участников). */
type Kind = 'ok' | 'error' | 'warn';
interface ToastState {
  text: string;
  kind: Kind;
  id: number;
}

const ToastContext = createContext<(text: string, kind?: Kind) => void>(() => undefined);

/** Уведомление внизу экрана: подтверждает результат действия или сообщает об ошибке. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string, kind: Kind = 'ok') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ text, kind, id: Date.now() });
    timer.current = setTimeout(() => setToast(null), kind === 'ok' ? 3200 : kind === 'warn' ? 9000 : 6000);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className={`toast${toast ? ' on' : ''}${toast?.kind === 'error' ? ' err' : ''}${toast?.kind === 'warn' ? ' warn' : ''}`} role="status" aria-live="polite">
        {toast?.text}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
