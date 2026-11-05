// Окно с формой поверх карточки (как ConfirmDialog настроек): заголовок, поля, «Отмена» и кнопка действия.
// Esc закрывает только окно: панель под ним остаётся (DetailPanel проверяет defaultPrevented).
import { useEffect, type FormEvent, type ReactNode } from 'react';
import { Overlay } from '../../components/Overlay';

export function FormDialog(p: {
  title: string;
  submit: string;
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
  error?: string | null;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || p.busy) return;
      e.preventDefault();
      p.onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [p]);
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!p.busy && !p.disabled) p.onSubmit();
  };
  return (
    <Overlay>
      <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && !p.busy && p.onClose()}>
        <form className="modal panel aw-dialog" role="dialog" aria-modal="true" aria-label={p.title} onSubmit={send} data-testid={p.testId}>
          <h2>{p.title}</h2>
          <div className="aw-dialog-b">{p.children}</div>
          {p.error && <div className="form-error" role="alert">{p.error}</div>}
          <div className="row end">
            <button className="btn" type="button" onClick={p.onClose} disabled={p.busy}>Отмена</button>
            <button className={`btn ${p.danger ? 'danger' : 'primary'}`} type="submit" disabled={p.busy || p.disabled}>{p.submit}</button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
